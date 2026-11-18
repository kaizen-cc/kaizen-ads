import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import type { Staff } from "@/lib/auth";
import { agentTools } from "@/lib/agent-call/agent-tools";
import { showCard } from "@/lib/agent-call/call-cards";
import { withFrame } from "@/lib/agent-call/call-extras";
import { firstNameOf, pendingItems, type CallEvent } from "@/lib/agent-call/core";
import { keptLine, talkModeOf } from "@/lib/agent-call/modality";
import { callContext, playbookFor, readMoment, streamAnswer, turnExtras, voiceSystem, type Answer, type CallRow, type TurnInput } from "@/lib/agent-call/server";
import { callTimer } from "@/lib/agent-call/timing";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { turnTimes } from "@/lib/agent-call/transcript";
import { saidYes, specialistOf } from "./core";
import {
  JOB_KINDS,
  MAX_HOPS,
  SPECIALIST_KEYS,
  agentsToBring,
  asksToBringIn,
  isExpertQuestion,
  canHandOff,
  cleanJob,
  joinLine,
  jobForPrompt,
  jobView,
  labelOf,
  launchFacts,
  launchTicket,
  lineOf,
  newJob,
  playbookOf,
  updateJob,
  whatsMissing,
  type Artifact,
  type Gap,
  type Handoff,
  type Job,
  type JobKind,
  type JobPatch,
  type LaunchTicket,
} from "./team";

// Several agents on one call, on the server. Who's on the line and the job they're working on are kept on the call's
// row (guest_roles, job), so every turn and every agent reads the same state. Each agent answers with its own
// playbook, tools and voice; the team tools let any of them start and check the job (what's missing, from the data),
// record what they made, bring someone in (after the person's yes), hand work to another agent on the line, and step
// out. Hand-offs run straight after the turn, a couple at most, then the person has the floor. Nothing that goes live,
// sends or spends runs on another agent's words: only on the person's own yes, on their own turn.

export type TeamState = {
  /** Who runs the call: the assistant, or the agent called directly */
  host: string;
  line: string[];
  job: Job | null;
  /** What's missing, as last checked this turn */
  gaps: Gap[] | null;
  /** Specialists brought in on this turn, with what they were brought in for */
  joined: { role: string; question: string }[];
  handoff: Handoff | null;
  /** This turn's hand-offs so far ("from>to") */
  chain: string[];
};

export type TeamCtx = { me: Staff; db: SupabaseClient; admin: SupabaseClient; callId: string; emit: (e: CallEvent) => void; team: TeamState; self: string; said: string };

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const NO_YES = "Not run: say in one sentence exactly what this will do and ask; run it again with confirmed: true only once they clearly say yes.";
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to this exact action on this turn" };
/** A gated action: the model said confirmed AND the person's own words this turn are a yes (never on another agent's words) */
const yes = (ctx: TeamCtx, input: Record<string, unknown>) => input.confirmed === true && Boolean(ctx.said) && saidYes(ctx.said);

/**
 * Bringing a specialist in needs no separate yes when the person's own words this turn asked for it ("call in the
 * Google buyer") or asked the kind of strategy question that specialist answers: asking was the yes. (It used to
 * need a spoken "yes" too, so an explicit ask got "Shall I?" back and took two or three tries.)
 */
const bringOk = (ctx: TeamCtx, key: string, input: Record<string, unknown>) => yes(ctx, input) || (Boolean(ctx.said) && (asksToBringIn(ctx.said) === key || isExpertQuestion(ctx.said)));

/** Puts a specialist on the line (the person may talk to it, it's online, there's room): saved and shown */
export async function joinSpecialist(ctx: Pick<TeamCtx, "me" | "admin" | "callId" | "emit" | "team">, key: string): Promise<{ joined: true; label: string } | { joined: false; note: string; on?: boolean }> {
  const sp = specialistOf(key);
  if (!sp) return { joined: false, note: "Not one of the specialists." };
  if (!canTalkToAgent(ctx.me, sp.key)) return { joined: false, note: `The ${sp.label} isn't one they can talk to.` };
  const { data: role } = await ctx.admin.from("ai_roles").select("key, label, icon, offline").eq("key", sp.key).maybeSingle();
  if (!role || (role as { offline?: boolean }).offline) return { joined: false, note: `The ${sp.label} isn't online yet. Offer to help yourself.` };
  const next = joinLine(ctx.team.line, sp.key, ctx.team.host);
  if (next.full) return { joined: false, note: "Three specialists are on already: let one go first (dismiss_specialist)." };
  if (!next.joined) return { joined: false, on: true, note: `The ${sp.label} is already on the call: talk to it, or hand_off to it.` };
  ctx.team.line = next.line;
  await Promise.all([saveLine(ctx.admin, ctx.callId, ctx.team.line), emitLine(ctx.admin, ctx.team.line, ctx.emit)]);
  return { joined: true, label: String(role.label ?? sp.label) };
}

/** The team on a call, from its row */
export function teamOf(call: CallRow, host: string): TeamState {
  return { host, line: lineOf(call, host), job: cleanJob(call.job), gaps: null, joined: [], handoff: null, chain: [] };
}

/** Who spoke last on the call (the agent the conversation is with) */
export async function lastSpeaker(admin: SupabaseClient, callId: string): Promise<string | null> {
  const { data } = await admin.from("ai_role_chats").select("role_key").eq("call_id", callId).eq("role", "agent").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.role_key as string | undefined) ?? null;
}

/** Saves who's on the line (the list, and the first one where only one could be kept before the team migration) */
export async function saveLine(admin: SupabaseClient, callId: string, line: readonly string[]) {
  const { error } = await admin.from("ai_role_calls").update({ guest_roles: line, guest_role: line[0] ?? null }).eq("id", callId);
  if (error) await admin.from("ai_role_calls").update({ guest_role: line[0] ?? null }).eq("id", callId);
}

