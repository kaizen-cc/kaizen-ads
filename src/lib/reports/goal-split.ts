import type { ReportMetrics } from "./metrics";

// Results by goal: an account whose campaigns are optimized for different results (purchases and leads, bookings and
// calls) gets each result's own numbers beside the headline, never one blended into the other. The headline stays the
// KPI's own count; this is extra. Plain functions (no server code), shared by the report's numbers, the PDF, the shared
// page, the writer and the tests.
//
// What a campaign is counted under: on Meta, what it is optimized for (its ad set's goal, or a result the buyer picked
// on the card); on Google, the conversion actions most of its conversions came from in the period, grouped by what they
// are (calls, leads, purchases). TikTok's days carry one count of the optimization event with no goal beside it, so
// TikTok has nothing to split by.

// What a campaign can be optimized for that isn't a business result
export const NOT_A_RESULT = /^(post_engagement|page_engagement|post_reaction|post_interaction|like|comment|onsite_conversion\.post_save|video_view|thruplay|link_click|landing_page_view|omni_landing_page_view|reach|impressions|photo_view)/;
// A goal's name as the thing counted, plural
const PLURAL: [RegExp, string][] = [
  [/application/i, "Applications"],
  [/schedul|appoint|book/i, "Bookings"],
  [/purchase|order|sale/i, "Purchases"],
  [/registration|sign.?up/i, "Registrations"],
  [/lead/i, "Leads"],
  [/contact|call/i, "Contacts"],
  [/message|conversation/i, "Conversations"],
  [/subscri/i, "Subscriptions"],
  [/trial/i, "Trials"],
];
// Ads Manager's names ("Website schedules") already read as the thing counted
export const pluralOf = (label: string) => PLURAL.find(([re]) => re.test(label))?.[1] ?? (/^Website /.test(label) ? label : `${label} results`);

/**
 * A goal's name in the breakdown: as the headline names it (pluralOf), with Google's conversion action names read too
 * ("Calls from ads" are calls, "Contact form submit" a lead, "Request a quote" a quote request).
 */
export function goalName(label: string) {
  const name = label.trim();
  if (/\bcalls?\b|phone/i.test(name)) return "Calls";
  const p = pluralOf(name);
  // A form sent is a lead, "Contact form submit" included
  if (/form|submi/i.test(name) && (p === "Contacts" || p === name || p === `${name} results`)) return "Leads";
  if (p !== name && p !== `${name} results`) return p;
  if (/quote|estimate/i.test(name)) return "Quote requests";
  return p;
}

/** Google conversion actions that aren't a business result (a page view, an engaged visit) */
const GOOGLE_SOFT = /page.?view|engag|scroll|video|time on site/i;

/** What a campaign counts as its result: the action types and the goal's name. sum: every type counts (Google's actions are separate conversions), else the first the row reports (Meta's aliases of one event) */
export type GoalOf = { label: string; types: string[]; sum?: boolean };

/** A Meta campaign's goal from what it's optimized for, or null when that isn't a result (reach, engagement, traffic) */
export function metaGoal(types: string[] | null | undefined, label: string | null | undefined): GoalOf | null {
  const name = String(label ?? "").trim();
  if (!types?.length || !name || !types.some((t) => !NOT_A_RESULT.test(t))) return null;
  return { label: goalName(name), types };
}

type ActionRow = { date: string; campaign_id?: string | number | null; campaign_name?: string | null; spend: number | string; actions: Record<string, number> | null; action_values?: Record<string, number> | null };

/**
 * Each Google campaign's goal: the kind of conversion (calls, leads, purchases) most of its conversions were in the
 * range, from its conversion actions ("action:<name>"). A campaign with none in the range is read over every row given.
 */
