import { bizDays } from "@/lib/production";
import { baseRole } from "@/lib/roles";

// The team KPI boards as plain functions (no database), so the rules are tested on their own: who belongs on each tab
// (by role, team and client seat, never by name), matching an Asana name to a teammate, the metric math the cards show
// (rates, pushback, report timeliness, how early requests come in, how long work sits with someone) and reading the
// error classifier's answer. The Email Team KPIs have Design, Build, Copy and Strategy; the Creative Team KPIs have
// Design, Video and Copy. Execs and the heads of each line are never on these boards: they're the ones reading them,
// and their own billable time lives in Kaizen Track.

export type TeamBoard = "email" | "creative";
export type EmailTab = "design" | "build" | "copy" | "strategy";
export type CreativeTab = "design" | "video" | "copy";
export type TeamTab = EmailTab | CreativeTab;

export const EMAIL_TABS: readonly { key: EmailTab; label: string }[] = [
  { key: "design", label: "Design" },
  { key: "build", label: "Build" },
  { key: "copy", label: "Copy" },
  { key: "strategy", label: "Strategy" },
];
export const CREATIVE_TABS: readonly { key: CreativeTab; label: string }[] = [
  { key: "design", label: "Design" },
  { key: "video", label: "Video" },
  { key: "copy", label: "Copy" },
];

export const TEAM_BOARD_TITLE: Record<TeamBoard, string> = { email: "Email Team KPIs", creative: "Creative Team KPIs" };

/** The tab asked for in the address (an older ?view=copy-kpis link is the Copy tab), or the first one */
export function tabOf(board: "email", view: unknown, tab: unknown): EmailTab;
export function tabOf(board: "creative", view: unknown, tab: unknown): CreativeTab;
export function tabOf(board: TeamBoard, view: unknown, tab: unknown): TeamTab {
  const list = board === "email" ? EMAIL_TABS : CREATIVE_TABS;
  if (view === "copy-kpis") return "copy";
  return list.find((t) => t.key === tab)?.key ?? "design";
}

/** A tab's address (the board's KPI view with the tab in the URL) */
export const tabHref = (board: TeamBoard, tab: TeamTab, period?: string | null) => `${board === "email" ? "/board/email" : "/board"}?view=kpis&tab=${tab}${period && period !== "cycle" ? `&period=${period}` : ""}`;

// ─── Who belongs where ────────────────────────────────────────────────────────

export type TeamPerson = { id: string; role: string; is_exec?: boolean | null; also_designs_email?: boolean | null };
export type SeatLite = { profile_id: string; role: string };

/** Execs and the heads of a line never appear on a team board (they read it); neither does whoever is looking */
export const offBoard = (p: TeamPerson, viewerId?: string | null) => Boolean(p.is_exec) || p.role === "executive" || p.role.startsWith("head_of_") || (viewerId != null && p.id === viewerId);

/**
 * The people on one tab, by role first and client seat second (a seat only counts for someone whose role is on that
 * line: a video editor holding no email role never lands on an email tab, whatever was credited to them).
 *  Email · Design: email designers, and builders who also design (the flag, or an email designer seat)
 *        · Build: email builders · Copy and Strategy: email strategists
 *  Creative · Design: graphic designers (lead included) · Video: video editors (lead included) · Copy: copywriters
 */
export function membersOf(board: TeamBoard, tab: TeamTab, people: readonly TeamPerson[], seats: readonly SeatLite[] = [], viewerId?: string | null): Set<string> {
  const designSeat = new Set(seats.filter((s) => s.role === "email_designer").map((s) => s.profile_id));
  const out = new Set<string>();
  for (const p of people) {
    if (offBoard(p, viewerId)) continue;
    const r = baseRole(p.role);
    const on =
      board === "email"
        ? tab === "design"
          ? r === "email_designer" || (r === "email_builder" && (Boolean(p.also_designs_email) || designSeat.has(p.id)))
          : tab === "build"
            ? r === "email_builder"
            : tab === "copy" || tab === "strategy"
              ? r === "email_strategist"
              : false
        : tab === "design"
          ? r === "graphic_designer"
          : tab === "video"
            ? r === "video_editor"
            : tab === "copy"
              ? r === "copywriter"
              : false;
    if (on) out.add(p.id);
  }
  return out;
}