async function saveJob(admin: SupabaseClient, callId: string, job: Job | null) {
  const { error } = await admin.from("ai_role_calls").update({ job }).eq("id", callId);
  if (error) console.error("[call team] job", error.message);
}

/** The line as the call screen shows it: each agent's label and icon */
export async function emitLine(admin: SupabaseClient, line: readonly string[], emit: (e: CallEvent) => void) {
  const { data } = line.length ? await admin.from("ai_roles").select("key, label, icon").in("key", line as string[]) : { data: [] };
  const rows = (data ?? []) as { key: string; label: string; icon: string | null }[];
  emit({ t: "team", line: line.map((k) => ({ role: k, label: rows.find((r) => r.key === k)?.label ?? labelOf(k), icon: rows.find((r) => r.key === k)?.icon ?? "spark" })) });
}

const emitJob = (ctx: Pick<TeamCtx, "emit" | "team">) => ctx.emit({ t: "job", job: jobView(ctx.team.job, ctx.team.gaps) });

/** The client named, if this person may see it (their own session decides) */
async function clientNamed(db: SupabaseClient, name: unknown): Promise<{ id: string; name: string; slug: string }> {
  const asked = clip(name, 120);
  if (!asked) throw new Error("Which client?");
  const safe = asked.replace(/[%_,()]/g, " ").trim();
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).ilike("name", `%${safe}%`).limit(5);
  const hit = (data ?? []).find((c) => String(c.name).toLowerCase() === asked.toLowerCase()) ?? (data ?? [])[0];
  if (!hit) throw new Error(`No client called "${asked}" that you can see.`);
  return hit as { id: string; name: string; slug: string };
}

// ─── What's missing: the checks ─────────────────────────────────────────────

const NEAR_LAUNCH = ["internal_review", "copy", "copy_review", "ready_for_client", "client_review", "client_revision", "ready_for_launch"];

