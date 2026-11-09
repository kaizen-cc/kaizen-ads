"use server";

import { after } from "next/server";
import { AGENCY_SYSTEM, AiUnavailable, aiEnabled, askJson, clientContext, contextBlock } from "@/lib/ai";
import { requireStaff, type Staff } from "@/lib/auth";
import { can } from "@/lib/chat-permissions";
import { answerFact, factCategory } from "@/lib/brief-facts";
import { canOverride, type GateKey, type ReviewStamp } from "@/lib/brief-gate";
import { LINT_SCHEMA, type LintIssue } from "@/lib/brief-lint";
import { COPY_FIELDS, FIELD_LABEL, PATCH_SCHEMA, applyBriefPatch, briefOf, diffStates, stateOf, type BriefChange, type BriefState, type FieldDiff, type PatchField } from "@/lib/brief-patch";
import { SPEC_RULE, composeBrief } from "@/lib/brief-spec";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Everything done to a brief around sending it, from the brief's check panel (Ready to send and the ticket): the ready
// check (client-only facts, assets, contradictions; the AI's consistency pass on request), the revise chat (a
// correction becomes a structured patch the person sees and can undo, logged and learned from), "Mark reviewed" (the
// stamp on the brief, the ticket and the PDF), a lead's override of a gate with a reason, and a fact routed to the
// client as a Brand Bible question. Every row goes to brief_corrections.

/** A brief being sent (Ready to send) or one already on the Board */
export type BriefTarget =
  | { kind: "draft"; clientId: string; title: string; angle: string; audience: string; sizes: string[]; brief: string; refs: string[]; formats: string[]; priority: string; suggestionId?: string | null }
  | { kind: "ticket"; requestId: string };

type Fail = { ok: false; error: string };
type Loaded = { clientId: string; requestId: string | null; suggestionId: string | null; title: string; angle: string; audience: string; sizes: string[]; brief: string; refs: string[]; formats: string[]; priority: string; due: string | null };

const UUID = /^[0-9a-f-]{36}$/i;

/** The brief as it stands, read through the person's own access (a ticket they can't see isn't found) */
async function load(t: BriefTarget): Promise<Loaded | Fail> {
  const db = await createClient();
  if (t.kind === "ticket") {
    if (!UUID.test(t.requestId)) return { ok: false, error: "That ticket isn't there." };
    const { data: r } = await db.from("board_requests").select("id, client_id, title, audience, sizes, brief, refs, format, priority, stage_due_at, angle_name").eq("id", t.requestId).maybeSingle();
    if (!r) return { ok: false, error: "That ticket isn't one you can see." };
    return {
      clientId: r.client_id as string,
      requestId: r.id as string,
      suggestionId: null,
      title: (r.title as string) ?? "",
      angle: (r.angle_name as string | null) ?? "",
      audience: (r.audience as string | null) ?? "",
      sizes: (r.sizes as string[] | null) ?? [],
      brief: (r.brief as string | null) ?? "",
      refs: (r.refs as string[] | null) ?? [],
      formats: [r.format as string],
      priority: (r.priority as string) ?? "normal",
      due: (r.stage_due_at as string | null) ?? null,
    };
  }
  if (!UUID.test(t.clientId)) return { ok: false, error: "Pick a client first." };
  const { data: c } = await db.from("clients").select("id").eq("id", t.clientId).maybeSingle();
  if (!c) return { ok: false, error: "That client isn't one you work on." };
  return {
    clientId: t.clientId,
    requestId: null,
    suggestionId: t.suggestionId && UUID.test(t.suggestionId) ? t.suggestionId : null,
    title: String(t.title ?? "").slice(0, 200),
    angle: String(t.angle ?? "").slice(0, 300),
    audience: String(t.audience ?? "").slice(0, 1000),
    sizes: (t.sizes ?? []).map(String).slice(0, 4),
    brief: String(t.brief ?? "").slice(0, 20000),
    refs: (t.refs ?? []).map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20),
    formats: (t.formats ?? []).map(String).filter((f) => ["image", "video", "carousel"].includes(f)),
    priority: String(t.priority ?? "normal"),
    due: null,
  };
}

/** What this person may change in a brief: everything (they brief this format), the copy lines (the copywriter), or nothing */
function editable(me: Staff, formats: string[]): { fields: PatchField[] | null } | Fail {
  if (can(me, "brief", { formats }).ok) return { fields: null };
  if (can(me, "copy").ok) return { fields: COPY_FIELDS };
  return { ok: false, error: can(me, "brief", { formats }).reason ?? "Briefs are for the creative team, the media buyers and the executives." };
}