/** Everyone on the board's team (every tab together): the workload shows all of them, strategists too */
export function teamOf(board: TeamBoard, people: readonly TeamPerson[], seats: readonly SeatLite[] = [], viewerId?: string | null): Set<string> {
  const tabs = board === "email" ? EMAIL_TABS : CREATIVE_TABS;
  const out = new Set<string>();
  for (const t of tabs) for (const id of membersOf(board, t.key, people, seats, viewerId)) out.add(id);
  return out;
}

// ─── Matching a name from Asana to a teammate ─────────────────────────────────

/** Lower case, accents dropped, single spaces ("Andrés  Cortez" is "andres cortez") */
export const normName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const related = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * The teammate an Asana name means, or null. First names must agree (one may be short for the other); when both have
 * a last name those must agree too (and with a first name alone the first names must be the same), so "Danielis Beltran" is the email designer "Dani Beltran", never the video editor
 * "Daniel". The closest match wins (a full name over a first name alone), and someone on the board's line (`prefer`)
 * over anyone else; two equally close people is no match at all.
 */
export function matchPerson<T extends { id: string; full_name: string }>(name: string | null | undefined, people: readonly T[], prefer?: (p: T) => boolean): T | null {
  if (!name) return null;
  const want = normName(name).split(" ").filter(Boolean);
  if (!want.length) return null;
  let best: { p: T; score: number } | null = null;
  let tie = false;
  for (const p of people) {
    const have = normName(p.full_name).split(" ").filter(Boolean);
    if (!have.length || !related(want[0], have[0])) continue;
    const bothLast = want.length > 1 && have.length > 1;
    if (bothLast && !related(want.at(-1)!, have.at(-1)!)) continue;
    // With a first name alone on either side, the first names must be the same (a shortened one needs the last name to agree)
    if (!bothLast && want[0] !== have[0]) continue;
    let score = want[0] === have[0] ? 4 : 2;
    if (bothLast) score += want.at(-1) === have.at(-1) ? 6 : 3;
    if (prefer?.(p)) score += 1;
    if (!best || score > best.score) {
      best = { p, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  return best && !tie ? best.p : null;
}

// ─── The cards' math ──────────────────────────────────────────────────────────

/** A whole-number percentage, or null with nothing to divide */
export const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);

/** The middle value (null when empty) */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** How a number moved: up, down or flat (a change under `flat` counts as flat) */
export const trendOf = (now: number | null, before: number | null, flat = 1): "up" | "down" | "flat" | null => (now == null || before == null ? null : now - before > flat ? "up" : before - now > flat ? "down" : "flat");

/** Business days of lead an email request needs before its send date: every stage on the way (copy, design, review, client, revisions, build, send) */
export const REQUEST_LEAD_DAYS = 9;

/**
 * How early a request came in against its send date: on time when it left the team the full lead, otherwise the
 * business days it was short. Null when there's no send date to measure against.
 */
export function requestTimeliness(createdAt: string, sendOn: string | null, lead = REQUEST_LEAD_DAYS): { onTime: boolean; short: number; lead: number } | null {
  if (!sendOn) return null;
  const due = `${sendOn.slice(0, 10)}T17:00:00-05:00`;
  const have = Math.round(bizDays(createdAt, due) * 10) / 10;
  return { onTime: have >= lead, short: Math.max(0, Math.round((lead - have) * 10) / 10), lead: have };
}

/** When a client report is due: the weekly two days after its week ends (Tuesday), the monthly three business days after the month */
export function reportDue(kind: "weekly" | "monthly", periodEnd: string): string {
  const end = new Date(`${periodEnd.slice(0, 10)}T12:00:00Z`);
  if (kind === "weekly") return new Date(end.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  let left = 3;
  const d = new Date(end);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Reports sent on time against late, weekly and monthly together. A report counts once its due day has passed or it
 * was sent: sent by the end of its due day (New York) is on time; sent after, or still not sent past it, is late.
 */
export function reportTimeliness(reports: readonly { kind: string; periodEnd: string; postedAt: string | null; status?: string | null }[], today: string): { onTime: number; late: number; rate: number | null; lateItems: { kind: string; periodEnd: string; due: string; postedAt: string | null }[] } {
  let onTime = 0;
  const lateItems: { kind: string; periodEnd: string; due: string; postedAt: string | null }[] = [];
  for (const r of reports) {
    if (r.status === "skipped" || (r.kind !== "weekly" && r.kind !== "monthly")) continue;
    const due = reportDue(r.kind, r.periodEnd);
    const sentDay = r.postedAt ? new Date(r.postedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null;
    if (sentDay && sentDay <= due) onTime++;
    else if (sentDay || today > due) lateItems.push({ kind: r.kind, periodEnd: r.periodEnd, due, postedAt: r.postedAt });
  }
  return { onTime, late: lateItems.length, rate: pct(onTime, onTime + lateItems.length), lateItems };
}

/** Replies owed on Slack and email: median hours to answer, and how many still wait (from the owed replies) */
export function replyStats(rows: readonly { asked_at: string; answered_at: string | null; status: string }[]): { medianHours: number | null; answered: number; waiting: number; escalated: number } {
  const hours = rows.filter((r) => r.status === "answered" && r.answered_at).map((r) => Math.max(0, (Date.parse(r.answered_at!) - Date.parse(r.asked_at)) / 3_600_000));
  const m = median(hours);
  return { medianHours: m == null ? null : Math.round(m * 10) / 10, answered: hours.length, waiting: rows.filter((r) => ["watching", "nudged", "escalated"].includes(r.status)).length, escalated: rows.filter((r) => r.status === "escalated").length };
}

/**
 * Whether a client's email numbers can be trusted on the sending cycle: only a connection that's reading on time is.
 * Anything else says so in words (never a silent zero sent): not connected, waiting on its first read, an API error,
 * or no read for over a day.
 */
export function syncOf(state: "connected" | "behind" | "pending" | "failing" | "missing", provider: string, lastSyncedAt: string | null, error: string | null): { ok: boolean; label: string; detail: string | null } {
  if (state === "connected") return { ok: true, label: `${provider} syncing`, detail: null };
  if (state === "missing") return { ok: false, label: "No email platform connected", detail: "Sends can't be counted until the client's email platform is connected." };
  if (state === "pending") return { ok: false, label: `${provider} connected, first read not done`, detail: error };
  const when = lastSyncedAt ? new Date(lastSyncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : null;
  if (state === "behind") return { ok: false, label: when ? `${provider} hasn't synced since ${when}` : `${provider} isn't syncing`, detail: error };
  return { ok: false, label: `${provider} isn't syncing`, detail: error ?? "The last read failed." };
}

// ─── The error classifier's answer ────────────────────────────────────────────

export type ErrorVerdict = "error" | "preference" | "unclear";
export type ParsedVerdict = { index: number; verdict: ErrorVerdict; type: string | null };

/**
 * The classifier's items, made safe: only indexes inside the batch, each once (the first answer kept), a verdict the
 * schema allows (anything else is "unclear"), and an error type kept short ("Error" when it gave none). Accepts the
 * parsed object or its JSON text, possibly wrapped in a code fence.
 */
export function parseVerdicts(raw: unknown, batchSize: number): ParsedVerdict[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    const text = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      return [];
    }
  }
  const items = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : [];
  const seen = new Set<number>();
  const out: ParsedVerdict[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as { i?: unknown; verdict?: unknown; type?: unknown };
    const index = typeof o.i === "number" ? o.i : typeof o.i === "string" && /^\d+$/.test(o.i) ? Number(o.i) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= batchSize || seen.has(index)) continue;
    seen.add(index);
    const verdict: ErrorVerdict = o.verdict === "error" || o.verdict === "preference" ? o.verdict : "unclear";
    const type = verdict === "error" ? String(o.type ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Error" : null;
    out.push({ index, verdict, type });
  }
  return out;
}