export function googleGoals(rows: ActionRow[], range: { start: string; end: string }): Map<string, GoalOf> {
  const totals = (rs: ActionRow[]) => {
    const by = new Map<string, { n: number; names: Set<string> }>();
    for (const r of rs)
      for (const [k, v] of Object.entries(r.actions ?? {})) {
        if (!k.startsWith("action:") || !(Number(v) > 0)) continue;
        const name = k.slice(7);
        if (GOOGLE_SOFT.test(name) && !/\bcalls?\b|phone/i.test(name)) continue;
        const kind = goalName(name);
        const e = by.get(kind) ?? { n: 0, names: new Set<string>() };
        e.n += Number(v);
        e.names.add(k);
        by.set(kind, e);
      }
    return by;
  };
  const per = new Map<string, ActionRow[]>();
  for (const r of rows) {
    if (r.campaign_id == null) continue;
    const id = String(r.campaign_id);
    const list = per.get(id);
    if (list) list.push(r);
    else per.set(id, [r]);
  }
  const out = new Map<string, GoalOf>();
  for (const [id, rs] of per) {
    const inRange = totals(rs.filter((r) => r.date >= range.start && r.date <= range.end));
    const by = inRange.size ? inRange : totals(rs);
    const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    // Every kind of action (not just the top one's names) a campaign counted under the same kind
    if (top) out.set(id, { label: top[0], types: [...(totals(rs).get(top[0])?.names ?? top[1].names)], sum: true });
  }
  return out;
}

export type GoalSums = { spend: number; results: number; revenue: number };
/** One campaign's share of a goal: what it spent and counted in each period of the report (kept so a campaign left out of one report leaves its goal too) */
export type GoalPart = { label: string; id: string; name: string; main: GoalSums; compare: GoalSums; mtd?: GoalSums; mtdCompare?: GoalSums };

type Range = { start: string; end: string };
const ZERO: GoalSums = { spend: 0, results: 0, revenue: 0 };
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** What a row counted for a goal: its results and their value */
function counted(r: ActionRow, g: GoalOf) {
  if (g.sum) {
    let results = 0;
    let revenue = 0;
    for (const t of g.types) {
      results += Number(r.actions?.[t]) || 0;
      revenue += Number(r.action_values?.[t]) || 0;
    }
    return { results, revenue };
  }
  const hit = g.types.find((t) => r.actions?.[t] != null);
  return hit ? { results: Number(r.actions?.[hit]) || 0, revenue: Number(r.action_values?.[hit]) || 0 } : { results: 0, revenue: 0 };
}

/**
 * Each campaign's part of its goal in every period of the report: main, compare and, on a weekly, the month so far and
 * the same days the month before. before: the rows the comparison is read from (the same rows unless an uploaded file
 * covers the report but not the period before it). Campaigns with no real goal are left out (they stay in the campaign
 * table under their own result).
 */
export function goalParts(rows: ActionRow[], goals: Map<string, GoalOf>, periods: { main: Range; compare: Range; mtd?: Range | null; mtdCompare?: Range | null }, before: ActionRow[] = rows): GoalPart[] {
  const parts = new Map<string, GoalPart>();
  const add = (r: ActionRow, key: "main" | "compare" | "mtd" | "mtdCompare") => {
    const id = String(r.campaign_id ?? "");
    const g = goals.get(id);
    if (!id || !g) return;
    const p = parts.get(id) ?? { label: g.label, id, name: r.campaign_name ?? id, main: { ...ZERO }, compare: { ...ZERO }, ...(periods.mtd ? { mtd: { ...ZERO } } : {}), ...(periods.mtdCompare ? { mtdCompare: { ...ZERO } } : {}) };
    if (key === "main" && r.campaign_name) p.name = r.campaign_name;
    const c = counted(r, g);
    const s = p[key]!;
    s.spend += Number(r.spend) || 0;
    s.results += c.results;
    s.revenue += c.revenue;
    parts.set(id, p);
  };
  const inside = (d: string, x: Range | null | undefined) => x != null && d >= x.start && d <= x.end;
  for (const r of rows) {
    if (inside(r.date, periods.main)) add(r, "main");
    if (inside(r.date, periods.mtd)) add(r, "mtd");
    if (inside(r.date, periods.mtdCompare)) add(r, "mtdCompare");
  }
  for (const r of before) if (inside(r.date, periods.compare)) add(r, "compare");
  const round = (x: GoalSums): GoalSums => ({ spend: r2(x.spend), results: r1(x.results), revenue: r2(x.revenue) });
  return [...parts.values()]
    .map((p) => ({ ...p, main: round(p.main), compare: round(p.compare), ...(p.mtd ? { mtd: round(p.mtd) } : {}), ...(p.mtdCompare ? { mtdCompare: round(p.mtdCompare) } : {}) }))
    .filter((p) => [p.main, p.compare, p.mtd, p.mtdCompare].some((x) => x && (x.spend > 0 || x.results > 0)));
}

