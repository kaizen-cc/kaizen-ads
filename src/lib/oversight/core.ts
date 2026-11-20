import type { ReviewLine } from "@/lib/line-review/core";

// Accountability and money, the pure part (no database, no keys).
//
// The weekly scorecard: per buyer or strategist, and per line head: missed commitments, unapproved changes, silent
// accounts, at-risk accounts, and accounts per person (load balance). Execs see everyone; a head sees their line.
//
// Account economics (execs only, never in Slack or anything a client sees): each client's fee from Stripe (through
// Kaizen Track), what it costs us in hours (Track's time entries at each person's cost rate), paid, unpaid or overdue,
// failed or never-collected invoices, and the flags: losing money, underpriced, billed with no work done, unpaid.

// ─── Scorecard ──────────────────────────────────────────────────────────────

/** The line a position works on (the heads included); null for everyone the scorecard doesn't rank */
export function lineOfRole(role: string | null | undefined): ReviewLine | null {
  switch (role) {
    case "media_buyer":
    case "head_of_meta":
      return "meta";
    case "google_buyer":
    case "head_of_google":
      return "google";
    case "email_strategist":
    case "head_of_email":
      return "email";
    case "social_media_manager":
    case "head_of_social":
      return "social";
    default:
      return null;
  }
}
export const isHeadRole = (role: string | null | undefined) => role === "head_of_meta" || role === "head_of_google" || role === "head_of_email" || role === "head_of_social";

/** The seats that count as owning an account on each line */
export const OWNING_SEATS: Record<ReviewLine, string[]> = { meta: ["meta_buyer", "tiktok_buyer"], google: ["google_buyer"], email: ["email_strategist"], social: ["social_manager"] };

export type ScorePerson = { id: string; name: string; role: string; active: boolean };
export type ScoreInput = {
  people: readonly ScorePerson[];
  /** Live clients' owning seats */
  seats: readonly { client_id: string; profile_id: string; role: string }[];
  /** Commitments past due: promises (owner), owed replies (who owes it), call commitments (routed to) */
  missed: readonly { profile_id: string; client_id: string | null }[];
  /** Open watch flags by client: unapproved_change, quiet_channel */
  flags: readonly { client_id: string; kind: string; line: string | null }[];
  /** Clients at retention risk (dated risk notes) */
  atRisk: ReadonlySet<string>;
};

export type ScoreRow = {
  id: string;
  name: string;
  role: string;
  line: ReviewLine | null;
  head: boolean;
  accounts: number;
  missed: number;
  unapproved: number;
  silent: number;
  atRisk: number;
  /** Higher is worse (sorts the card) */
  score: number;
  /** The head's line totals, people in it, and the busiest and lightest load */
  team?: { people: number; accounts: number; missed: number; unapproved: number; silent: number; atRisk: number; busiest: number; lightest: number };
};

const SERVICE_LINE: Record<string, ReviewLine> = { "facebook-ads": "meta", "tiktok-ads": "meta", "google-ads": "google", "email-marketing": "email", "social-media": "social" };

/** How much to worry about a person's week: missed commitments and unapproved changes weigh most */
export const scoreOf = (r: Pick<ScoreRow, "missed" | "unapproved" | "silent" | "atRisk">) => r.missed * 3 + r.unapproved * 4 + r.silent * 2 + r.atRisk * 2;

/** One row per active buyer, strategist and head; heads carry their line's totals */
export function scorecard(i: ScoreInput): ScoreRow[] {
  const rows = new Map<string, ScoreRow>();
  for (const p of i.people) {
    const line = lineOfRole(p.role);
    if (!p.active || !line) continue;
    rows.set(p.id, { id: p.id, name: p.name, role: p.role, line, head: isHeadRole(p.role), accounts: 0, missed: 0, unapproved: 0, silent: 0, atRisk: 0, score: 0 });
  }
  // Each person's accounts on their own line (a buyer seated on another line counts there too)
  const mine = new Map<string, Map<ReviewLine, Set<string>>>();
  for (const s of i.seats) {
    const line = (Object.keys(OWNING_SEATS) as ReviewLine[]).find((l) => OWNING_SEATS[l].includes(s.role));
    if (!line || !rows.has(s.profile_id)) continue;
    const m = mine.get(s.profile_id) ?? new Map<ReviewLine, Set<string>>();
    m.set(line, (m.get(line) ?? new Set()).add(s.client_id));
    mine.set(s.profile_id, m);
  }
  const clientsOf = (id: string) => new Set([...(mine.get(id)?.values() ?? [])].flatMap((x) => [...x]));
  for (const r of rows.values()) {
    const cs = clientsOf(r.id);
    r.accounts = cs.size;
    r.atRisk = [...cs].filter((c) => i.atRisk.has(c)).length;
    const linesOn = (c: string) => [...(mine.get(r.id)?.entries() ?? [])].filter(([, set]) => set.has(c)).map(([l]) => l);
    for (const f of i.flags) {
      if (!cs.has(f.client_id)) continue;
      const fl = f.line ? SERVICE_LINE[f.line] : null;
      if (f.kind === "unapproved_change" && (!fl || linesOn(f.client_id).includes(fl))) r.unapproved++;
      if (f.kind === "quiet_channel") r.silent++;
    }
  }
  for (const m of i.missed) {
    const r = rows.get(m.profile_id);
    if (r) r.missed++;
  }
  for (const r of rows.values()) r.score = scoreOf(r);
  // A head carries their line: everyone on it (themselves included)
  for (const h of [...rows.values()].filter((r) => r.head)) {
    const team = [...rows.values()].filter((r) => r.line === h.line);
    const loads = team.map((t) => t.accounts);
    h.team = {
      people: team.length,
      accounts: new Set(team.flatMap((t) => [...clientsOf(t.id)])).size,
      missed: team.reduce((n, t) => n + t.missed, 0),
      unapproved: team.reduce((n, t) => n + t.unapproved, 0),
      silent: team.reduce((n, t) => n + t.silent, 0),
      atRisk: team.reduce((n, t) => n + t.atRisk, 0),
      busiest: Math.max(0, ...loads),
      lightest: loads.length ? Math.min(...loads) : 0,
    };
  }
  return [...rows.values()].sort((a, b) => Number(b.head) - Number(a.head) || b.score - a.score || b.accounts - a.accounts || a.name.localeCompare(b.name));
}

