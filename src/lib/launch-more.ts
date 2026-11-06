import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { ChatTurn } from "@/lib/handoff";
import { cachedRead, step } from "@/lib/launch-cache";
import { canIdOn } from "@/lib/chat-permissions-server";
import { SETUP_RULE, checkAgainstSetup, type SetupFacts } from "@/lib/setup-check";

// "Want me to suggest some more changes while you have me here?": offered on a launch card once the launch the buyer
// asked for is deployed and read back (never before: the launch itself only asks what that launch needs). On yes, the
// platform's buyer agent reads the account (the launch's own read, kept a few minutes, so it's quick) and writes a few
// concrete actions, nothing already in place (the setup check). Where they go:
// - the account's optimization sprint, when its KPI has one (or a recent audit to open one from): sprint actions,
//   tagged as from the launch chat, deduped against what's on the list. The daily check follows them from there.
// - otherwise the buyer's own tasks on the client (client_tasks, "lc:" keys, the same list a business audit uses for
//   moves with no sprint): they show in Next for me and the client's Plan tab, to do then or later. Each can also be
//   started right away from the card as a chat change (Plan the change), which checks the role and the live switch.

export type MoreItem = { title: string; why: string; detail: string; steps: string[]; ref: { kind: "sprint" | "task"; id: string } | null; started: string | null };
export type MoreState = {
  status: "writing" | "done" | "declined" | "failed";
  where: "sprint" | "tasks" | null;
  href: string | null;
  items: MoreItem[];
  /** Left out: already on the list, or already in place in the account */
  skipped: number;
  error: string | null;
  at: string;
};

type Platform = "google" | "meta";
type RunRow = { id: string; client_id: string; platform: Platform; account: string | null; status: string; plan: Record<string, unknown> | null; resolution: Record<string, unknown> | null; created_by: string | null };

const S = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({ items: { type: "array", items: obj({ title: S, why: S, detail: S, steps: { type: "array", items: S } }) } });
const now = () => new Date().toISOString();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const noDash = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").trim();

async function loadRun(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("launch_runs").select("id, client_id, platform, account, status, plan, resolution, created_by").eq("id", id).maybeSingle();
  return (data as RunRow | null) ?? null;
}

/** The "more" state on a run (null: not offered or not answered yet) */
export function moreOf(resolution: unknown): MoreState | null {
  return ((resolution as { more?: MoreState } | null)?.more ?? null) as MoreState | null;
}

async function saveMore(admin: SupabaseClient, id: string, more: MoreState) {
  // Read just before writing: the rest of the resolution may have moved on
  const { data } = await admin.from("launch_runs").select("resolution").eq("id", id).single();
  await admin
    .from("launch_runs")
    .update({ resolution: { ...((data?.resolution as Record<string, unknown> | null) ?? {}), more }, updated_at: now() })
    .eq("id", id);
}