/** A goal's numbers in one period */
export type GoalNumbers = { spend: number; results: number; costPerResult: number | null; revenue: number; roas: number | null };
/** One goal in the breakdown. share: of the report's spend (%), value: it carries revenue worth showing (purchases) */
export type GoalLine = GoalNumbers & { label: string; campaigns: number; share: number | null; value: boolean; before: GoalNumbers; mtd?: GoalNumbers; mtdBefore?: GoalNumbers };

const numbers = (x: GoalSums): GoalNumbers => ({ spend: r2(x.spend), results: r1(x.results), costPerResult: x.results > 0 ? r2(x.spend / x.results) : null, revenue: r2(x.revenue), roas: x.spend > 0 && x.revenue > 0 ? r2(x.revenue / x.spend) : null });
const plus = (a: GoalSums, b: GoalSums | undefined): GoalSums => (b ? { spend: a.spend + b.spend, results: a.results + b.results, revenue: a.revenue + b.revenue } : a);

/**
 * The breakdown a report shows: a line per goal, biggest spend first, only when the campaigns that spent in the period
 * went after two or more different results (one goal: nothing to split, so nothing changes). An older report, drafted
 * before goals were kept, has none.
 */
export function goalLines(m: Pick<ReportMetrics, "main"> & { goalParts?: GoalPart[] | null }): GoalLine[] {
  const parts = m.goalParts ?? [];
  if (!parts.length) return [];
  const by = new Map<string, GoalPart[]>();
  for (const p of parts) {
    const list = by.get(p.label);
    if (list) list.push(p);
    else by.set(p.label, [p]);
  }
  const lines = [...by.entries()].map(([label, ps]): GoalLine => {
    const sum = (k: "main" | "compare" | "mtd" | "mtdCompare") => ps.reduce((n, p) => plus(n, p[k]), ZERO);
    const now = numbers(sum("main"));
    const hasMtd = ps.some((p) => p.mtd);
    return {
      label,
      ...now,
      campaigns: ps.filter((p) => p.main.spend > 0).length,
      share: m.main.spend > 0 ? Math.round((now.spend / m.main.spend) * 1000) / 10 : null,
      value: label === "Purchases" && (now.revenue > 0 || sum("compare").revenue > 0),
      before: numbers(sum("compare")),
      ...(hasMtd ? { mtd: numbers(sum("mtd")), mtdBefore: numbers(sum("mtdCompare")) } : {}),
    };
  });
  const shown = lines.filter((l) => l.spend > 0 || l.results > 0).sort((a, b) => b.spend - a.spend || b.results - a.results);
  return shown.filter((l) => l.spend > 0).length >= 2 ? shown : [];
}

/** A goal's cost per result as the report names it: "CPA" for purchases, "CPL" for leads, else "Cost per booking" */
export function goalCostLabel(label: string) {
  if (label === "Purchases") return "CPA";
  if (label === "Leads") return "CPL";
  return `Cost per ${label.toLowerCase().replace(/ies$/, "y").replace(/s$/, "")}`;
}

/** The breakdown as lines for the writer: each goal on its own, with the period before (and the month so far on a weekly) */
export function goalLinesText(m: Pick<ReportMetrics, "main" | "compare" | "mtd"> & { goalParts?: GoalPart[] | null }): string[] {
  const lines = goalLines(m);
  if (!lines.length) return [];
  const money = (x: number | null) => (x == null ? "n/a" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const one = (g: GoalNumbers, value: boolean) => `${g.results} at ${money(g.costPerResult)} each, ${money(g.spend)} spent${value && g.revenue ? `, revenue ${money(g.revenue)}, ROAS ${g.roas ?? "n/a"}` : ""}`;
  return [
    `Results by campaign goal: the campaigns are optimized for ${lines.length} different results. Talk about each one on its own with its own numbers and cost (never add them together or blend their costs); the headline above counts the KPI's result only.`,
    ...lines.map((g) => `- ${g.label} (${g.campaigns} ${g.campaigns === 1 ? "campaign" : "campaigns"}, ${g.share ?? 0}% of spend): ${m.main.label}: ${one(g, g.value)}; ${m.compare.label}: ${one(g.before, g.value)}${g.mtd && m.mtd ? `; ${m.mtd.label}: ${one(g.mtd, g.value)}` : ""}`),
  ];
}