const toInput = (b: Loaded) => ({ clientId: b.clientId, title: b.title, brief: b.brief, sizes: b.sizes, formats: b.formats, refs: b.refs, due: b.due, priority: b.priority });

export type CheckResult = { ok: true; check: import("@/lib/brief-check").BriefCheck; ai: LintIssue[] | null; canOverride: boolean; canEdit: boolean; copyOnly: boolean } | Fail;

/** The ready check; withAi adds the AI's consistency pass (contradictions the code rules can't see, claims against the Bible) */
export async function checkBrief(t: BriefTarget, withAi = false): Promise<CheckResult> {
  const me = await requireStaff();
  const b = await load(t);
  if ("ok" in b) return b;
  if (!adminConfigured()) return { ok: false, error: "The database isn't connected here." };
  const admin = createAdminClient();
  const { checkBriefNow } = await import("@/lib/brief-check");
  const check = await checkBriefNow(admin, toInput(b));
  const ed = editable(me, b.formats);
  let ai: LintIssue[] | null = null;
  if (withAi && aiEnabled() && b.brief.trim()) {
    try {
      const ctx = await clientContext(admin, b.clientId);
      const out = await askJson<{ issues: { message: string; severity: "hard" | "soft"; fix: string }[] }>({
        agent: "review",
        label: "brief consistency",
        clientId: b.clientId,
        override: { model: "sonnet", effort: "low" },
        maxTokens: 3000,
        schema: LINT_SCHEMA,
        system: `${AGENCY_SYSTEM}

You check one creative brief for contradictions inside it before it goes to the editor or designer, the way an editor reading it would trip on them. Look only for real conflicts between two things the brief (or its sizes and formats) says, or between the brief and the client's context: sizes against file names and placements (Kaizen makes 4:5 and 9:16 only), logo or branding rules against the hook or end card, "evergreen" or "no event-specific content" against event footage or dates, claims or proof against what the Brand Bible and client memory cleared, durations against the platform (Reels and Stories), the format against what's asked (a static asked for motion). hard: the maker can't follow both; soft: worth a look. message: one plain sentence naming both sides. fix: an instruction to resolve it, as you'd type it to the person editing the brief. No style notes, nothing about wording you'd prefer, nothing already fine. [] when there's nothing. No em dashes.`,
        prompt: `${ctx ? contextBlock(ctx) : ""}

<brief formats="${b.formats.join(", ")}" sizes="${b.sizes.map((s) => s.replace("x", ":")).join(", ")}">
Title: ${b.title}
Angle: ${b.angle}
Audience: ${b.audience}

${b.brief}
</brief>

Already found by the code checks (don't repeat these): ${[...check.hard, ...check.soft].map((x) => x.message).join(" | ") || "none"}`,
      });
      ai = (out.issues ?? []).slice(0, 6).map((x, i) => ({ id: `ai-${i}`, severity: x.severity === "hard" ? "hard" : "soft", message: x.message.slice(0, 300), fixes: x.fix.trim() ? [{ kind: "ai" as const, instruction: x.fix.slice(0, 400), label: "Fix it" }] : [] }));
    } catch (e) {
      if (!(e instanceof AiUnavailable)) console.error("[brief check] ai", e instanceof Error ? e.message : e);
      ai = null;
    }
  }
  return { ok: true, check, ai, canOverride: canOverride(me), canEdit: !("ok" in ed), copyOnly: !("ok" in ed) && ed.fields !== null };
}

export type ReviseTurn = { role: "user" | "ai"; text: string };
export type ReviseResult =
  | { ok: true; reply: string; state: BriefState; brief: string; diff: FieldDiff[]; correctionId: string | null; refused: string[] }
  | Fail;

const REVISE_SYSTEM = `${AGENCY_SYSTEM}

You edit a creative brief that's already written, from a correction someone on the creative team (or their lead) types under it. They know the craft; you have the client's context (Brand Bible, client memory, KPIs, what's working, assets on Drive). Answer with a structured patch, never a rewrite:
- Change only what the message asks for, and whatever must change with it to stay consistent (a size rule and the file names, a branding rule and the hook). Leave every other line exactly as it is.
- Fields: title, angle, audience, overview (the idea in two to four lines), insight, insightSource, keyMessage, hook, kpi, success, yourCall, script (text: op "set", or "remove" to clear), and the lists proof, slides, constraints, dos, donts, assets, confirm, sizes (op "add" a new item, "replace" the item at index, "remove" the item at index, "set" to make the list just this one item). index: the item's position from 0 as listed, -1 when not used. assets: value is the item, status have, need, shoot or missing. confirm: value is the question, answer and source fill in an answer. sizes: "4x5" or "9x16" only (Kaizen makes nothing else). Unused fields of a change: "" (status "" when not assets).
- When they need data to make the change (a KPI, what's worked, which assets are on Drive, a cleared claim), take it from the context and say where it came from. Never invent a price, an offer, a stat, a claim, a date or the fact a concept reveals: if they give you such a fact, record it in confirm with their answer and source "the team"; if it's still unknown, keep (or add) it in confirm with answer "".
- Keep the brief precise on what and why, and leave the how (style, pacing, music, edit structure, exact beats) to the maker in yourCall, unless they ask for a script.
- reply: one or two short sentences: what you changed, or why you couldn't (and what you need). No em dashes. Roles, never people's names.

${SPEC_RULE}`;

