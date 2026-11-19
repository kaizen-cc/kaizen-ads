import { stageInfo, type Stage } from "@/lib/stages";
import { emailStageInfo, type EmailStage } from "@/lib/email-board-core";

// A client changing direction mid-production: the pure parts (no keys, no network), shared by the cron, the sheet,
// the boards, the assistant and the tests. Which tasks count as open, where each flagged task should go back to, how
// the AI's answer is checked, and who hears about it.

export type TaskKind = "asana_creative" | "asana_email" | "creative" | "email";
export type Fix = "design" | "copy" | "both" | "brief" | "stop";
export type Verdict = "affected" | "maybe";
export type TaskAction = "pending" | "sent_back" | "kept" | "stopped";
export type ChangeKind = "offer" | "priority" | "stop" | "product" | "messaging" | "audience" | "other";
export type ChangeSource = "slack" | "gmail" | "portal" | "call" | "team" | "assistant";

export const TASK_KINDS: readonly TaskKind[] = ["asana_creative", "asana_email", "creative", "email"];
export const FIXES: readonly Fix[] = ["design", "copy", "both", "brief", "stop"];
export const CHANGE_KINDS: readonly ChangeKind[] = ["offer", "priority", "stop", "product", "messaging", "audience", "other"];
export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = { offer: "Offer or price", priority: "Campaign focus", stop: "Stopped", product: "Product", messaging: "Messaging", audience: "Audience", other: "Direction" };
export const SOURCE_LABEL: Record<ChangeSource, string> = { slack: "Slack", gmail: "Email", portal: "Portal chat", call: "Call", team: "Logged by the team", assistant: "Logged on a call with the assistant" };

/** The board a task is on: the creative board (Kaizen or Asana's Creative project) or the email one */
export const lineOf = (k: TaskKind): "creative" | "email" => (k === "creative" || k === "asana_creative" ? "creative" : "email");
export const isAsana = (k: TaskKind) => k === "asana_creative" || k === "asana_email";

/** Where each stage sits in its flow (client changes and revisions are making it again) */
const CREATIVE_RANK: Partial<Record<Stage, number>> = { requested: 0, in_production: 1, client_revision: 1, internal_review: 2, copy: 3, copy_review: 4, ready_for_client: 5, client_review: 5, ready_for_launch: 6, launched: 7 };
const EMAIL_RANK: Record<EmailStage, number> = { copy_review: 0, ready_for_design: 1, revisions: 1, for_review: 2, with_client: 3, ready_for_build: 4, ready_to_send: 5, live: 6 };
const rankOf = (kind: TaskKind, stage: string | null) => (stage == null ? -1 : lineOf(kind) === "creative" ? (CREATIVE_RANK[stage as Stage] ?? -1) : (EMAIL_RANK[stage as EmailStage] ?? -1));

/** The first stage of each board: work there hasn't started, so a change is a brief update */
export const FIRST_STAGE = { creative: "requested", email: "copy_review" } as const;

/** Stages a task can be sent back to, per board, in order */
export const BACK_STAGES = {
  creative: ["requested", "in_production", "copy"] as Stage[],
  email: ["copy_review", "ready_for_design"] as EmailStage[],
};

export function stageLabel(kind: TaskKind, stage: string | null): string {
  if (!stage) return "No column";
  if (lineOf(kind) === "creative") return stageInfo(stage as Stage)?.label ?? stage.replace(/_/g, " ");
  return emailStageInfo(stage as EmailStage)?.label ?? stage.replace(/_/g, " ");
}

/** With the client right now: the client is looking at work they already said to change */
export const withClient = (kind: TaskKind, stage: string | null) => (lineOf(kind) === "creative" ? stage === "client_review" || stage === "ready_for_client" : stage === "with_client");

/**
 * Where a flagged task should go back to, given what has to change:
 * - not started (the board's first column): the brief is updated where it is
 * - copy only: creative goes to Copy, email to Copy for review
 * - design (the offer on the image, the wrong theme or product): creative to In production, email to Ready for design
 * - both: creative to In production (the copy follows the new design), email to Copy for review (copy comes first)
 * - stop: the campaign is gone and nothing can be adapted
 * When the task is already at or before that stage it stays where it is and gets the note (stage null).
 */
export function suggestStage(kind: TaskKind, stage: string | null, fix: Fix): { fix: Fix; stage: string | null } {
  if (fix === "stop") return { fix, stage: null };
  const line = lineOf(kind);
  if (stage === FIRST_STAGE[line] || fix === "brief") return { fix: "brief", stage: null };
  const target = line === "creative" ? (fix === "copy" ? "copy" : "in_production") : fix === "design" ? "ready_for_design" : "copy_review";
  // Already at or before it: it stays and gets the note
  if (rankOf(kind, stage) >= 0 && rankOf(kind, stage) <= rankOf(kind, target)) return { fix, stage: null };
  return { fix, stage: target };
}