/** The launch's checks for a client: its tickets near launch (copy, designs, launch), the call's uploads, a sheet's run */
async function launchFound(ctx: TeamCtx, job: Job) {
  const clientId = job.client!.id;
  const { data: reqs } = await ctx.db.from("requests").select("id, number, title, stage").eq("client_id", clientId).is("deleted_at", null).in("stage", NEAR_LAUNCH).order("updated_at", { ascending: false }).limit(8);
  const rows = (reqs ?? []) as { id: string; number: number; title: string; stage: string }[];
  const ids = rows.map((r) => r.id);
  const runId = [...job.artifacts].reverse().find((a) => a.kind === "launch_run")?.id ?? null;
  const [{ data: copies }, { data: designs }, { data: launches }, { data: call }, { data: run }] = await Promise.all([
    ids.length ? ctx.db.from("copy_sets").select("request_id, status").in("request_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? ctx.db.from("designs").select("request_id, client_status").in("request_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? ctx.db.from("launches").select("id, request_id, status, plan").in("request_id", ids).neq("status", "discarded").order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ctx.admin.from("ai_role_calls").select("uploads").eq("id", ctx.callId).maybeSingle(),
    runId
      ? ctx.db.from("launch_runs").select("id, status").eq("id", runId).maybeSingle()
      : ctx.db.from("launch_runs").select("id, status").eq("client_id", clientId).eq("created_by", ctx.me.id).gte("updated_at", new Date(Date.now() - 86_400_000).toISOString()).neq("status", "discarded").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const ds = (designs ?? []) as { request_id: string; client_status: string | null }[];
  const ls = (launches ?? []) as { id: string; request_id: string; status: string; plan: { adsetId?: string; mode?: string; newAdsetName?: string | null; options?: { adsets?: { id: string; name: string }[] } } | null }[];
  const tickets: (LaunchTicket & { launchId: string | null })[] = rows.map((r) => {
    const l = ls.find((x) => x.request_id === r.id) ?? null;
    const adset = l?.plan?.adsetId ? (l.plan.mode === "clone" ? (l.plan.newAdsetName ?? "a new ad set") : (l.plan.options?.adsets?.find((a) => a.id === l.plan?.adsetId)?.name ?? l.plan.adsetId)) : null;
    return {
      number: r.number,
      title: r.title,
      stage: r.stage,
      copy: (((copies ?? []) as { request_id: string; status: LaunchTicket["copy"] }[]).find((c) => c.request_id === r.id)?.status ?? null) as LaunchTicket["copy"],
      designs: ds.filter((d) => d.request_id === r.id).length,
      approvedDesigns: ds.filter((d) => d.request_id === r.id && d.client_status === "approved").length,
      launch: l ? { status: l.status, adset } : null,
      launchId: l?.id ?? null,
    };
  });
  const uploads = ((call?.uploads ?? []) as { purpose?: string; kind?: string }[]).filter((u) => u.purpose === "creatives" && (u.kind === "image" || u.kind === "video"));
  const found = { tickets, uploadedCreatives: uploads.length, sheet: run ? { status: run.status as string } : null, copyOnCall: job.artifacts.some((a) => a.kind === "copy") };
  const t = launchTicket(found) as (LaunchTicket & { launchId: string | null }) | null;
  return {
    facts: launchFacts(found),
    seen: {
      ticket: t ? { number: t.number, title: t.title, stage: t.stage.replace(/_/g, " "), copy: t.copy ?? "none yet", designs: t.designs, approved_designs: t.approvedDesigns, launch: t.launch ? { id: t.launchId, status: t.launch.status, ad_set: t.launch.adset } : null } : null,
      other_tickets: tickets.filter((x) => x !== t).map((x) => `#${x.number} ${x.title} (${x.stage.replace(/_/g, " ")})`),
      creatives_uploaded_on_call: uploads.length,
      launch_sheet: run ? { id: run.id, status: run.status } : null,
    },
  };
}

/** What the data says about each step of the job (step key: done), and what the checks saw, for the agent */
async function readFacts(ctx: TeamCtx, job: Job): Promise<{ facts: Record<string, boolean>; seen: Record<string, unknown> }> {
  const has = (k: Artifact["kind"]) => job.artifacts.some((a) => a.kind === k);
  if (!job.client) return { facts: {}, seen: { note: "No client yet: ask which client." } };
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  switch (job.kind) {
    case "launch_ads":
      return launchFound(ctx, job);
    case "email_request": {
      const { data } = await ctx.db.from("email_tickets").select("number, title, stage").eq("client_id", job.client.id).is("deleted_at", null).gte("created_at", since(14)).order("created_at", { ascending: false }).limit(5);
      return { facts: { copy: has("copy_doc"), request: has("asana_request") || has("email_ticket") }, seen: { recent_email_tickets: ((data ?? []) as { number: number; title: string; stage: string }[]).map((t) => `#${t.number} ${t.title} (${String(t.stage).replace(/_/g, " ")})`) } };
    }
    case "creative_brief": {
      const { data } = await ctx.db.from("requests").select("number, title, stage").eq("client_id", job.client.id).is("deleted_at", null).gte("created_at", since(14)).order("created_at", { ascending: false }).limit(5);
      return { facts: { brief: has("brief") }, seen: { recent_tickets: ((data ?? []) as { number: number; title: string; stage: string }[]).map((t) => `#${t.number} ${t.title} (${String(t.stage).replace(/_/g, " ")})`) } };
    }
    case "audit_sprint": {
      const { data: targets } = await ctx.db.from("kpi_targets").select("id").eq("client_id", job.client.id).eq("platform", job.platform === "google" ? "google" : "meta").eq("active", true).limit(5);
      const ids = ((targets ?? []) as { id: string }[]).map((t) => t.id);
      const { data: audit } = ids.length ? await ctx.db.from("account_audits").select("id, created_at, status").in("target_id", ids).order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
      const recent = Boolean(audit && Date.parse(audit.created_at as string) > Date.now() - 7 * 86_400_000);
      return { facts: { audit: recent || has("audit"), plan: has("plan") }, seen: { latest_audit: audit ? { id: audit.id, on: String(audit.created_at).slice(0, 10), status: audit.status } : null, ad_accounts: ids.length } };
    }
    case "report": {
      const { data } = await ctx.db.from("reports").select("id, status, created_at").eq("client_id", job.client.id).gte("created_at", since(1)).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return { facts: { report: has("report") || Boolean(data) }, seen: { report_today: data ? { id: data.id, status: data.status } : null } };
    }
  }
}

/** The job checked against the data: what's missing, who does it, who to bring in; saved and shown */
async function checkJob(ctx: TeamCtx) {
  const job = ctx.team.job;
  if (!job) return { job: null, note: "No job on this call yet. start_job first." };
  const { facts, seen } = await readFacts(ctx, job).catch((e) => ({ facts: {} as Record<string, boolean>, seen: { error: e instanceof Error ? e.message : "The checks couldn't run." } }));
  const gaps = whatsMissing(job, facts, ctx.team.host);
  ctx.team.gaps = gaps;
  ctx.team.job = { ...job, left: gaps.map((g) => g.label) };
  await saveJob(ctx.admin, ctx.callId, ctx.team.job);
  emitJob(ctx);
  const book = playbookOf(job.kind);
  return {
    job: `${book?.label ?? job.kind}${job.client ? ` for ${job.client.name}` : ""}`,
    done: (book?.steps ?? []).filter((s) => facts[s.key] || job.done.includes(s.key)).map((s) => s.label),
    missing: gaps.map((g) => ({ step: g.key, what: g.label, who: labelOf(g.agent), on_the_call: g.agent === ctx.team.host || ctx.team.line.includes(g.agent), optional: g.optional || undefined, offer: g.ask, how: g.how })),
    next: gaps.find((g) => !g.optional) ? `${gaps.find((g) => !g.optional)!.label}: ${labelOf(gaps.find((g) => !g.optional)!.agent)}` : "Nothing left: finish_job and sum up.",
    bring_in: agentsToBring(gaps, ctx.team.host, ctx.team.line).map(labelOf),
    found: seen,
  };
}

/** Records an update on the job (by the agent speaking) and saves it */
async function patchJob(ctx: TeamCtx, patch: JobPatch) {
  if (!ctx.team.job) return;
  ctx.team.job = updateJob(ctx.team.job, ctx.self, patch);
  await saveJob(ctx.admin, ctx.callId, ctx.team.job);
  emitJob(ctx);
}

// ─── The tickets' copy and launch ───────────────────────────────────────────

async function ticketNamed(ctx: TeamCtx, n: unknown): Promise<{ id: string; number: number; title: string; stage: string; client_id: string }> {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) throw new Error("Which ticket number?");
  const { data } = await ctx.db.from("requests").select("id, number, title, stage, client_id").eq("number", num).is("deleted_at", null).maybeSingle();
  if (!data) throw new Error(`No ticket #${num} you can see.`);
  return data as { id: string; number: number; title: string; stage: string; client_id: string };
}

/** The launch tools the buyer and the copywriter use on a call (each action checks who may, as on the board) */
function launchTools(ctx: TeamCtx): LoopTool[] {
  return [
    {
      name: "ticket_copy",
      description:
        "A creative ticket's ad copy (the copy studio on the board). status: where the copy is (none, drafting, in review, approved) and the first lines. draft: the Copywriter agent writes or rewrites it in the background from the brief, the creative and the client's voice (about a minute; uses AI credits: ask first, confirmed after a yes). approve: approves the copy as it stands, through copy review's own checks (what the client told us to avoid blocks it; only after a spoken yes). Nothing goes to the client from here.",
      input_schema: { type: "object", properties: { number: { type: "integer", description: "The ticket's number" }, action: { type: "string", enum: ["status", "draft", "approve"] }, note: { type: "string", description: "draft: what to change or aim for" }, confirmed: CONFIRMED }, required: ["number", "action"], additionalProperties: false },
      status: (input) => (input.action === "draft" ? "Getting the copy written…" : input.action === "approve" ? "Approving the copy…" : "Reading the copy…"),
      run: async (input) => {
        const t = await ticketNamed(ctx, input.number);
        const { ticketCopy, redraftCopy, approveCopy } = await import("@/app/(team)/board/copy-actions");
        if (input.action === "draft") {
          if (!yes(ctx, input)) return { done: false, note: NO_YES };
          const r = await redraftCopy(t.id, clip(input.note, 600) || undefined);
          if (!r.ok) return { done: false, error: r.error };
          await patchJob(ctx, { artifact: { kind: "copy", id: `ticket-${t.number}`, label: `Copy for #${t.number}`, href: `/board?t=${t.number}` } });
          showCard(ctx, { title: `Copy for #${t.number}`, detail: "Being written now, about a minute", href: `/board?t=${t.number}`, external: false, cta: "Review the copy" });
          return { drafting: true, note: "Say it's being written (about a minute) and that the card is on screen. Check back with status before you approve." };
        }
        const state = await ticketCopy(t.id);
        const set = state.set;
        if (input.action === "approve") {
          if (!set) return { done: false, note: "There's no copy on this ticket yet: draft it first." };
          if (set.status === "approved") return { approved: true, already: true };
          if (set.status === "drafting") return { done: false, note: "It's still being written. Check again in a moment." };
          if (!yes(ctx, input)) return { done: false, note: NO_YES };
          const r = await approveCopy(set.id, set.ads);
          if (!r.ok) return { done: false, error: r.error, against_client_rules: (r as { violations?: { rule: string; quote: string }[] }).violations?.map((v) => `"${v.quote}" goes against ${v.rule}`) };
          await patchJob(ctx, { done: ["copy"], artifact: { kind: "copy", id: set.id, label: `Approved copy for #${t.number}`, href: `/board?t=${t.number}` }, note: `Approved the copy for #${t.number}` });
          return { approved: true, ads: set.ads.length };
        }
        if (!set) return { ticket: `#${t.number} ${t.title}`, stage: t.stage.replace(/_/g, " "), copy: "none yet", reusable: state.reusable ? `An approved set for the same angle on "${state.reusable.title}"` : undefined };
        return {
          ticket: `#${t.number} ${t.title}`,
          stage: t.stage.replace(/_/g, " "),
          copy: set.status,
          progress: set.status === "drafting" ? set.progress.label : undefined,
          ads: set.ads.slice(0, 4).map((a) => ({ hook: clip((a as { hook?: string }).hook, 140) || undefined, primary_text: clip(a.primaryText, 220), headline: clip(a.headline, 60), description: clip(a.linkDescription, 60) })),
          approved_by: set.approvedBy ?? undefined,
        };
      },
    },
    {
      name: "ticket_launch",
      description:
        "Launches a ticket in Ready to launch through the launcher (its checks always apply: who may launch, the account, Kaizen's checks and Meta's dry run). status: where its launch is (the ad set picked and why, the checks, the settings Meta locks with their fingerprint, whether it waits on a sign-off). start: plans the launch now (the Media Buyer reads the account and picks the ad set and names); when every check passes and the settings are signed off, the ads are created PAUSED in Meta for them to turn on. That writes to their ad account: say exactly that and ask; only after a spoken yes, confirmed: true. confirm: signs off the locked settings and creates the ads paused, for a launch whose checks passed and waits on a sign-off: read the locked settings out in a sentence first, ask, and only on a spoken yes run it with the fingerprint from status.",
      input_schema: { type: "object", properties: { number: { type: "integer", description: "The ticket's number" }, action: { type: "string", enum: ["status", "start", "confirm"] }, fingerprint: { type: "string", description: "confirm: the locked settings' fingerprint from status" }, confirmed: CONFIRMED }, required: ["number", "action"], additionalProperties: false },
      status: (input) => (input.action === "start" ? "Starting the launch…" : input.action === "confirm" ? "Creating the ads…" : "Checking the launch…"),
      run: async (input) => {
        const t = await ticketNamed(ctx, input.number);
        const { launchFor, startLaunch, confirmLaunch } = await import("@/app/(team)/board/launch-actions");
        if (input.action === "start") {
          if (!yes(ctx, input)) return { done: false, note: NO_YES };
          const r = await startLaunch(t.id);
          if (!r.ok) return { done: false, error: r.error };
          await patchJob(ctx, { artifact: { kind: "launch", id: r.id, label: `Launch of #${t.number}`, href: `/board?t=${t.number}` }, note: `Started the launcher on #${t.number}` });
          showCard(ctx, { title: `Launch of #${t.number}`, detail: "Planning now: the ad set, the names and the checks", href: `/board?t=${t.number}`, external: false, cta: "Open the launch" });
          return { started: true, launchId: r.id, note: "Say it's planning (about a minute): it picks the ad set and runs the checks. Check its status before you say what it picked." };
        }
        const v = await launchFor(t.id);
        if (!v) return { ticket: `#${t.number} ${t.title}`, stage: t.stage.replace(/_/g, " "), launch: "not started", can_start: t.stage === "ready_for_launch" };
        if (input.action === "confirm") {
          if (!yes(ctx, input)) return { done: false, note: NO_YES };
          const r = await confirmLaunch(v.id, clip(input.fingerprint, 200) || undefined);
          if (!r.ok) return { done: false, error: r.error };
          await patchJob(ctx, { done: ["adset", "checks", "live"], note: `Created ${r.launched} of ${r.total} ads paused${r.sandbox ? " in the sandbox (a test)" : ""} from #${t.number}` });
          if (r.link) showCard(ctx, { title: `${r.launched} ads created, paused`, detail: r.sandbox ? "In the sandbox (a test)" : "Check them in Ads Manager and turn them on", href: r.link, external: true, cta: "Open Ads Manager" });
          return { created: r.launched, total: r.total, paused: true, sandbox: r.sandbox, note: "Say they're created paused, ready to check and turn on in Ads Manager." };
        }
        const plan = v.plan;
        const adset = plan ? (plan.mode === "clone" ? `a new ad set "${plan.newAdsetName ?? ""}" copied from ${plan.options.adsets.find((a) => a.id === plan.adsetId)?.name ?? "one"}` : (plan.options.adsets.find((a) => a.id === plan.adsetId)?.name ?? plan.adsetId)) : null;
        const k = plan?.locked;
        return {
          ticket: `#${t.number} ${t.title}`,
          status: v.status,
          progress: v.progress ?? undefined,
          ad_set: adset ?? undefined,
          why: plan?.reason ? clip(plan.reason, 400) : undefined,
          ads: plan?.ads.map((a) => a.name).slice(0, 8),
          blocks: v.checks.filter((c) => c.level === "block").map((c) => `${c.label}: ${c.detail}`),
          warnings: v.checks.filter((c) => c.level === "warn").map((c) => `${c.label}: ${c.detail}`),
          locked: k ? { campaign: k.campaign, objective: k.objective, ad_set: k.adset, pixel: k.pixel, event: k.event, attribution: k.attribution, budget: k.budget, fingerprint: k.fingerprint } : undefined,
          waits_on_sign_off: v.status === "ready" && !v.signed,
          created: v.result ? v.result.ads.filter((a) => a.adId).map((a) => a.name) : undefined,
          sandbox: v.sandbox || undefined,
          you_can_launch: v.canLaunch,
          error: v.error ?? undefined,
        };
      },
    },
  ];
}

// ─── The team tools ─────────────────────────────────────────────────────────

/** What each tool, once it worked, adds to the job (an artifact, a step done) */
function trackOf(name: string, input: Record<string, unknown>, out: Record<string, unknown>): JobPatch | null {
  const ok = (k: string) => out && typeof out === "object" && out[k] !== undefined && out[k] !== false;
  switch (name) {
    case "write_ad_copy":
      return ok("shown") ? { artifact: { kind: "copy", id: `card-${Date.now().toString(36)}`, label: `Ad copy (${input.platform === "google" ? "Google" : "Meta"})${ok("all_within_limits") ? "" : ", with fixes to make"}`, href: null } } : null;
    case "create_brief":
      return ok("shown") ? { done: ["brief"], artifact: { kind: "brief", id: `brief-${Date.now().toString(36)}`, label: `Brief: ${clip(input.title, 80)}`, href: null } } : null;
    case "create_copy_doc":
      return ok("made") ? { artifact: { kind: "copy_doc", id: String(out.copy_doc_id), label: `Copy: ${clip(input.title, 80)}`, href: `/copy/${out.copy_doc_id}` } } : null;
    case "create_email_request":
      return ok("created") ? { done: ["copy", "request"], artifact: { kind: "asana_request", id: String((out.tasks as { gid: string }[] | undefined)?.[0]?.gid ?? Date.now().toString(36)), label: "Requested in Asana", href: null } } : null;
    case "launch_sheet":
      return ok("started") ? { artifact: { kind: "launch_run", id: String(out.launchId), label: "Launch from the sheet", href: null } } : null;
    case "confirm_launch":
      return ok("launched") ? { done: ["live"] } : null;
    case "create_report":
      return ok("started") ? { done: ["report"], artifact: { kind: "report", id: String(out.reportId), label: "Report", href: `/reports/${out.reportId}` } } : null;
    case "run_audit":
      return ok("started") ? { done: ["audit"], artifact: { kind: "audit", id: `audit-${Date.now().toString(36)}`, label: `${clip(input.kind, 10)} audit`, href: null } } : null;
    case "plan_ad_changes":
      return ok("planned") ? { done: ["plan"], artifact: { kind: "plan", id: `plan-${Date.now().toString(36)}`, label: "Change plan", href: null } } : null;
    default:
      return null;
  }
}

/** The agent's tools with the job kept up to date as they make things */
export function tracked(ctx: TeamCtx, tools: readonly LoopTool[]): LoopTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (input: Record<string, unknown>) => {
      const out = await t.run(input);
      if (ctx.team.job?.status === "open") {
        const patch = trackOf(t.name, input, out as Record<string, unknown>);
        if (patch) await patchJob(ctx, patch).catch(() => undefined);
      }
      return out;
    },
  }));
}