/** One correction typed under a brief: the AI's patch applied, shown, logged and learned from */
export async function reviseBrief(t: BriefTarget, instruction: string, history: ReviseTurn[] = []): Promise<ReviseResult> {
  const me = await requireStaff();
  const say = instruction.trim().slice(0, 2000);
  if (!say) return { ok: false, error: "Say what to change." };
  const b = await load(t);
  if ("ok" in b) return b;
  const ed = editable(me, b.formats);
  if ("ok" in ed) return ed;
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  const before = stateOf(b);
  const numbered = (xs: string[]) => xs.map((x, i) => `  [${i}] ${x}`).join("\n") || "  (none)";
  try {
    const [ctx, { loadAssets, assetsBlock }] = await Promise.all([clientContext(admin, b.clientId), import("@/lib/client-assets")]);
    const assets = await loadAssets(admin, b.clientId).catch(() => null);
    const out = await askJson<{ reply: string; changes: BriefChange[] }>({
      agent: "strategist",
      label: "brief revise",
      clientId: b.clientId,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 4000,
      schema: PATCH_SCHEMA as unknown as Record<string, unknown>,
      system: REVISE_SYSTEM,
      prompt: `${ctx ? contextBlock(ctx) : ""}
${assets ? `\n${assetsBlock(assets)}` : ""}

<the_brief formats="${b.formats.join(", ")}">
title: ${before.title}
angle: ${before.angle}
audience: ${before.audience}
sizes:
${numbered(before.sizes)}
overview: ${before.overview || "(empty)"}
insight: ${before.spec.insight || "(empty)"}
insightSource: ${before.spec.insightSource || "(empty)"}
keyMessage: ${before.spec.keyMessage || "(empty)"}
hook: ${before.spec.hook || "(empty)"}
proof:
${numbered(before.spec.proof)}
slides:
${numbered(before.spec.slides)}
constraints:
${numbered(before.spec.constraints)}
dos:
${numbered(before.spec.dos)}
donts:
${numbered(before.spec.donts)}
assets:
${numbered(before.spec.assets.map((a) => `${a.status}: ${a.item}`))}
kpi: ${before.spec.kpi || "(empty)"}
success: ${before.spec.success || "(empty)"}
yourCall: ${before.spec.yourCall || "(empty)"}
script: ${before.spec.script || "(empty)"}
confirm:
${numbered(before.spec.confirm.map((c) => `${c.question}${c.answer ? ` | answer: ${c.answer}${c.source ? ` | source: ${c.source}` : ""}` : " | (not answered)"}`))}
</the_brief>
${ed.fields ? `\nThis person is the copywriter: they may change only ${ed.fields.map((f) => FIELD_LABEL[f]).join(" and ")}. Change nothing else; if they ask for more, say a member of the creative team or a lead makes that change.` : ""}
${history.length ? `\n<conversation_so_far>\n${history.slice(-8).map((h) => `${h.role === "user" ? "Team member" : "You"}: ${h.text.slice(0, 800)}`).join("\n")}\n</conversation_so_far>` : ""}

Their correction: ${say}`,
    });
    const { state, applied, refused } = applyBriefPatch(before, out.changes ?? [], ed.fields);
    const brief = briefOf(state);
    const diff = diffStates(before, state);
    let correctionId: string | null = null;
    if (applied.length) {
      const { briefHash } = await import("@/lib/brief-check");
      const { data: row } = await admin
        .from("brief_corrections")
        .insert({ client_id: b.clientId, request_id: b.requestId, suggestion_id: b.suggestionId, profile_id: me.id, kind: "correction", instruction: say, reply: out.reply?.slice(0, 1000) ?? null, before, after: state, changes: applied, brief_hash: briefHash(brief, state.sizes), format: b.formats.join(",") || null })
        .select("id")
        .single();
      correctionId = (row?.id as string | undefined) ?? null;
      // A ticket's brief changes where it lives
      if (b.requestId) await admin.from("requests").update({ brief, title: state.title || b.title, audience: state.audience || null, sizes: state.sizes }).eq("id", b.requestId);
      // What the reviewer corrected becomes a lesson for the brief writer (classified, consolidated, fed to the next briefs)
      if (correctionId) {
        const id = correctionId;
        const what = diff.map((d) => `${d.label}: "${d.before.slice(0, 160)}" became "${d.after.slice(0, 160)}"`).join("; ");
        after(async () => {
          const { recordLearning } = await import("@/lib/learnings");
          await recordLearning(createAdminClient(), { table: "brief_corrections", id, clientId: b.clientId, agent: "strategist", text: `A reviewer on the creative team corrected a ${b.formats.join("/") || "creative"} brief before it went out: "${say}". Changed: ${what}` });
        });
      }
    }
    return { ok: true, reply: (out.reply ?? "").replace(/\s*\u2014\s*/g, ", ").slice(0, 600) || (applied.length ? "Done." : "Nothing to change."), state, brief, diff, correctionId, refused: refused.map((c) => FIELD_LABEL[c.field] ?? String(c.field)) };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't change it. Try again." };
  }
}

