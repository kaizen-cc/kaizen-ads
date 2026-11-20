// The Tracking Engineer, the pure part (no database, no AI): which watchdog flags are about tracking, when an ad
// account's conversion rate has dropped suddenly enough to check the tracking, and the numbered steps the agent hands
// back, cleaned. The server side is src/lib/tracking-agent.ts.

/** Watchdog and account-watch flags that point at tracking (spend with nothing tracked, a lost store or CRM link, a dead site) */
export const TRACKING_FLAG_KINDS = ["zero_results", "lead_no_crm", "integration_auth", "site_down", "site_check", "tracking"] as const;

type Window = { spend?: number; results?: number };

/**
 * A sudden drop worth a tracking check, from an account's KPI windows: results per dollar in the last 7 days at half
 * (or less) of the 23 days before, on real spend; or spend in the last 3 days with no results when there were some
 * before. Null when it looks normal or there's too little to tell.
 */
export function cvrDrop(w: Record<string, Window> | null | undefined): string | null {
  const d3 = w?.d3, d7 = w?.d7, d30 = w?.d30;
  if (!d7 || !d30) return null;
  const s7 = Number(d7.spend ?? 0), r7 = Number(d7.results ?? 0);
  const sPrev = Number(d30.spend ?? 0) - s7, rPrev = Number(d30.results ?? 0) - r7;
  if (d3 && Number(d3.spend ?? 0) >= 50 && Number(d3.results ?? 0) === 0 && rPrev >= 5) return `No results tracked in 3 days on $${Math.round(Number(d3.spend))} spend (it had ${rPrev} in the weeks before)`;
  if (s7 < 50 || sPrev < 200 || rPrev < 10) return null;
  const before = rPrev / sPrev;
  const now = r7 / s7;
  if (now > before * 0.5) return null;
  return `Results per dollar fell ${Math.round((1 - now / before) * 100)}% in the last 7 days against the 23 days before`;
}

export type TrackingStep = { n: number; do: string; where: string; good: string; who: string };
export type TrackingCheck = { client: { id: string; name: string; slug: string }; summary: string; causes: string[]; steps: TrackingStep[]; signals: string[] };

const WHO = ["tracking specialist", "media buyer", "client's developer", "client"];
const tidy = (s: unknown, max: number) => String(s ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);

/** The agent's answer as clean numbered steps (empty ones dropped, at most 8, the owner one of the four roles) */
export function trackingSteps(raw: { summary?: unknown; likely_causes?: unknown; steps?: unknown }, ctx: { client: { id: string; name: string; slug: string }; signals?: string[] }): TrackingCheck {
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => (s ?? {}) as Record<string, unknown>)
    .map((s) => ({ do: tidy(s.do, 300), where: tidy(s.where, 200), good: tidy(s.good, 240), who: WHO.includes(String(s.who)) ? String(s.who) : "tracking specialist" }))
    .filter((s) => s.do.length >= 6)
    .slice(0, 8)
    .map((s, i) => ({ n: i + 1, ...s }));
  return {
    client: ctx.client,
    summary: tidy(raw.summary, 600),
    causes: (Array.isArray(raw.likely_causes) ? raw.likely_causes : []).map((c) => tidy(c, 300)).filter(Boolean).slice(0, 4),
    steps,
    signals: (ctx.signals ?? []).slice(0, 8),
  };
}

/** The check as plain text (a chat answer, a notice, a copy to paste) */
export function stepsText(c: TrackingCheck): string {
  return [
    c.summary,
    c.causes.length ? `Likely: ${c.causes.join("; ")}` : "",
    ...c.steps.map((s) => `${s.n}. ${s.do}${s.where ? ` (${s.where})` : ""}${s.good ? `. Good looks like: ${s.good}` : ""} [${s.who}]`),
  ]
    .filter(Boolean)
    .join("\n");
}
