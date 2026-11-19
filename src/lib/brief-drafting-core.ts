// The system writes the creative briefs, the team approves them (Nov 19 2026): the pure rules, safe anywhere and
// tested in tests/brief-drafting.test.ts. The server side (drafting, approval, swaps) is src/lib/brief-drafting.ts.
//
// * Situational, never batched: a brief is drafted the moment there's a reason (a time-sensitive ask from the client,
//   hard fatigue, a KPI dropping), and pacing drafts fill the allotment along an even line through the client's
//   billing cycle, a weekly share at a time. An urgent brief may go over that week's share and says why; the pacing
//   drafts after it slow down, because what it takes counts against the line.
// * The iteration / net new mix follows the account: beating its targets 60% iterations of winners; behind 60% net
//   new; nothing working mostly net new.
// * Replacements never burn hours: only a brief not approved, or approved and not started, is swapped; work in
//   production or later keeps its slot unless a lead forces it, and then what's done is adapted, not restarted.
// * Priority: the client, then the media buyer, then the creative team.
// * Every brief cites its real reason (the call, the ad, the numbers), taken from the data that set it off, or it
//   isn't shown.

export type Trigger = "offer" | "fatigue" | "kpi" | "pacing";
export type Track = "iterate" | "net_new";
export type PerfState = "beating" | "behind" | "nothing" | "unknown";
export type AskedBy = "client" | "media_buyer" | "creative";

export type Mix = { track: Track; iterate: number; netNew: number; state: PerfState; reason: string };
export type Pace = { pool: "images" | "videos"; cap: number; weekShare: number; dueByWeekEnd: number; asked: number; takes: number; over: boolean; line: string };
export type Citation = { source: "call" | "slack" | "email" | "ad" | "numbers" | "pattern"; ref: string | null; quote: string; at: string | null; numbers: string | null };

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const days = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);
const whole = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));

// ─── The account's performance and the mix ─────────────────────────────────────────────────────────────────────

/** A KPI with no read (idle, being set up, no target) says nothing about the account */
const READ = new Set(["excellent", "good", "close", "off"]);

/** Where the account stands against its targets: every read KPI on target, all of them off, or in between */
export function accountState(kpis: readonly { status: string | null; trend?: string | null }[]): PerfState {
  const read = kpis.filter((k) => k.status && READ.has(k.status));
  if (!read.length) return "unknown";
  if (read.every((k) => k.status === "excellent" || k.status === "good")) return "beating";
  if (read.every((k) => k.status === "off")) return "nothing";
  return "behind";
}

/** The split the account's performance calls for, with the reason in words */
export function mixFor(state: PerfState): Omit<Mix, "track"> {
  if (state === "beating") return { state, iterate: 60, netNew: 40, reason: "The account is beating its targets: most of the work iterates on the winners, the rest tests new ideas." };
  if (state === "nothing") return { state, iterate: 20, netNew: 80, reason: "Nothing is hitting target: mostly net new, a different angle or offer framing, not more of what isn't working." };
  if (state === "behind") return { state, iterate: 40, netNew: 60, reason: "The account is behind its targets: most of the work is net new, with some iterations of what still works." };
  return { state, iterate: 50, netNew: 50, reason: "No KPI read yet: an even split until the numbers say otherwise." };
}

/**
 * Which track the next brief takes so the cycle's work keeps to the split: the one furthest under its share (counted
 * in briefs drafted or made this cycle). With nothing yet, the larger share.
 */
export function pickTrack(mix: Omit<Mix, "track">, so: { iterate: number; netNew: number }): Track {
  const total = so.iterate + so.netNew;
  if (!total) return mix.iterate > mix.netNew ? "iterate" : "net_new";
  const shortIterate = mix.iterate / 100 - so.iterate / total;
  const shortNew = mix.netNew / 100 - so.netNew / total;
  return shortIterate > shortNew ? "iterate" : "net_new";
}

export const TRACK_LABEL: Record<Track, string> = { iterate: "Iteration of a winner", net_new: "Net new" };

/** "Iteration of a winner · 60/40 because the account is beating its targets" */
export const mixLine = (m: Mix) => `${TRACK_LABEL[m.track]} · ${m.iterate}/${m.netNew} iterate/net new`;

// ─── Pacing: an even line through the billing cycle ────────────────────────────────────────────────────────────