/** A correction taken back: the brief as it was before it (a ticket's is restored), and its lesson retired */
export async function undoBriefCorrection(id: string): Promise<{ ok: true; state: BriefState; brief: string } | Fail> {
  const me = await requireStaff();
  if (!UUID.test(id) || !adminConfigured()) return { ok: false, error: "That change isn't there." };
  const admin = createAdminClient();
  const { data: r } = await admin.from("brief_corrections").select("id, client_id, request_id, profile_id, kind, before, after, undone_at").eq("id", id).maybeSingle();
  if (!r || r.kind !== "correction") return { ok: false, error: "That change isn't there." };
  // Only someone who can see the client, and the one who made it or a lead
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", r.client_id).maybeSingle();
  if (!c) return { ok: false, error: "That change isn't there." };
  if (r.profile_id !== me.id && !canOverride(me)) return { ok: false, error: "Only whoever made the change, or a lead, can undo it." };
  const before = r.before as BriefState;
  const brief = briefOf(before);
  if (!r.undone_at) {
    await admin.from("brief_corrections").update({ undone_at: new Date().toISOString() }).eq("id", id);
    if (r.request_id) await admin.from("requests").update({ brief, title: before.title, audience: before.audience || null, sizes: before.sizes }).eq("id", r.request_id);
    await admin.from("agent_learnings").update({ status: "retired", note: "The correction was undone" }).eq("source_table", "brief_corrections").eq("source_id", id);
  }
  return { ok: true, state: before, brief };
}

/** "Mark reviewed": the stamp for this exact brief (any change after it needs a new review) */
export async function markBriefReviewed(t: BriefTarget): Promise<{ ok: true; stamp: ReviewStamp } | Fail> {
  const me = await requireStaff();
  const b = await load(t);
  if ("ok" in b) return b;
  if (!can(me, "brief", { formats: b.formats }).ok) return { ok: false, error: "Reviewing a brief is for the creative team in its format, the media buyers and the executives." };
  if (!b.brief.trim()) return { ok: false, error: "There's no brief to review yet." };
  if (!adminConfigured()) return { ok: false, error: "The database isn't connected here." };
  const { briefHash } = await import("@/lib/brief-check");
  const at = new Date().toISOString();
  const { error } = await createAdminClient().from("brief_corrections").insert({ client_id: b.clientId, request_id: b.requestId, suggestion_id: b.suggestionId, profile_id: me.id, kind: "review", brief_hash: briefHash(b.brief, b.sizes), format: b.formats.join(",") || null, created_at: at });
  if (error) return { ok: false, error: "Couldn't save the review." };
  return { ok: true, stamp: { by: me.fullName, at } };
}

/** A lead sends a blocked brief on anyway: which gates, and why (logged; holds for this exact brief) */
export async function overrideBriefGate(t: BriefTarget, gates: GateKey[], reason: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  if (!canOverride(me)) return { ok: false, error: "Sending a brief that isn't ready is for leads and the executives." };
  const why = reason.trim().slice(0, 600);
  if (why.length < 8) return { ok: false, error: "Say why it can go anyway (a few words at least)." };
  const keep = gates.filter((g): g is GateKey => ["facts", "assets", "conflicts"].includes(g));
  if (!keep.length) return { ok: false, error: "Nothing to override." };
  const b = await load(t);
  if ("ok" in b) return b;
  if (!adminConfigured()) return { ok: false, error: "The database isn't connected here." };
  const { briefHash } = await import("@/lib/brief-check");
  const { error } = await createAdminClient().from("brief_corrections").insert({ client_id: b.clientId, request_id: b.requestId, suggestion_id: b.suggestionId, profile_id: me.id, kind: "override", gates: keep, reason: why, brief_hash: briefHash(b.brief, b.sizes), format: b.formats.join(",") || null });
  return error ? { ok: false, error: "Couldn't save it." } : { ok: true };
}