/** The tools every agent on a call gets for working as a team */
export function teamTools(ctx: TeamCtx): LoopTool[] {
  const hosting = ctx.self === ctx.team.host;
  const tools: LoopTool[] = [
    {
      name: "start_job",
      description: `Starts the job the person asked for on this call, so everyone on the line works from the same state: ${JOB_KINDS.join(", ")}. It checks the data right away and returns what's done, what's missing in order, who does each part and who to bring in. Call it as soon as you recognise the job (the client and platform from what they said).`,
      input_schema: { type: "object", properties: { kind: { type: "string", enum: [...JOB_KINDS] }, client: { type: "string", description: "The client's name" }, platform: { type: "string", enum: ["meta", "google"] }, goal: { type: "string", description: "What they want, in their words, one sentence" } }, required: ["kind", "client", "goal"], additionalProperties: false },
      status: () => "Checking what's ready…",
      run: async (input) => {
        let client: { id: string; name: string } | null = null;
        try {
          const c = await clientNamed(ctx.db, input.client);
          client = { id: c.id, name: c.name };
        } catch (e) {
          return { started: false, note: `${e instanceof Error ? e.message : "No such client."} Ask which client they meant.` };
        }
        const kind = JOB_KINDS.find((k) => k === input.kind) as JobKind | undefined;
        if (!kind) return { started: false, note: "Not one of the jobs." };
        ctx.team.job = newJob({ kind, goal: clip(input.goal, 300), client, platform: input.platform === "google" ? "google" : input.platform === "meta" ? "meta" : kind === "launch_ads" || kind === "audit_sprint" ? "meta" : null });
        return { started: true, ...(await checkJob(ctx)) };
      },
    },
    {
      name: "check_job",
      description: "Checks the job again against the data (after copy is approved, a launch planned, a ticket made): what's done, what's missing, who's next.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      status: () => "Checking where we are…",
      run: async () => checkJob(ctx),
    },
    {
      name: "update_job",
      description: "Records your part on the job so every agent sees it: steps you finished (done), something you made with its id (artifact), a decision in one line (note). Don't repeat what the tools record by themselves (briefs, copy cards, tickets, reports, launches).",
      input_schema: {
        type: "object",
        properties: {
          done: { type: "array", items: { type: "string" }, description: "Step keys from the job" },
          artifact: { type: "object", properties: { kind: { type: "string", enum: ["copy", "brief", "ticket", "email_ticket", "launch", "launch_run", "report", "audit", "plan", "files", "other"] }, id: { type: "string" }, label: { type: "string" }, href: { type: "string" } }, required: ["kind", "id", "label"], additionalProperties: false },
          note: { type: "string", description: "A decision or what you found, one line" },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        if (!ctx.team.job) return { note: "No job on this call yet." };
        const a = input.artifact as { kind: Artifact["kind"]; id: string; label: string; href?: string } | undefined;
        await patchJob(ctx, { done: Array.isArray(input.done) ? input.done.map(String) : [], artifact: a ? { kind: a.kind, id: a.id, label: a.label, href: a.href ?? null } : null, note: clip(input.note, 300) || null });
        return { saved: true };
      },
    },
    {
      name: "hand_off",
      description: `Hands your part to another agent on this call, or asks it a question: say one short line out loud first ("Here's the approved copy for the Media Buyer."), call this, and stop; it answers next with what you passed it. Only to someone on the call. At most ${MAX_HOPS} hand-offs before the person has the floor again; never hand something live, sent or paid for: that waits for the person's yes.`,
      input_schema: { type: "object", properties: { to: { type: "string", enum: [...SPECIALIST_KEYS, "assistant"], description: "The agent's role key" }, say: { type: "string", description: "What you're handing over or asking, with any ids (ticket number, launch id), in a sentence or two" } }, required: ["to", "say"], additionalProperties: false },
      run: async (input) => {
        const to = String(input.to);
        const ok = canHandOff({ from: ctx.self, to }, { host: ctx.team.host, line: ctx.team.line, chain: ctx.team.chain });
        if (!ok.ok) return { handed: false, note: ok.why };
        if (ctx.team.handoff) return { handed: false, note: "You've already handed something over this turn." };
        ctx.team.handoff = { from: ctx.self, to, say: clip(input.say, 800) };
        ctx.team.chain.push(`${ctx.self}>${to}`);
        if (ctx.team.job) await patchJob(ctx, { note: `To the ${labelOf(to)}: ${clip(input.say, 200)}` }).catch(() => undefined);
        return { handed: true, note: `Stop now: the ${labelOf(to)} picks it up next.` };
      },
    },
    {
      name: "call_in_specialist",
      description: `Brings a specialist agent onto this call (it joins with its own voice, playbook and tools; up to three at once; the others stay on). When the person asks for one ("call in the Google buyer") or asks a strategy question in its area, call it straight away: no question first. When it's your idea, ask first and say why ("There's no approved copy yet, want me to grab the Copywriter?"), and call it with confirmed: true once they say yes. Specialists: ${SPECIALIST_KEYS.map((k) => `${k} (${specialistOf(k)?.label}: ${specialistOf(k)?.about})`).join("; ")}.`,
      input_schema: { type: "object", properties: { role: { type: "string", enum: SPECIALIST_KEYS }, question: { type: "string", description: "What it's brought in to do, with what it needs to know (ticket numbers, what's done)" }, confirmed: CONFIRMED }, required: ["role", "question"], additionalProperties: false },
      run: async (input) => {
        const sp = specialistOf(String(input.role));
        if (!sp) return { joined: false, note: "Not one of the specialists." };
        // The writer joins on the lead's word once the person agreed the topics (that agreement was the yes)
        const agreed = !bringOk(ctx, sp.key, input) && (await import("@/lib/deliverables/server").then((m) => m.writerMayJoin(ctx.admin, ctx.callId, sp.key)).catch(() => false));
        if (!bringOk(ctx, sp.key, input) && !agreed) return { joined: false, note: NO_YES };
        const j = await joinSpecialist(ctx, sp.key);
        if (!j.joined) return { joined: false, note: j.note };
        ctx.team.joined.push({ role: sp.key, question: clip(input.question, 1000) });
        if (agreed) await import("@/lib/deliverables/server").then(async (m) => {
          const run = await m.currentRun(ctx.admin, ctx.callId);
          if (run) await m.patchRun(ctx.admin, run, { writerJoined: true });
        }).catch(() => undefined);
        return { joined: true, note: `Say one short line ("Bringing in the ${j.label}.") and stop: it answers next.` };
      },
    },
    {
      name: "dismiss_specialist",
      description: hosting
        ? "Lets a specialist go when its part is done or they ask you to take it from here (role: which one; leave it out to let them all go). Thank it in a few words first."
        : "Steps you out of the call when your part is done (role: your own key). Say a short goodbye first.",
      input_schema: { type: "object", properties: { role: { type: "string", enum: SPECIALIST_KEYS } }, additionalProperties: false },
      run: async (input) => {
        const role = typeof input.role === "string" ? input.role : null;
        if (!hosting && role && role !== ctx.self) return { left: false, note: "Only the host lets others go." };
        const going = hosting ? (role ? [role] : [...ctx.team.line]) : [ctx.self];
        if (!going.some((k) => ctx.team.line.includes(k))) return { note: "Nobody else is on the call." };
        ctx.team.line = ctx.team.line.filter((k) => !going.includes(k));
        await saveLine(ctx.admin, ctx.callId, ctx.team.line);
        await emitLine(ctx.admin, ctx.team.line, ctx.emit);
        return { left: going.map(labelOf) };
      },
    },
    ...launchTools(ctx),
  ];
  if (hosting)
    tools.push({
      name: "finish_job",
      description: "Marks the job finished (or dropped) once nothing needed is left or they stop it; then sum it up in two sentences: what was made, what's live, what's left and for whom.",
      input_schema: { type: "object", properties: { outcome: { type: "string", enum: ["done", "dropped"] }, summary: { type: "string" } }, required: ["outcome"], additionalProperties: false },
      run: async (input) => {
        if (!ctx.team.job) return { note: "No job on this call." };
        await patchJob(ctx, { status: input.outcome === "dropped" ? "dropped" : "done", note: clip(input.summary, 300) || null });
        return { finished: true, made: ctx.team.job.artifacts.map((a) => a.label) };
      },
    });
  return tools;
}

// ─── What every agent on a team call reads ──────────────────────────────────

/** How agents work together on a call (a specialist's rules; the host's are in its own instructions) */
export const teamRule = (firstName: string) => `Working as a team on this call: the job below is shared by everyone on the line; read it before you speak and never repeat what's done or ask what's already known. When your part feeds another agent on the line (copy for the buyer, an angle for the brief), hand it over with hand_off: one short line out loud ("Here's the approved copy for the Media Buyer."), then stop; it picks up from there. Ask another agent a question the same way. One line each, never a long back-and-forth without ${firstName}. Record what you finish with update_job. Anything that goes live, sends or spends needs ${firstName}'s own spoken yes: ask them, never another agent. When your part is done, say so in a line; the host thanks you out (or step out yourself with dismiss_specialist). Bring someone else in only after asking ${firstName}, saying why, unless ${firstName} asked for them: then straight away.`;

/** For an agent called directly: how it runs a job on its call, bringing in only the agents a part needs */
export const hostRule = (firstName: string) =>
  `Jobs on this call: when ${firstName} wants a job done (launch ads, an email request, a creative brief, an audit and sprint, a report), start_job right away; it checks what's there and returns what's missing, in order, and who does each part. Do your own parts yourself. For a part that's another agent's (copy for your launch, say), ask first and say why ("There's no approved copy for these ads yet, want me to grab the Copywriter?"), and only on a yes, call_in_specialist; when ${firstName} asks for one by name, call it in straight away with no question. When its part is done, thank it and let it go (dismiss_specialist). ${teamRule(firstName)}`;

/** Who's on the call and the job, for an agent's prompt */
export function teamBlock(team: TeamState, self: string, firstName: string): string {
  const others = [team.host, ...team.line].filter((k) => k !== self).map((k) => `the ${labelOf(k)}${k === team.host ? " (hosting)" : ""}`);
  const who = others.length ? `<on_the_line>${firstName}, you${self === team.host ? " (hosting)" : ""}, ${others.join(", ")}.</on_the_line>` : "";
  return [who, jobForPrompt(team.job, team.gaps)].filter(Boolean).join("\n\n");
}

// ─── A specialist's turn ────────────────────────────────────────────────────

const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });

