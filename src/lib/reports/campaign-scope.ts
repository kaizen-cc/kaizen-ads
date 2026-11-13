import type { CampaignLine, LeftOut, Period, ReportMetrics } from "./metrics";
import { applyManual, withoutManual } from "./manual";

// Leaving campaigns out of ONE report (a campaign that isn't Kaizen's, run by the client or another agency). Plain
// functions (no server code), shared by the PDF, the studio's preview and the tests. The server worked the numbers out
// from the ad account's rows when the report was drafted; this works them out again from the campaigns that remain, so a
// campaign left out in the studio changes everything that is a sum of campaigns: the glance tiles, spend, impressions,
// link clicks, CTR, CPC, CPM, results and their cost, revenue and ROAS, the campaign table and its total, the
// comparison, the current week of the five-week chart, the creative scorecard and the top ads (an ad of a left-out
// campaign leaves with it), and the numbers the takeaways are worked out from.

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The names a layout leaves out (campaign names, or ids), cleaned */
export const leftOutNames = (hide: readonly (string | null | undefined)[] | null | undefined) => [...new Set((hide ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];

/** Whether a campaign (by name or id) is one of the left-out ones */
export const isLeftOut = (c: { name?: string | null; id?: string | number | null }, names: ReadonlySet<string>) => (c.name != null && names.has(c.name)) || (c.id != null && names.has(String(c.id)));

type Sums = { spend: number; impressions: number; clicks: number; results: number; revenue: number };
const ZERO: Sums = { spend: 0, impressions: 0, clicks: 0, results: 0, revenue: 0 };
const add = (a: Sums, b: Sums): Sums => ({ spend: a.spend + b.spend, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, results: a.results + b.results, revenue: a.revenue + b.revenue });

/** What a campaign adds to the headline totals (its results are the share the report counts, 0 for a reach or engagement campaign) */
const share = (c: CampaignLine): Sums => ({ spend: c.spend, impressions: c.impressions ?? 0, clicks: c.clicks ?? 0, results: c.counted ?? c.results, revenue: c.revenue ?? 0 });

/** A period's ratios worked out from its sums: CTR, CPC, CPM, cost per result and ROAS, the way the report counts them */
export function periodFrom(p: Period, x: Sums): Period {
  const spend = Math.max(0, r2(x.spend));
  const impressions = Math.max(0, Math.round(x.impressions));
  const clicks = Math.max(0, Math.round(x.clicks));
  const results = Math.max(0, r1(x.results));
  const revenue = Math.max(0, r2(x.revenue));
  return {
    ...p,
    spend,
    impressions,
    clicks,
    ctr: impressions ? r2((clicks / impressions) * 100) : null,
    cpc: clicks ? r2(spend / clicks) : null,
    cpm: impressions ? r2((spend / impressions) * 1000) : null,
    results,
    costPerResult: results ? r2(spend / results) : null,
    revenue,
    roas: spend && revenue ? r2(revenue / spend) : null,
  };
}

const sumsOf = (p: Period): Sums => ({ spend: p.spend, impressions: p.impressions, clicks: p.clicks, results: p.results, revenue: p.revenue });
const minus = (a: Sums, b: Sums): Sums => ({ spend: a.spend - b.spend, impressions: a.impressions - b.impressions, clicks: a.clicks - b.clicks, results: a.results - b.results, revenue: a.revenue - b.revenue });

/**
 * Which of a report's pictures stay when campaigns are left out: one flag per ad (a Meta or TikTok report) or per Google
 * ad group and asset group, in the order the pictures are kept (topAds, googleUnits), so they can be dropped with them.
 */
export function picturesKept(m: Pick<ReportMetrics, "platform" | "topAds" | "googleUnits">, names: readonly (string | null | undefined)[] | null | undefined): boolean[] {
  const set = new Set(leftOutNames(names));
  if (m.platform === "google") return (m.googleUnits ?? []).map((u) => !(set.has(u.campaign) || (u.campaignId != null && set.has(String(u.campaignId)))));
  return m.topAds.map((a) => !(a.campaign != null && set.has(a.campaign)));
}

/**
 * The report's numbers without the campaigns named (by name or id): the totals are the account's totals less what those
 * campaigns carried, then every ratio is worked out again from the sums. Campaigns it can't find change nothing. A report
 * the team entered CRM results for keeps them (they are account level); their cost follows the new spend.
 */
export function leaveOutCampaigns(input: ReportMetrics, names: readonly (string | null | undefined)[] | null | undefined): ReportMetrics {
  const set = new Set(leftOutNames(names));
  if (!set.size) return input;
  const m = withoutManual(input);
  const gone = m.campaigns.filter((c) => isLeftOut(c, set));
  const adGone = (a: { campaign: string | null }) => a.campaign != null && set.has(a.campaign);
  const unitGone = (u: { campaign: string; campaignId?: string }) => set.has(u.campaign) || (u.campaignId != null && set.has(String(u.campaignId)));
  if (!gone.length && !m.topAds.some(adGone) && !(m.googleUnits ?? []).some(unitGone)) return input;

  const carried = gone.reduce((n, c) => add(n, share(c)), ZERO);
  const main = periodFrom(m.main, minus(sumsOf(m.main), carried));
  // The comparison: each campaign kept what it did then (older reports didn't: their comparison stays as drawn)
  const before = gone.every((c) => c.prev) ? gone.reduce((n, c) => add(n, c.prev!), ZERO) : null;
  const compare = before ? periodFrom(m.compare, minus(sumsOf(m.compare), before)) : m.compare;

  // The five weeks: the report's own week and the one before it are known now; the earlier ones keep what they were drawn with
  const weeks = m.weeks?.map((w) => {
    const point = (p: Period) => ({ ...w, spend: p.spend, results: p.results, costPerResult: p.costPerResult, revenue: p.revenue, roas: p.roas, clicks: p.clicks, impressions: p.impressions });
    if (w.start === m.main.start && w.end === m.main.end) return point(main);
    if (before && w.start === m.compare.start && w.end === m.compare.end) return point(compare);
    return w;
  });

  // What the campaigns are optimized for, by goal: less what the left-out ones brought under it
  const goals = m.goals
    ?.map((g) => {
      const mine = gone.filter((c) => c.result === g.label);
      if (!mine.length) return g;
      const spend = r2(g.spend - mine.reduce((n, c) => n + c.spend, 0));
      const results = r1(g.results - mine.reduce((n, c) => n + (c.counted ?? c.results), 0));
      return { ...g, spend: Math.max(0, spend), results: Math.max(0, results), costPerResult: results > 0 ? r2(spend / results) : null };
    })
    .filter((g) => g.spend > 0 || g.results > 0);

  const seen = new Set((m.leftOut ?? []).map((l) => l.id));
  const left: LeftOut[] = [...(m.leftOut ?? []), ...gone.filter((c) => !seen.has(String(c.id ?? c.name))).map((c) => ({ id: String(c.id ?? c.name), name: c.name, spend: c.spend, why: "report" as const }))];

  const out: ReportMetrics = {
    ...m,
    main,
    compare,
    campaigns: m.campaigns.filter((c) => !isLeftOut(c, set)),
    topAds: m.topAds.filter((a) => !adGone(a)),
    ...(weeks ? { weeks } : {}),
    ...(goals ? { goals } : {}),
    ...(m.googleUnits ? { googleUnits: m.googleUnits.filter((u) => !unitGone(u)) } : {}),
    ...(left.length ? { leftOut: left } : {}),
  };
  return input.manual ? applyManual(out, input.manual) : out;
}