/** The button a flagged task's suggestion reads as */
export function actionLabel(kind: TaskKind, fix: Fix, suggested: string | null): string {
  if (fix === "stop") return "Stop";
  if (!suggested) return fix === "brief" ? "Update the brief" : "Add the note";
  return `Send back to ${stageLabel(kind, suggested)}`;
}

/** Whether a task is still open work, from its row (the same rules the cron reads with) */
export function isOpenTask(kind: TaskKind, row: Record<string, unknown>): boolean {
  if (kind === "asana_creative") return row.open !== false && row.request_id == null && row.stage != null;
  if (kind === "asana_email") return row.open !== false && row.ticket_id == null && row.completed_at == null && row.stage != null;
  if (kind === "creative") return row.deleted_at == null && row.stage !== "launched";
  return row.deleted_at == null && row.stage !== "live";
}

// ─── The AI's answer ─────────────────────────────────────────────────────────

/** No em dashes in anything a person reads */
export const noDash = (s: string) => s.replace(/\s*—\s*/g, ", ").replace(/–/g, "-").replace(/,\s*,/g, ",").trim();
const text = (v: unknown, max: number) => noDash(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, max);

export type RawTaskVerdict = { n: number; verdict: string; fix: string; why: string };
export type RawChange = { kind: string; scope?: string; lines?: string[]; summary: string; was: string; now: string; quote: string; message: number; tasks: RawTaskVerdict[] };

/**
 * Whose work a change is about: the team's section on the client page it's kept in. "ads" (paid ads in general) is
 * every paid platform's section.
 */
export const CHANGE_LINES = ["meta", "google", "tiktok", "creative", "email", "social"] as const;
export type ChangeLineId = (typeof CHANGE_LINES)[number];
/**
 * direction: what several pieces or all future work should say or show (an offer, a focus, a product dropped).
 * revision: an edit to one piece in progress (a price, a product list, a description on that email or ad): flagged on
 * that task for whoever holds it, never shown as the client changing direction.
 */
export type ChangeScope = "direction" | "revision";

/** The AI's lines, checked ("ads" is every paid platform), plus the lines of the tasks it touches */
export function changeLines(raw: unknown, tasks: readonly { kind: TaskKind }[]): ChangeLineId[] {
  const out = new Set<ChangeLineId>();
  for (const l of Array.isArray(raw) ? raw : []) {
    const v = String(l ?? "").toLowerCase().trim();
    if (v === "ads" || v === "paid") ["meta", "google", "tiktok"].forEach((x) => out.add(x as ChangeLineId));
    else if ((CHANGE_LINES as readonly string[]).includes(v)) out.add(v as ChangeLineId);
  }
  for (const t of tasks) out.add(lineOf(t.kind));
  return CHANGE_LINES.filter((l) => out.has(l));
}

export type OpenTask = { kind: TaskKind; ref: string; title: string; stage: string | null; notes?: string | null; assigneeId?: string | null; assigneeName?: string | null; url?: string | null; number?: number | null };
export type FlaggedTask = { kind: TaskKind; ref: string; title: string; stage: string | null; verdict: Verdict; fix: Fix; suggested: string | null; why: string; assigneeId: string | null };
export type CleanChange = { kind: ChangeKind; scope: ChangeScope; lines: ChangeLineId[]; summary: string; was: string; now: string; quote: string; message: number | null; tasks: FlaggedTask[] };

/**
 * The AI's changes checked: a real summary, a known kind, a message that exists, tasks from the list only (each once,
 * the strongest verdict kept), and the stage worked out here from the fix, never taken from the model.
 */
export function cleanDetection(raw: { changes?: unknown } | null | undefined, tasks: readonly OpenTask[], messageCount: number): CleanChange[] {
  const list = Array.isArray(raw?.changes) ? (raw!.changes as Partial<RawChange>[]) : [];
  const out: CleanChange[] = [];
  for (const c of list.slice(0, 5)) {
    const summary = text(c.summary, 160);
    if (!summary) continue;
    const kind = (CHANGE_KINDS as readonly string[]).includes(String(c.kind)) ? (c.kind as ChangeKind) : "other";
    const m = Number(c.message);
    const message = Number.isInteger(m) && m >= 1 && m <= messageCount ? m : null;
    const byTask = new Map<string, FlaggedTask>();
    for (const t of Array.isArray(c.tasks) ? c.tasks : []) {
      const task = tasks[Number(t?.n) - 1];
      if (!task || !Number.isInteger(Number(t?.n))) continue;
      const verdict: Verdict = t.verdict === "maybe" ? "maybe" : t.verdict === "affected" ? "affected" : "maybe";
      const wanted = (FIXES as readonly string[]).includes(String(t.fix)) ? (t.fix as Fix) : "design";
      const s = suggestStage(task.kind, task.stage, wanted);
      const key = `${task.kind}:${task.ref}`;
      const prev = byTask.get(key);
      if (prev && (prev.verdict === "affected" || verdict === "maybe")) continue;
      byTask.set(key, { kind: task.kind, ref: task.ref, title: task.title, stage: task.stage, verdict, fix: s.fix, suggested: s.stage, why: text(t.why, 240) || "Touched by the change.", assigneeId: task.assigneeId ?? null });
    }
    const flagged = [...byTask.values()];
    // A revision belongs to the piece it's about: with no open piece to put it on, it's a change for the line instead
    const scope: ChangeScope = c.scope === "revision" && flagged.length ? "revision" : "direction";
    out.push({ kind, scope, lines: changeLines(c.lines, flagged), summary, was: text(c.was, 300), now: text(c.now, 300), quote: text(c.quote, 300), message, tasks: flagged });
  }
  return out;
}