export function logRun(admin: SupabaseClient, me: Staff, roleKey: string, out: Answer) {
  void admin
    .from("ai_runs")
    .insert({ agent_key: "coach", label: `agent call ${roleKey}`, model: out.model, effort: out.effort, ms: Date.now() - out.started, ...out.used, ok: !out.error, error: out.error, profile_id: me.id, actor: "person" })
    .then(({ error: e }) => e && console.error("[call team] log run", e.message));
}

const guestNote = (firstName: string, host: string) =>
  `On this call: ${host === "assistant" ? `${firstName}'s personal assistant` : `the ${labelOf(host)}`} brought you in and hosts it. Answer in your area; keep it short. Don't end the call: when they're done with you, the host takes it from there. If something isn't your area, say so in a line and hand it back.`;

const hostNote = (firstName: string) => `You're hosting this call with ${firstName}; other agents are on the line with you. Don't end the call while it's being handed around: end it only when ${firstName} says goodbye.`;

export type TurnMode = {
  text: string;
  mode: "person" | "joined" | "handoff";
  from?: string | null;
  /** It was brought on for these words just now */
  fresh?: boolean;
};

/**
 * One agent's answer on a team call: its playbook, voice and tools, the team tools, who's on and the job. `person`:
 * the person spoke to it (their words, a yes counts, a trainer teaches it); `joined`: it was just brought in for
 * `text`; `handoff`: another agent handed it `text`. Nothing gated runs on a joined or handed-over turn.
 */
