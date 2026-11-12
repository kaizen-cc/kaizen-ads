import type { Period, ReportMetrics } from "./metrics";

// Results that happen off the ad platforms (bookings and sales that live only in the client's CRM, say GoHighLevel):
// entered by the team for a report's period and kept on the report, so a regenerate keeps them. Pure functions, so the
// merging into a report's numbers is tested. Manual results are account level only: never split per campaign.

/** Suggestions for what was counted (free text is allowed too) */
export const MANUAL_SUGGESTIONS = ["Bookings", "Sales", "Leads", "Calls", "Showed up", "Closed deals"] as const;
export const DEFAULT_SOURCE = "CRM (GoHighLevel)";

/** One line: what was counted, how many, the revenue if any, and the same for the prior period when the team has it */
export type ManualLine = {
  id: string;
  label: string;
  count: number;
  revenue: number | null;
  priorCount: number | null;
  priorRevenue: number | null;
  source: string;
  note: string | null;
  /** Use this line as the report's main result: cost per result and ROAS follow it */
  main: boolean;
};

/** start/end: the dates the numbers were entered for; by: who entered them, at: when */
export type ManualResults = { lines: ManualLine[]; start: string | null; end: string | null; by: string | null; byName: string | null; at: string | null };

/** What the numbers were before a manual main result replaced them (so it can be undone or changed, never compounded) */
export type ManualBase = {
  conversion: string;
  main: Pick<Period, "results" | "costPerResult" | "revenue" | "roas">;
  compare: Pick<Period, "results" | "costPerResult" | "revenue" | "roas">;
  mtd: Period | null;
  mtdCompare: Period | null;
  weeks: ReportMetrics["weeks"] | null;
  campaignResults: (string | null)[];
};

/** On a report's metrics: the lines as shown (with who and when) and, if one is the main result, what it replaced */
export type ManualApplied = { lines: ManualLine[]; by: string | null; byName: string | null; at: string | null; base?: ManualBase };

const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
};

/** Lines cleaned for saving: trimmed, numbers read, empty ones dropped, at most one main result, a limit on how many */
export function cleanLines(input: unknown): ManualLine[] {
  const list = Array.isArray(input) ? input : [];
  const out: ManualLine[] = [];
  for (const raw of list.slice(0, 12)) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const label = String(x.label ?? "").trim().slice(0, 60);
    const count = num(x.count);
    if (!label || count == null) continue;
    out.push({
      id: String(x.id ?? "").slice(0, 40) || `m${out.length + 1}`,
      label,
      count: Math.round(count * 10) / 10,
      revenue: num(x.revenue),
      priorCount: num(x.priorCount),
      priorRevenue: num(x.priorRevenue),
      source: String(x.source ?? "").trim().slice(0, 80) || DEFAULT_SOURCE,
      note: String(x.note ?? "").trim().slice(0, 300) || null,
      main: x.main === true,
    });
  }
  let seen = false;
  return out.map((l) => {
    if (!l.main) return l;
    const keep = !seen;
    seen = true;
    return { ...l, main: keep };
  });
}

/** The cost of one manual result: spend over the count (null when there's none) */
export const manualCost = (spend: number, count: number) => (count > 0 ? r2(spend / count) : null);

const asBase = (p: Period): ManualBase["main"] => ({ results: p.results, costPerResult: p.costPerResult, revenue: p.revenue, roas: p.roas });

/** The metrics with any earlier manual main result taken back out, as the platform drew them */
export function withoutManual(m: ReportMetrics): ReportMetrics {
  const base = m.manual?.base;
  const { manual: _gone, ...rest } = m;
  void _gone;
  if (!base) return rest;
  return {
    ...rest,
    conversion: base.conversion,
    main: { ...rest.main, ...base.main },
    compare: { ...rest.compare, ...base.compare },
    mtd: base.mtd,
    mtdCompare: base.mtdCompare,
    ...(base.weeks ? { weeks: base.weeks } : {}),
    campaigns: rest.campaigns.map((c, i) => ({ ...c, result: base.campaignResults[i] ?? null })),
  };
}

/**
 * Merges manual results into a report's numbers. Every line travels with the metrics (so the tiles, the written report,
 * the PDF and the shared link all read them). A line ticked as the main result replaces the headline result: its label
 * is the conversion, cost per result is spend over its count, ROAS uses its revenue. Its comparison is the prior count
 * when the team entered one; with none there is no comparison (never a made-up change). Per-campaign numbers stay the
 * platform's and are labelled as such. Safe to run again: it starts from the platform's numbers.
 */