// ─── Who hears about it ──────────────────────────────────────────────────────

export type Seat = { profile_id: string; role: string; is_primary?: boolean | null };

/**
 * One notification per person per change: the client's media buyer, the email strategist when email work is touched,
 * the Head of Creative when creative work is, everyone holding a flagged task, and customer success (the coordinator
 * seat) when a flagged task is with the client. Critical when the client is looking at work they said to change. With
 * nobody at all, the execs.
 */
export function recipientsFor(input: { seats: readonly Seat[]; headsOfCreative: readonly string[]; execs: readonly string[]; tasks: readonly Pick<FlaggedTask, "kind" | "stage" | "assigneeId" | "verdict">[]; lines?: readonly ChangeLineId[]; scope?: ChangeScope }): { ids: string[]; critical: boolean } {
  const ids = new Set<string>();
  const seat = (role: string) => input.seats.filter((s) => s.role === role).map((s) => s.profile_id);
  // A revision to one piece: whoever holds it (the line's strategist or lead when nobody does), nobody else
  if (input.scope === "revision") {
    for (const t of input.tasks) if (t.assigneeId) ids.add(t.assigneeId);
    if (!ids.size) {
      if (input.tasks.some((t) => lineOf(t.kind) === "email")) for (const id of seat("email_strategist")) ids.add(id);
      if (input.tasks.some((t) => lineOf(t.kind) === "creative")) for (const id of input.headsOfCreative) ids.add(id);
    }
    return { ids: [...ids].filter(Boolean), critical: false };
  }
  // The team the change is about: each platform's buyer for its ads (Meta's for creative too: it runs in their ads),
  // the social manager for social, never a buyer for email or social alone
  const known = input.lines ?? [];
  if (!known.length || known.includes("meta") || known.includes("creative") || input.tasks.some((t) => lineOf(t.kind) === "creative")) for (const id of seat("meta_buyer")) ids.add(id);
  if (known.includes("google")) for (const id of seat("google_buyer")) ids.add(id);
  if (known.includes("tiktok")) for (const id of seat("tiktok_buyer")) ids.add(id);
  if (known.includes("social")) for (const id of seat("social_manager")) ids.add(id);
  const lines = new Set<string>([...input.tasks.map((t) => lineOf(t.kind)), ...known.filter((l) => l === "email" || l === "creative")]);
  if (lines.has("email")) for (const id of seat("email_strategist")) ids.add(id);
  if (lines.has("creative")) for (const id of input.headsOfCreative) ids.add(id);
  for (const t of input.tasks) if (t.assigneeId) ids.add(t.assigneeId);
  const critical = input.tasks.some((t) => t.verdict === "affected" && withClient(t.kind, t.stage));
  if (input.tasks.some((t) => withClient(t.kind, t.stage))) for (const id of seat("coordinator")) ids.add(id);
  if (!ids.size) for (const id of input.execs) ids.add(id);
  return { ids: [...ids].filter(Boolean), critical };
}

/** "4 tasks to adapt" (pending ones only) */
export const tasksLine = (n: number) => (n === 1 ? "1 task to adapt" : `${n} tasks to adapt`);

/** Whether every flagged task has been acted on (the change is then handled) */
export const allActed = (tasks: readonly { action: TaskAction }[]) => tasks.length > 0 && tasks.every((t) => t.action !== "pending");

/** The note a sent-back task carries (on the Kaizen timeline, or as an Asana comment) */
export function directionNote(c: { summary: string; quote?: string | null; was?: string | null; now?: string | null; scope?: string | null }, t: { fix: Fix; why?: string | null }, extra?: string | null): string {
  const what = t.fix === "copy" ? "Change the copy" : t.fix === "design" ? "Change the design" : t.fix === "both" ? "Change the design and the copy" : t.fix === "brief" ? "Update the brief before starting" : "Check before finishing";
  const lines = [
    c.scope === "revision" ? `The client asked for a revision: ${c.summary}.` : `The client changed direction: ${c.summary}.`,
    c.was && c.now ? `Was: ${c.was}. Now: ${c.now}.` : null,
    c.quote ? `In their words: "${c.quote}"` : null,
    t.why ? `For this one: ${t.why}` : null,
    `${what}: adapt what's made rather than starting over.`,
    extra?.trim() ? `Note: ${extra.trim()}` : null,
  ];
  return noDash(lines.filter(Boolean).join("\n").replace(/\.\./g, "."));
}