/** What was just launched, in a line or two, so the suggestions are about the rest of the account */
function launchedText(run: RunRow) {
  const p = run.plan as { campaigns?: { name: string }[]; adGroups?: { name: string; keywords?: unknown[] }[]; adsets?: { name: string }[]; ads?: { name: string }[] } | null;
  if (!p) return "(nothing)";
  return [
    `Campaigns: ${(p.campaigns ?? []).map((c) => c.name).join(", ") || "none"}`,
    p.adGroups ? `Ad groups: ${p.adGroups.map((g) => `${g.name} (${g.keywords?.length ?? 0} keywords)`).join(", ")}` : "",
    p.adsets ? `Ad sets: ${p.adsets.map((s) => s.name).join(", ")}` : "",
    p.ads ? `Ads: ${p.ads.length}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The account as the suggestions read it: its campaigns, what's set up (for the setup check) and the numbers */
async function accountFor(admin: SupabaseClient, run: RunRow): Promise<{ text: string; setup: string; facts: SetupFacts | null }> {
  const account = run.account ?? "";
  const scorecard = await import("@/lib/kpi/campaigns").then((m) => m.clientCampaignsText(admin, run.client_id)).catch(() => "");
  if (run.platform === "google") {
    const { googleAccountForSuggestions } = await import("@/lib/google-launch/runs");
    const g = await googleAccountForSuggestions(admin, run.client_id, account);
    return { text: [g.text, scorecard].filter(Boolean).join("\n\n"), setup: g.setup, facts: g.facts };
  }
  // Meta: what's set up (kept ten minutes) and the campaigns' last 30 days
  const snap = await cachedRead(
    admin,
    `meta-setup:${account}`,
    async () => {
      const { accountSetup } = await import("@/lib/context/meta");
      const { setupSnapshot } = await import("@/lib/setup-snapshot");
      const setup = await accountSetup(account).catch(() => null);
      return (await setupSnapshot("meta", account, setup)) ?? { text: "", facts: null as SetupFacts | null };
    },
    { clientId: run.client_id },
  ).then((r) => r.value);
  return { text: scorecard || "(the campaigns' numbers couldn't be read)", setup: snap.text.slice(0, 5000), facts: snap.facts };
}

/** Where the suggestions go: the KPI's open sprint (or one opened from a recent audit), else the buyer's own tasks */
async function sprintFor(admin: SupabaseClient, run: RunRow): Promise<string | null> {
  const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
  const { data: ts } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", run.client_id).eq("platform", run.platform).eq("active", true).order("created_at");
  const targets = [...(ts ?? [])].sort((a, b) => Number(digits(b.ad_account_id) === digits(run.account)) - Number(digits(a.ad_account_id) === digits(run.account)));
  if (!targets.length) return null;
  const ids = targets.map((t) => t.id as string);
  const { data: open } = await admin.from("optimization_sprints").select("id, target_id").in("target_id", ids).eq("status", "active");
  const hit = targets.map((t) => (open ?? []).find((s) => s.target_id === t.id)).find(Boolean);
  if (hit) return hit.id as string;
  // An audit in the last 30 days with no sprint running: open its sprint (its plan's "now" and "this week" moves come too)
  const { data: audit } = await admin.from("account_audits").select("id, target_id").in("target_id", ids).eq("status", "ready").gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!audit) return null;
  const { openSprint } = await import("@/lib/sprints");
  return (await openSprint(admin, audit.id as string).catch(() => null)) ?? null;
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/**
 * Yes, suggest more: one fast call for a few account-wide actions, checked against what's in place, then added to the
 * sprint or the buyer's tasks. Returns the state the card shows and a line for the chat.
 */
export async function suggestMore(admin: SupabaseClient, runId: string, by: string): Promise<{ more: MoreState; line: string }> {
  const run = await loadRun(admin, runId);
  if (!run || !run.account) throw new Error("That launch isn't there anymore.");
  if (run.status !== "applied") throw new Error("Suggestions come once the launch is deployed.");
  // Sprint actions and tasks for changes in this platform's account: only for someone who may change it on this client
  // (src/lib/chat-permissions.ts). Nothing is saved for anyone else.
  const allowed = await canIdOn(admin, by, "ads.change", { platform: run.platform === "google" ? "google" : "meta", clientId: run.client_id });
  if (!allowed.ok) return { more: { status: "failed", where: null, href: null, items: [], skipped: 0, error: allowed.reason, at: now() }, line: allowed.reason };
  const was = moreOf(run.resolution);
  if (was && (was.status === "done" || was.status === "writing")) return { more: was, line: lineFor(was) };
  const scope = `${run.platform} run ${runId.slice(0, 8)}`;
  await saveMore(admin, runId, { status: "writing", where: null, href: null, items: [], skipped: 0, error: null, at: now() });
  try {
    const acct = await step(scope, "suggest more: account read", accountFor(admin, run));
    const platform = run.platform === "google" ? "Google Ads" : "Meta";
    const out = await step(
      scope,
      "suggest more (fast tier)",
      askJson<{ items: { title: string; why: string; detail: string; steps: string[] }[] }>({
        agent: run.platform === "google" ? "google_launcher" : "launcher",
        label: `${run.platform} launch suggest more`,
        clientId: run.client_id,
        override: { model: "sonnet", effort: "low" },
        system: `You're the ${platform} buyer for this client. The launch the buyer asked for was just deployed (below). They said yes to "Want me to suggest some more changes while you have me here?". Suggest up to 5 changes in the ${platform} account that would most improve the client's results, from the account's numbers below.
Each must be a concrete action a buyer does in the ad account in a few minutes to an hour: pause or cut, add negatives, move budget, add keywords or audiences, fix an ad, change a bid target. Name the campaign or ad group and the number. Never: sign-offs or approvals, asking someone, checking Merchant Center or tracking setups, cleaning up conversion actions, reports, anything about the launch just made.
title: at most 8 words, starts with a verb. why: one sentence of at most 20 words with the key number. detail: one or two sentences with the exact objects and values. steps: 1 to 4 short steps.
${SETUP_RULE}
Plain text, no markdown, no emojis, no em dashes. Refer to people by role, never by name.`,
        schema: SCHEMA,
        maxTokens: 3000,
        prompt: `<just_launched>\n${launchedText(run)}\n</just_launched>\n\n<account id="${run.account}">\n${acct.text.slice(0, 9000)}\n</account>\n\n<live_setup>\n${acct.setup || "(couldn't be read)"}\n</live_setup>`,
      }),
    );
    const raw = out.items.slice(0, 5).map((x) => ({ title: noDash(x.title), why: noDash(x.why), detail: noDash(x.detail), steps: x.steps.map(noDash).slice(0, 4) }));
    // Nothing that adds what's already in place
    const checked = checkAgainstSetup(raw, acct.facts).actions;
    let skipped = raw.length - checked.length;
    const sprintId = await sprintFor(admin, run);
    const dated = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
    const note = `From the ${platform} launch chat on ${dated}`;
    const { similarity, SAME } = await import("@/lib/business-audit-merge");
    let items: MoreItem[] = [];
    let where: MoreState["where"];
    let href: string | null;
    if (sprintId) {
      where = "sprint";
      href = `/kpis/sprint/${sprintId}`;
      const { data: have } = await admin.from("sprint_actions").select("title, sort_order").eq("sprint_id", sprintId);
      const fresh = checked.filter((x) => !(have ?? []).some((h) => similarity(h.title as string, x.title) >= SAME));
      skipped += checked.length - fresh.length;
      let order = Math.max(500, ...(have ?? []).map((x) => x.sort_order as number)) + 1;
      const rows = fresh.map((x) => ({ sprint_id: sprintId, source: "launch", added_by: by, title: x.title, why: x.why, steps: x.steps.length ? x.steps : [x.detail], impact: "", note: `${note}. ${x.detail}`.slice(0, 1000), when: "this_week", owner: "media_buyer", area: run.platform, sort_order: order++ }));
      let ins = rows.length ? await admin.from("sprint_actions").insert(rows).select("id, title") : { data: [], error: null };
      // Before the migration that allows "launch" as a source: added as the buyer's own moves (the note says where from)
      if (ins.error && /source|check/i.test(ins.error.message)) ins = await admin.from("sprint_actions").insert(rows.map((r) => ({ ...r, source: "buyer" }))).select("id, title");
      if (ins.error) throw new Error(ins.error.message);
      items = fresh.map((x) => ({ ...x, ref: { kind: "sprint" as const, id: ((ins.data ?? []).find((r) => r.title === x.title)?.id as string | undefined) ?? "" }, started: null }));
      if (fresh.length) {
        const { data: last } = await admin.from("sprint_checks").select("verdict, kpi, next_check_at").eq("sprint_id", sprintId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        await admin.from("sprint_checks").insert({ sprint_id: sprintId, verdict: (last?.verdict as string | undefined) ?? "started", message: `${note}: ${fresh.length} new ${fresh.length === 1 ? "move" : "moves"} at the end of the list: ${fresh.map((x) => x.title).join("; ")}.`, kpi: last?.kpi ?? {}, next_check_at: last?.next_check_at ?? null });
      }
    } else {
      where = "tasks";
      const { data: c } = await admin.from("clients").select("slug").eq("id", run.client_id).single();
      href = `/clients/${c?.slug ?? ""}?tab=plan`;
      const { data: openTasks } = await admin.from("client_tasks").select("key, title").eq("client_id", run.client_id).eq("owner_id", by).in("status", ["ready", "in_progress", "blocked"]);
      const fresh = checked.filter((x) => !(openTasks ?? []).some((t) => similarity(t.title as string, x.title) >= SAME));
      skipped += checked.length - fresh.length;
      const { data: lastPos } = await admin.from("client_tasks").select("position").eq("client_id", run.client_id).order("position", { ascending: false }).limit(1).maybeSingle();
      let position = ((lastPos?.position as number | undefined) ?? 0) + 1;
      const { addBusinessDays } = await import("@/lib/brand-bible");
      const at = new Date();
      const rows = fresh.map((x, i) => ({
        client_id: run.client_id,
        key: `lc:${runId.slice(0, 8)}:${i}`,
        title: x.title,
        detail: [`${note}. ${x.why}`, x.detail, ...x.steps.map((s, j) => `${j + 1}. ${s}`)].filter(Boolean).join("\n"),
        platform: run.platform,
        phase: "d30",
        owner_role: run.platform === "google" ? "google_buyer" : "meta_buyer",
        owner_id: by,
        due_on: fmtDay(addBusinessDays(at, 5)),
        depends_on: [],
        auto: null,
        status: "ready",
        ready_at: at.toISOString(),
        position: position++,
        updated_at: at.toISOString(),
      }));
      const ins = rows.length ? await admin.from("client_tasks").upsert(rows, { onConflict: "client_id,key" }).select("id, key") : { data: [], error: null };
      if (ins.error) throw new Error(ins.error.message);
      items = fresh.map((x, i) => ({ ...x, ref: { kind: "task" as const, id: ((ins.data ?? []).find((r) => r.key === `lc:${runId.slice(0, 8)}:${i}`)?.id as string | undefined) ?? "" }, started: null }));
    }
    const more: MoreState = { status: "done", where, href, items, skipped, error: null, at: now() };
    await saveMore(admin, runId, more);
    return { more, line: lineFor(more) };
  } catch (e) {
    const more: MoreState = { status: "failed", where: null, href: null, items: [], skipped: 0, error: msg(e).slice(0, 300), at: now() };
    await saveMore(admin, runId, more);
    return { more, line: `I couldn't write the suggestions: ${more.error}` };
  }
}