/** What a person may see: execs everyone, a head their line, anyone else nothing */
export function visibleRows(rows: readonly ScoreRow[], me: { isExec: boolean; role: string }): ScoreRow[] {
  if (me.isExec) return [...rows];
  const line = isHeadRole(me.role) ? lineOfRole(me.role) : null;
  return line ? rows.filter((r) => r.line === line) : [];
}

// ─── Economics ─────────────────────────────────────────────────────────────

/** A subscription's amount as a monthly figure */
export function monthly(amount: number | null | undefined, interval: string | null | undefined): number {
  const a = Number(amount ?? 0);
  if (!(a > 0)) return 0;
  switch (String(interval ?? "month")) {
    case "year":
      return a / 12;
    case "week":
      return (a * 52) / 12;
    case "day":
      return a * 30;
    default:
      return a;
  }
}

/** Hours worked at each person's cost rate (the rate in force on the day) */
export function laborCost(entries: readonly { profile_id: string; started_at: string; duration_s: number | null }[], rates: readonly { profile_id: string; hourly_cost: number | null; effective_from: string | null; effective_to: string | null }[]): { hours: number; cost: number; unrated: number } {
  let hours = 0;
  let cost = 0;
  let unrated = 0;
  for (const e of entries) {
    const h = Math.max(0, Number(e.duration_s ?? 0)) / 3600;
    hours += h;
    const day = e.started_at.slice(0, 10);
    const r = rates.find((x) => x.profile_id === e.profile_id && (!x.effective_from || x.effective_from.slice(0, 10) <= day) && (!x.effective_to || x.effective_to.slice(0, 10) >= day));
    if (r?.hourly_cost != null) cost += h * Number(r.hourly_cost);
    else unrated += h;
  }
  return { hours, cost, unrated };
}

export type PayState = "paid" | "unpaid" | "overdue" | "none";

export type EconomicsInput = {
  fee: number;
  hours: number;
  cost: number;
  /** Open invoices: amount due and due date */
  open: readonly { amount: number; due: string | null }[];
  /** A subscription Stripe has marked past due */
  pastDue: boolean;
  /** Failed charges and invoices marked uncollectible (from Stripe directly, when the key is set) */
  failed: number;
  uncollectible: number;
  /** Best KPI result against target (14 days), negative = beating it: -0.5 is 50% better */
  bestDeviation: number | null;
  /** A billed line with no activity in 7+ days (the account watch's billed-but-idle) */
  idleBilled: boolean;
  today: string;
};

export type EconFlag = { kind: "losing" | "underpriced" | "no_work" | "unpaid"; text: string; confidence: "certain" | "likely" | "guessing" };

export function payState(i: Pick<EconomicsInput, "open" | "pastDue" | "today" | "fee">): PayState {
  if (i.open.some((o) => o.due && o.due.slice(0, 10) < i.today) || i.pastDue) return "overdue";
  if (i.open.length) return "unpaid";
  return i.fee > 0 ? "paid" : "none";
}

/** The money flags for one client's last 30 days */
export function econFlags(i: EconomicsInput): EconFlag[] {
  const out: EconFlag[] = [];
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (i.fee > 0 && i.cost > i.fee) out.push({ kind: "losing", text: `Costs ${usd(i.cost)} in team hours against a ${usd(i.fee)} fee (${Math.round(i.hours)} h in 30 days)`, confidence: "likely" });
  else if (i.fee > 0 && i.cost > i.fee * 0.8) out.push({ kind: "losing", text: `Thin: ${usd(i.cost)} in hours against a ${usd(i.fee)} fee`, confidence: "likely" });
  if (i.fee > 0 && i.bestDeviation != null && i.bestDeviation <= -0.5) out.push({ kind: "underpriced", text: `Results ${Math.round(-i.bestDeviation * 100)}% better than target on a ${usd(i.fee)} fee: price or scope up`, confidence: "guessing" });
  if (i.fee > 0 && i.hours < 1 && i.idleBilled) out.push({ kind: "no_work", text: `Billed ${usd(i.fee)} a month with no hours logged and a billed service idle`, confidence: "likely" });
  else if (i.fee > 0 && i.hours < 1) out.push({ kind: "no_work", text: `Billed ${usd(i.fee)} a month with no hours logged in 30 days`, confidence: "guessing" });
  const st = payState(i);
  const owed = i.open.reduce((n, o) => n + Number(o.amount || 0), 0);
  if (st === "overdue" || i.failed > 0 || i.uncollectible > 0)
    out.push({ kind: "unpaid", text: [owed ? `${usd(owed)} open${st === "overdue" ? ", past due" : ""}` : i.pastDue ? "Subscription past due" : "", i.failed ? `${i.failed} failed charge${i.failed === 1 ? "" : "s"}` : "", i.uncollectible ? `${i.uncollectible} invoice${i.uncollectible === 1 ? "" : "s"} never collected` : ""].filter(Boolean).join(" · "), confidence: "certain" });
  return out;
}