/** A client-only fact answered right here (by someone who knows it): kept in the brief, with where it came from */
export async function answerBriefFact(t: BriefTarget, question: string, answer: string): Promise<{ ok: true; brief: string; state: BriefState } | Fail> {
  const me = await requireStaff();
  const b = await load(t);
  if ("ok" in b) return b;
  const ed = editable(me, b.formats);
  if ("ok" in ed) return ed;
  const a = answer.trim().slice(0, 600);
  if (!a) return { ok: false, error: "Type the answer." };
  const before = stateOf(b);
  const state: BriefState = { ...before, spec: answerFact(before.spec, question.slice(0, 300), a, `the team (${me.fullName.split(/\s+/)[0]})`) };
  const brief = composeBrief(state.overview, state.spec);
  if (adminConfigured()) {
    const admin = createAdminClient();
    await admin.from("brief_corrections").insert({ client_id: b.clientId, request_id: b.requestId, suggestion_id: b.suggestionId, profile_id: me.id, kind: "answer", instruction: question.slice(0, 300), reply: a, before, after: state });
    if (b.requestId) await admin.from("requests").update({ brief }).eq("id", b.requestId);
  }
  return { ok: true, brief, state };
}

/**
 * A client-only fact asked of the client: added to the Brand Bible's open questions, which routes it (the client in
 * their portal first, then the team member for that kind of question). The brief stays "Needs client input" until
 * the answer is put in it.
 */
export async function askClientFact(t: BriefTarget, question: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const b = await load(t);
  if ("ok" in b) return b;
  if (!adminConfigured()) return { ok: false, error: "The database isn't connected here." };
  const q = question.trim().slice(0, 300);
  if (!q) return { ok: false, error: "There's no question to ask." };
  const admin = createAdminClient();
  const { data: bible } = await admin.from("client_brand_bibles").select("open_questions").eq("client_id", b.clientId).maybeSingle();
  if (!bible) return { ok: false, error: "This client has no Brand Bible yet, so ask them directly." };
  const open = ((bible.open_questions ?? []) as { question: string; who?: string }[]).slice();
  const text = `[${factCategory(q)}] ${q} (for the brief "${b.title.slice(0, 80)}")`;
  if (!open.some((x) => x.question.includes(q))) {
    open.push({ question: text, who: "client" });
    await admin.from("client_brand_bibles").update({ open_questions: open }).eq("client_id", b.clientId);
    const { syncQuestions } = await import("@/lib/bible-questions");
    await syncQuestions(admin, b.clientId).catch((e) => console.error("[brief] ask client", e instanceof Error ? e.message : e));
  }
  await admin.from("brief_corrections").insert({ client_id: b.clientId, request_id: b.requestId, suggestion_id: b.suggestionId, profile_id: me.id, kind: "ask_client", instruction: q });
  return { ok: true };
}

export type LogEntry = { id: string; kind: string; by: string; at: string; instruction: string | null; reply: string | null; undone: boolean; diff: FieldDiff[]; reason: string | null };

/** What's been done to this brief: corrections (with what changed), answers, overrides and reviews, newest first */
export async function briefLog(t: BriefTarget): Promise<LogEntry[]> {
  await requireStaff();
  const b = await load(t);
  if ("ok" in b) return [];
  const db = await createClient();
  let q = db.from("brief_corrections").select("id, kind, instruction, reply, reason, before, after, undone_at, created_at, profiles(full_name)").eq("client_id", b.clientId).order("created_at", { ascending: false }).limit(30);
  if (b.requestId) q = q.eq("request_id", b.requestId);
  else if (b.suggestionId) q = q.eq("suggestion_id", b.suggestionId);
  else return [];
  const { data } = await q;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    by: ((r.profiles as unknown as { full_name?: string } | null)?.full_name ?? "Someone").trim(),
    at: r.created_at as string,
    instruction: (r.instruction as string | null) ?? null,
    reply: (r.reply as string | null) ?? null,
    undone: Boolean(r.undone_at),
    diff: r.before && r.after ? diffStates(r.before as BriefState, r.after as BriefState) : [],
    reason: (r.reason as string | null) ?? null,
  }));
}
