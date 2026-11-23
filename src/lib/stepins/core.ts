import { execHears } from "@/lib/exec-overview-core";

// The executives' weekly step-ins, the pure part (owner, Nov 23 2026). The same engine as the line heads' Monday review
// goes through every account, but an exec only gets the accounts where an exec needs to step in, per the exec rules
// already decided: a fire (every exec, company-wide); an ad account 50%+ off its KPI for over 7 days with nothing
// person-driven in motion; email in the bad band for 7+ days with nothing moving; and items that climbed past the lead
// (rung 3 of the ladder). Everything the leads are handling stays with the leads. Each client is one living card that
// every exec shares (comments, who's handling it, a due date), closing when the account recovers or someone marks it
// handled, and reopening if it slides again.

export type ReasonKind = "fire" | "account" | "email" | "escalated";
export type Reason = {
  kind: ReasonKind;
  /** The focus line it belongs to (meta, google, tiktok, email, social, creative); null = every exec (a fire) */
  line: string | null;
  title: string;
  detail: string;
  /** "CPA $84 vs $50" */
  stat?: string | null;
  since?: string | null;
};

export const REASON_RANK: Record<ReasonKind, number> = { fire: 100, account: 60, email: 50, escalated: 40 };

/** How bad: the worst reason, plus a little for each extra one */
export function severityOf(reasons: readonly Reason[]): number {
  if (!reasons.length) return 0;
  const ranks = reasons.map((r) => REASON_RANK[r.kind]).sort((a, b) => b - a);
  return ranks[0] + Math.min(20, (ranks.length - 1) * 5);
}

/** Whether this exec sees the card: a fire is everyone's; otherwise a reason on one of their focus lines (no focus: all) */
export function execSees(reasons: readonly Pick<Reason, "kind" | "line">[], focus: readonly string[]): boolean {
  return reasons.some((r) => r.kind === "fire" || !r.line || execHears(r.line, focus));
}

/** The suggested step-in, from the worst reason first */
export function suggestStep(reasons: readonly Reason[], owner: string | null): string {
  const who = owner ?? "the account owner";
  const top = [...reasons].sort((a, b) => REASON_RANK[b.kind] - REASON_RANK[a.kind])[0];
  if (!top) return "Nothing to step into.";
  if (top.kind === "fire") {
    if (/cancel|leav/i.test(top.title)) return `Call the client yourself today, with ${who}, and agree what keeps them.`;
    if (/angry|unanswered/i.test(top.title)) return `Reply to the client today (or make sure ${who} does within the hour), then call.`;
    return `Get ${who} on it now: the account can't spend until it's fixed. Confirm by end of day.`;
  }
  if (top.kind === "account") return `15 minutes with ${who} today: what changed, what they'll do this week, and start a sprint or an audit so it's moving.`;
  if (top.kind === "email") return `Ask ${who} for the fix plan today, and get an email sprint or audit started.`;
  return `Ask the lead why it stalled and settle who owns it, with a date.`;
}

export type CardStatus = "open" | "handled" | "recovered";

/**
 * What a card's status becomes on a run. Qualifying: open stays open; recovered reopens (it slid again); handled stays
 * handled for 7 days unless a fire appears that wasn't there when it was handled, then it reopens. Not qualifying: an
 * open card closes as recovered; handled and recovered stay as they are.
 */
export function nextStatus(cur: { status: CardStatus; handledAt?: string | null; hadFire?: boolean } | null, i: { qualifies: boolean; fire: boolean; now?: Date }): { status: CardStatus; reopened: boolean; closed: boolean } | null {
  const now = (i.now ?? new Date()).getTime();
  if (!cur) return i.qualifies ? { status: "open", reopened: false, closed: false } : null;
  if (!i.qualifies) return cur.status === "open" ? { status: "recovered", reopened: false, closed: true } : { status: cur.status, reopened: false, closed: false };
  if (cur.status === "open") return { status: "open", reopened: false, closed: false };
  if (cur.status === "recovered") return { status: "open", reopened: true, closed: false };
  const stale = !cur.handledAt || now - Date.parse(cur.handledAt) > 7 * 86_400_000;
  const newFire = i.fire && !cur.hadFire;
  return stale || newFire ? { status: "open", reopened: true, closed: false } : { status: "handled", reopened: false, closed: false };
}

/** Email in the bad band (under 60) for each of the last 7 scored days (and at least 5 of them scored) */
export function emailBadWeek(days: readonly { day: string; score: number }[], today: string): { days: number; score: number } | null {
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const week = days.filter((d) => d.day > since && d.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  if (week.length < 5 || week.some((d) => d.score >= 60)) return null;
  return { days: week.length, score: week[week.length - 1].score };
}

/** A KPI's direction: the last 7 days against the 30 (lower is better for costs, higher for ROAS) */
export function trendOf(i: { d7: number | null | undefined; d30: number | null | undefined; roas: boolean }): "better" | "worse" | "flat" | null {
  if (i.d7 == null || i.d30 == null || !(i.d30 > 0)) return null;
  const change = (i.d7 - i.d30) / i.d30;
  if (Math.abs(change) < 0.08) return "flat";
  return (i.roas ? change > 0 : change < 0) ? "better" : "worse";
}

/** How many cards each exec gets (for the run's report) */
export function perExec(cards: readonly { reasons: readonly Pick<Reason, "kind" | "line">[] }[], execs: readonly { name: string; focus: readonly string[] }[]): Record<string, number> {
  return Object.fromEntries(execs.map((e) => [e.name, cards.filter((c) => execSees(c.reasons, e.focus)).length]));
}