/**
 * Where a pool stands against the even line this week. The cycle is cut into weeks from its start; by the end of the
 * week the client is in, this much of the cap should be asked for (all of it by the cycle's end). `asked` already
 * holds everything in the production line (the allotment view counts it once) and `open` is what drafts waiting on
 * approval would take: both count, so an urgent brief drafted this week leaves less room for pacing drafts after it.
 */
export function weekPace(p: { cap: number; asked: number; open: number; cycleStart: string; cycleEnd: string; today: string }) {
  const cap = whole(p.cap);
  const length = Math.max(1, days(p.cycleStart, p.cycleEnd));
  const gone = Math.max(0, Math.min(length - 1, days(p.cycleStart, p.today)));
  const week = Math.floor(gone / 7);
  const weekEnd = Math.min(length, (week + 1) * 7);
  // The last few days of a cycle belong to its last week: never a stub week that asks for the remainder at once
  const end = length - weekEnd < 4 ? length : weekEnd;
  const dueByWeekEnd = Math.min(cap, Math.ceil((cap * end) / length));
  const weekShare = Math.max(cap ? 1 : 0, Math.round((cap * 7) / length));
  const room = Math.max(0, dueByWeekEnd - whole(p.asked) - whole(p.open));
  return { week, weeks: Math.ceil(length / 7), weekShare, dueByWeekEnd, room, daysLeft: Math.max(0, days(p.today, p.cycleEnd)) };
}

/** How a brief taking `takes` sits against this week's room: over it on purpose (urgent) says so and why */
export function paceFor(pool: Pace["pool"], cap: number, w: ReturnType<typeof weekPace>, asked: number, takes: number, why: string | null): Pace {
  const over = takes > w.room;
  const word = pool === "videos" ? "video" : "image";
  const n = (x: number) => `${x} ${word}${x === 1 ? "" : "s"}`;
  const line = over
    ? `Over this week's share by ${n(takes - w.room)}${why ? `: ${why}` : ""}. The pacing drafts after it slow down to make room.`
    : `Within this week's share: ${n(asked)} of ${cap} asked, ${n(w.dueByWeekEnd)} due by the week's end (${n(w.weekShare)} a week).`;
  return { pool, cap, weekShare: w.weekShare, dueByWeekEnd: w.dueByWeekEnd, asked, takes, over, line };
}

/** What a pacing draft may take now: the week's room, never a batch (at most one brief's worth) */
export const pacingTake = (room: number, perBrief = 3) => Math.max(0, Math.min(room, perBrief));

// ─── Replacements ──────────────────────────────────────────────────────────────────────────────────────────────

export type SwapTarget = { kind: "draft" | "request" | "asana"; stage: string | null; status?: string | null };
export type SwapVerdict = "swap" | "adapt" | "never";

/**
 * Whether a piece can give its slot to a new brief: a draft still open, or an approved piece not started (the board's
 * first column) swaps freely; anything in production or later only when a lead forces it, and then it's adapted.
 */
export function swapVerdict(t: SwapTarget, forced: boolean): SwapVerdict {
  if (t.kind === "draft") return t.status === "open" ? "swap" : "never";
  if (t.stage === "requested") return "swap";
  if (t.stage === "launched") return "never";
  return forced ? "adapt" : "never";
}

/** Who may force a swap of work already in production: the creative leads and the executives */
export const canForceSwap = (me: { role: string | null | undefined; isExec?: boolean | null }) => Boolean(me.isExec) || me.role === "head_of_creative" || me.role === "lead_graphic_designer" || me.role === "lead_video_editor";

/** Three or more swaps in one billing cycle: the leads hear the client is churning the work */
export const CHURN_SWAPS = 3;
export const churning = (swapsThisCycle: number) => swapsThisCycle >= CHURN_SWAPS;

export const ASKED_RANK: Record<AskedBy, number> = { client: 0, media_buyer: 1, creative: 2 };
export const ASKED_LABEL: Record<AskedBy, string> = { client: "The client asked", media_buyer: "The media buyer asked", creative: "The creative team's idea" };

/** A new ask may take a slot from an existing one only when it ranks the same or higher (client > buyer > creative) */
export const outranks = (incoming: AskedBy, existing: AskedBy) => ASKED_RANK[incoming] <= ASKED_RANK[existing];

// ─── Approvers ─────────────────────────────────────────────────────────────────────────────────────────────────

