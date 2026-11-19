// The creative leads' Clients tab (src/app/(team)/pipeline/views/creative-client-rows.tsx): how each client is grouped
// and toned, and what each ready brief is built on. Pure, tested in tests/creative-desk.test.ts.

export type DeskGroup = "now" | "pace" | "covered" | "over";
export type PoolLike = { cap: number; requested: number; missing: number; over: number; dueThisWeek: number; state: "nothing" | "missing" | "covered" | "over" };

export const GROUPS: { id: DeskGroup; label: string; blurb: string }[] = [
  { id: "now", label: "Needs briefs now", blurb: "Behind this week's healthy share: their briefs are ready below" },
  { id: "pace", label: "On pace", blurb: "Nothing due this week; the rest follows as the weeks go" },
  { id: "covered", label: "Covered", blurb: "Everything they pay for this cycle is briefed" },
  { id: "over", label: "Over allotment", blurb: "Past what they pay for this cycle: no briefs suggested" },
];

/**
 * Where a client sits: a pool behind this week's healthy share (or with nothing in motion) needs briefs now; one
 * that's short but on pace is on pace; otherwise over the allotment if any pool is past its cap, else covered.
 */
export function clientGroup(pools: readonly PoolLike[]): DeskGroup {
  const capped = pools.filter((p) => p.cap > 0);
  if (capped.some((p) => p.missing > 0 && (p.dueThisWeek > 0 || p.state === "nothing"))) return "now";
  if (capped.some((p) => p.missing > 0)) return "pace";
  if (capped.some((p) => p.over > 0)) return "over";
  return "covered";
}

export type SourceChip = { label: string; tone: "brand" | "ok" | "warn" | "bad" | "market" | "quiet" };

/** What a ready brief is built on, as a chip: pacing, the market, a winner from another client, the client's ask… */
export function sourceChip(s: { kind: string; drafted?: { citation?: { source?: string } | null; trigger?: string } | null }): SourceChip {
  const src = s.drafted?.citation?.source;
  if (src === "market") return { label: "In the market", tone: "market" };
  if (src === "peer") return { label: "Winning for a similar client", tone: "ok" };
  if (src === "pattern") return { label: "Proven for businesses like them", tone: "ok" };
  if (src === "call" || src === "slack" || src === "email") return { label: src === "call" ? "Asked on a call" : "The client asked", tone: "bad" };
  if (s.drafted?.trigger === "fatigue" || s.kind === "refresh") return { label: "Refresh a tired ad", tone: "warn" };
  if (s.drafted?.trigger === "kpi") return { label: "KPI dropping", tone: "bad" };
  if (src === "ad") return { label: "Iterate on their winner", tone: "ok" };
  if (s.drafted?.trigger === "pacing" || s.kind === "pacing") return { label: "Pacing", tone: "brand" };
  if (s.kind === "call" || s.kind === "offer") return { label: "The client asked", tone: "bad" };
  if (s.kind === "moment") return { label: "Marketing moment", tone: "brand" };
  if (s.kind === "winner") return { label: "From a winner", tone: "ok" };
  return { label: "Suggested", tone: "quiet" };
}

/** "resets today", "resets tomorrow", "6 days to reset" */
export const resetIn = (daysLeft: number) => (daysLeft <= 0 ? "resets today" : daysLeft === 1 ? "resets tomorrow" : `${daysLeft} days to reset`);