/** "Added 4 actions to the current sprint" / "Saved 4 actions for you" */
export function lineFor(m: MoreState) {
  const n = m.items.length;
  const what = `${n} action${n === 1 ? "" : "s"}`;
  const left = m.skipped ? ` (${m.skipped} left out: already on your list or already in place)` : "";
  if (m.status === "writing") return "Writing the suggestions now.";
  if (m.status === "failed") return `I couldn't write the suggestions: ${m.error ?? "try again"}.`;
  if (m.status === "declined") return "No problem. The launch is done.";
  if (!n) return `Nothing new worth adding right now${left}.`;
  return m.where === "sprint" ? `Added ${what} to the current sprint${left}. Each is on the launch card to start now, or work them from the sprint.` : `Saved ${what} for you${left}. They're in your Next for me and the client's Plan tab; start any of them now from the launch card.`;
}

/** No thanks */
export async function declineMore(admin: SupabaseClient, runId: string) {
  const run = await loadRun(admin, runId);
  if (!run || moreOf(run.resolution)?.status === "done") return;
  await saveMore(admin, runId, { status: "declined", where: null, href: null, items: [], skipped: 0, error: null, at: now() });
}

/** Marks an item as started as a chat change (its plan card is in the chat) */
export async function markMoreStarted(admin: SupabaseClient, runId: string, index: number, changeId: string) {
  const run = await loadRun(admin, runId);
  const m = run && moreOf(run.resolution);
  if (!m?.items[index]) return;
  m.items[index] = { ...m.items[index], started: changeId };
  await saveMore(admin, runId, m);
}