export async function specialistTurn(input: TurnInput, team: TeamState, roleKey: string, m: TurnMode) {
  const { me, admin, call, emit, signal } = input;
  const firstName = firstNameOf(me.fullName);
  const asHost = roleKey === team.host;
  const trains = canTrainAgent(me, roleKey) && m.mode === "person";
  const said = m.mode === "person" ? m.text : "";
  const timer = input.timer ?? callTimer();
  const tag = `${roleKey}.`;
  const mode = talkModeOf(input.mode);
  const [book, convo, extra] = await timer.time(
    `${tag}context`,
    Promise.all([timer.time(`${tag}playbook`, playbookFor(admin, roleKey)), timer.time(`${tag}history`, callContext(admin, { ...call, role_key: roleKey }, firstName)), turnExtras(input, m.text, tag)]),
  );
  if (!book) return emit({ t: "error", message: "That agent isn't available." });
  const role = { icon: ((book.role as { icon?: string | null }).icon ?? null) as string | null };
  const tctx: TeamCtx = { me, db: input.db, admin, callId: call.id, emit, team, self: roleKey, said };
  const own = await timer.time(`${tag}tools_build`, agentTools({ me, db: input.db, admin, roleKey, label: book.role.label, callId: call.id, emit, said, path: input.path ?? null, screen: input.context?.screen ?? null, clientId: input.context?.clientId ?? null }));
  const tools = tracked(tctx, [...own, ...teamTools(tctx)]);
  emit({ t: "speaker", role: roleKey, label: book.role.label, icon: (role?.icon as string) ?? "spark" });
  const lastWord = team.chain.length >= MAX_HOPS ? `<last_word>That's the last hand-off for now: answer, then give ${firstName} the floor with a short question.</last_word>` : "";
  const prompt =
    m.mode === "joined"
      ? `<just_joined>You've just been brought in for this: ${m.text}\nSay hi to ${firstName} in a few words and get on with it.</just_joined>`
      : m.mode === "handoff"
        ? `<handed_to_you by="the ${labelOf(m.from ?? team.host)}">\n${m.text}\n</handed_to_you>\nPick it up from there. Say what you're doing in a line, do your part, then hand on or ask ${firstName}.`
        : `${m.fresh ? `<just_joined>${firstName} asked for you just now and you've joined the call. Say hi in a couple of words, then answer what they said.</just_joined>\n` : ""}<${firstName}_says>\n${m.text}\n</${firstName}_says>`;
  const out = await streamAnswer({
    system: `${voiceSystem(book.role.label, roleKey, firstName, trains, asHost ? hostNote(firstName) : guestNote(firstName, team.host), mode)}\n\n${asHost ? hostRule(firstName) : teamRule(firstName)}\n\n${book.text}`,
    tools: [...tools, extra.look, ...extra.connectors.tools],
    connectors: extra.connectors,
    content: withFrame([`Today is ${today()} (New York).`, extra.where, teamBlock(team, roleKey, firstName), convo, extra.hint, lastWord, prompt].filter(Boolean).join("\n\n"), extra.frame),
    signal,
    emit,
    filler: { callId: call.id, turn: input.startedAt ?? 0, said: m.mode === "person" ? m.text : "" },
    timer,
    tag,
    mode,
  });
  await extra.connectors.settle().catch(() => undefined);
  logRun(admin, me, roleKey, out);
  const spoken = keptLine(out.reply, signal.aborted, mode);
  // The person's line at when they said it, the answer after it (the transcript reads them in that order)
  const at = turnTimes(m.mode === "person" ? input.startedAt : null, Date.now());
  await admin.from("ai_role_chats").insert([
    ...(m.mode === "person" ? [{ role_key: roleKey, role: "user", content: m.text, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.said }] : []),
    ...(spoken ? [{ role_key: roleKey, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.answered }] : []),
  ]);
  if (out.ended && asHost && m.mode === "person") emit({ t: "end" });
  // Only a trainer of this agent teaches it, and only from what they said to it
  if (trains) {
    const moment = await readMoment(book, m.text, out.reply);
    const heard = pendingItems(moment.learnings.filter((l) => canTrainAgent(me, l.type === "note" ? l.skill : roleKey)), () => crypto.randomUUID()).map((l) => ({ ...l, role: roleKey }));
    if (heard.length) {
      await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 0, p_learned: heard });
      emit({ t: "learned", items: heard });
    }
  }
}