export function applyManual(metrics: ReportMetrics, manual: Pick<ManualResults, "lines" | "by" | "byName" | "at"> | null | undefined): ReportMetrics {
  const m = withoutManual(metrics);
  const lines = manual?.lines?.length ? cleanLines(manual.lines) : [];
  if (!lines.length) return m;
  const head = lines.find((l) => l.main);
  const applied: ManualApplied = { lines, by: manual?.by ?? null, byName: manual?.byName ?? null, at: manual?.at ?? null };
  if (!head) return { ...m, manual: applied };
  applied.base = {
    conversion: m.conversion,
    main: asBase(m.main),
    compare: asBase(m.compare),
    mtd: m.mtd,
    mtdCompare: m.mtdCompare,
    weeks: m.weeks ?? null,
    campaignResults: m.campaigns.map((c) => c.result ?? null),
  };
  const was = m.conversion;
  const main = { ...m.main, results: head.count, costPerResult: manualCost(m.main.spend, head.count), revenue: head.revenue ?? 0, roas: head.revenue && m.main.spend ? r2(head.revenue / m.main.spend) : null };
  // No prior numbers entered: nothing to compare with (the platform's last period counted something else)
  const prior = head.priorCount;
  const priorRevenue = head.priorRevenue ?? 0;
  const compare = {
    ...m.compare,
    results: (prior ?? null) as unknown as number,
    costPerResult: prior != null ? manualCost(m.compare.spend, prior) : null,
    revenue: prior != null ? priorRevenue : 0,
    roas: prior != null && priorRevenue && m.compare.spend ? r2(priorRevenue / m.compare.spend) : null,
  };
  const { weeks: _weeks, ...rest } = m;
  void _weeks;
  return {
    ...rest,
    conversion: head.label,
    main,
    compare,
    // The month so far and the five-week chart are the platform's counts of another result: left out rather than mixed
    mtd: null,
    mtdCompare: null,
    // What the campaigns each counted stays the platform's, named for what it was
    campaigns: m.campaigns.map((c) => ({ ...c, result: c.result ?? was })),
    manual: applied,
  };
}

/** The conversion the platform itself counted (the label for campaign and ad numbers), whatever the headline is */
export const platformConversion = (m: Pick<ReportMetrics, "conversion" | "manual">) => m.manual?.base?.conversion ?? m.conversion;

/** The plain words that go under the numbers in a report */
export function manualCaption(manual: ManualApplied | null | undefined): string | null {
  if (!manual?.lines.length) return null;
  const sources = [...new Set(manual.lines.map((l) => l.source))];
  return `${manual.lines.map((l) => l.label).join(", ")}: from ${sources.join(" and ")}, entered by the team. Not tracked by the ad platform.`;
}

const money = (x: number | null) => (x == null ? "n/a" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** The lines for the writer and the QA: what came from the client's CRM, entered by the team, and how to use it */
export function manualText(m: Pick<ReportMetrics, "main" | "compare" | "manual">): string {
  const a = m.manual;
  if (!a?.lines.length) return "";
  const rows = a.lines.map((l) => {
    const cost = manualCost(m.main.spend, l.count);
    return `- ${l.label}: ${l.count}${l.revenue != null ? `, revenue ${money(l.revenue)}` : ""}${cost != null ? `, ${money(cost)} of ad spend per ${l.label.toLowerCase()}` : ""}; ${l.priorCount != null ? `the period before: ${l.priorCount}${l.priorRevenue != null ? `, revenue ${money(l.priorRevenue)}` : ""}` : "no prior-period number (so no comparison: don't say it went up or down)"}; source: ${l.source}${l.note ? `; note: ${l.note}` : ""}${l.main ? "; THIS IS THE MAIN RESULT of this report" : ""}`;
  });
  return `<results_from_the_clients_crm note="These counts happened off the ad platforms and were entered by the team (${a.byName ?? "a team member"}) from the client's own CRM. Use them: they are real results and the client expects to see them. Say they come from the client's CRM or the team's tracking, never that Meta or Google tracked them. Never split them by campaign or ad. Account level only. Cost per result and ROAS for the main result are computed from them and the spend.">\n${rows.join("\n")}\n</results_from_the_clients_crm>`;
}