const APPROVER_ROLES = new Set(["head_of_creative", "lead_video_editor", "lead_graphic_designer", "head_of_meta"]);

/** Who can push a drafted brief through, by role: the creative leads, the head of Meta, the executives, and the account's own Meta buyer */
export function canApprove(me: { role: string | null | undefined; isExec?: boolean | null }, buyerOf: ReadonlySet<string>, clientId: string) {
  return Boolean(me.isExec) || APPROVER_ROLES.has(me.role ?? "") || buyerOf.has(clientId);
}

/** The creative leads a new draft is for: the head of creative always, the lead of the format's makers */
export function leadsFor(formats: readonly string[]): string[] {
  const out = new Set(["head_of_creative"]);
  if (formats.some((f) => f === "video")) out.add("lead_video_editor");
  if (formats.some((f) => f === "image" || f === "carousel")) out.add("lead_graphic_designer");
  return [...out];
}

// ─── Quality: the real reason ──────────────────────────────────────────────────────────────────────────────────

/**
 * A brief is shown only with its real reason: a quote from the call or message, the ad and its numbers, or the
 * numbers themselves. Taken from the data that set it off (never the AI's words), so a generic idea ("a video
 * answering the price objection") has nothing to cite and never reaches anyone.
 */
export function hasRealReason(c: Partial<Citation> | null | undefined): boolean {
  if (!c || !c.source || !c.quote) return false;
  const quote = c.quote.trim();
  if (quote.length < 12) return false;
  if (c.source === "call" || c.source === "slack" || c.source === "email") return Boolean(c.at);
  // An ad, a pattern or the numbers: it has to carry a number
  return /\d/.test(`${quote} ${c.numbers ?? ""}`);
}

// ─── Deadlines and order ───────────────────────────────────────────────────────────────────────────────────────

/** "Due today", "Due tomorrow", "Due in 4 days", "Past due" */
export function dueLabel(deadline: string | null | undefined, today: string): string | null {
  if (!deadline) return null;
  const d = days(today, deadline.slice(0, 10));
  if (d < 0) return "Past due";
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  if (d <= 6) return `Due in ${d} days`;
  return `Due ${new Date(`${deadline.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** A deadline the AI read from a message, held to a real date from today to 120 days out (else none) */
export function cleanDeadline(raw: string | null | undefined, today: string): string | null {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== raw) return null;
  const d = days(today, raw);
  return d >= 0 && d <= 120 ? raw : null;
}

const TRIGGER_RANK: Record<string, number> = { offer: 0, call: 0, fatigue: 1, kpi: 2, pacing: 3 };

export type ReadyItem = { id: string; clientId: string; client: string; kind: string; urgent: boolean; deadline: string | null; askedBy: AskedBy | null; createdAt: string };

/** Most urgent first: the nearest deadline, then urgent, then whose ask (client first), then why, then oldest */
export function readyOrder(a: ReadyItem, b: ReadyItem): number {
  const da = a.deadline ? utc(a.deadline) : Infinity;
  const db = b.deadline ? utc(b.deadline) : Infinity;
  if (da !== db) return da - db;
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  const ra = ASKED_RANK[a.askedBy ?? "creative"];
  const rb = ASKED_RANK[b.askedBy ?? "creative"];
  if (ra !== rb) return ra - rb;
  const ka = TRIGGER_RANK[a.kind] ?? 4;
  const kb = TRIGGER_RANK[b.kind] ?? 4;
  if (ka !== kb) return ka - kb;
  return a.createdAt.localeCompare(b.createdAt);
}

/** Grouped by client, each group in order and the groups by their most urgent brief */
export function groupByClient<T extends ReadyItem>(items: readonly T[]): { clientId: string; client: string; items: T[] }[] {
  const sorted = [...items].sort(readyOrder);
  const groups = new Map<string, { clientId: string; client: string; items: T[] }>();
  for (const i of sorted) {
    const g = groups.get(i.clientId) ?? { clientId: i.clientId, client: i.client, items: [] };
    g.items.push(i);
    groups.set(i.clientId, g);
  }
  return [...groups.values()];
}

/** The ISO week a day is in ("2026-W47"): a KPI drop drafts at most once a week */
export function isoWeek(day: string): string {
  const d = new Date(utc(day));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const n = 1 + Math.round(((d.getTime() - first.getTime()) / DAY - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}