/** The person's launch deployed in the last few hours whose "suggest more?" is still unanswered (for a "yes" in chat) */
export async function pendingOffer(admin: SupabaseClient, clientId: string, profileId: string) {
  const { data } = await admin
    .from("launch_runs")
    .select("id, platform, status, resolution, updated_at")
    .eq("client_id", clientId)
    .eq("created_by", profileId)
    .eq("status", "applied")
    .gte("updated_at", new Date(Date.now() - 6 * 3_600_000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || moreOf(data.resolution)) return null;
  return { id: data.id as string, platform: data.platform as Platform };
}

/** Turns added to the person's thread about the client (what was said on the card, so the chat has it too) */
export async function appendChat(admin: SupabaseClient, clientId: string, profileId: string, turns: ChatTurn[]) {
  const { data } = await admin.from("client_chats").select("turns").eq("client_id", clientId).eq("profile_id", profileId).maybeSingle();
  const next = [...((data?.turns ?? []) as ChatTurn[]), ...turns].slice(-60);
  await admin.from("client_chats").upsert({ client_id: clientId, profile_id: profileId, turns: next, updated_at: now() });
  return next.slice(-40);
}

/** The confirmation in the chat, pointing at the launch card and where the actions went */
export function moreTurn(runId: string, platform: Platform, m: MoreState): ChatTurn {
  return {
    role: "assistant",
    text: lineFor(m),
    at: now(),
    launch: { id: runId, platform },
    ...(m.status === "done" && m.items.length && m.href ? { link: { href: m.href, label: m.where === "sprint" ? "Open the sprint" : "Open your tasks" } } : {}),
  };
}

/** Load the run's platform and client (for the card's actions) */
export async function runBasics(admin: SupabaseClient, runId: string) {
  const run = await loadRun(admin, runId);
  return run ? { clientId: run.client_id, platform: run.platform, status: run.status, more: moreOf(run.resolution), createdBy: run.created_by } : null;
}