/**
 * What follows an answer: the specialists brought in answer what they were brought in for, then hand-offs between
 * agents run (within the limit). `host` answers a hand-off to the host (the assistant's own turn, or the agent's).
 */
export async function followUps(input: TurnInput, team: TeamState, host: (m: TurnMode) => Promise<void>) {
  const { signal } = input;
  for (let guard = 0; guard < MAX_HOPS + 4 && !signal.aborted; guard++) {
    const j = team.joined.shift();
    if (j) {
      if (team.line.includes(j.role)) await specialistTurn(input, team, j.role, { text: j.question, mode: "joined" });
      continue;
    }
    const h = team.handoff;
    if (!h) return;
    team.handoff = null;
    if (h.to === team.host) await host({ text: h.say, mode: "handoff", from: h.from });
    else if (team.line.includes(h.to)) await specialistTurn(input, team, h.to, { text: h.say, mode: "handoff", from: h.from });
  }
}

/** Lets the named specialists go (the person handed the call back) and shows the line */
export async function dismissFromLine(input: Pick<TurnInput, "admin" | "call" | "emit">, team: TeamState, going: readonly string[]) {
  if (!going.length) return;
  team.line = team.line.filter((k) => !going.includes(k));
  await saveLine(input.admin, input.call.id, team.line);
  await emitLine(input.admin, team.line, input.emit);
}
