// Custom report analysis: the questions clients ask in their own words that a standard report doesn't answer.
//   • Offers or price points compared ($99 against $89, $49 and $7), matched by campaign, ad set and ad names.
//   • Before and after a dated change (a new checkout page): conversion rates and cost per result on each side.
//   • The top and the worst creatives over any range.
// Read from Meta's ad-level insights over any range (up to 37 months back) and worked out here. This file is pure, so
// it's tested; the reading lives in custom-analysis.ts.

export type OfferGroup = { label: string; match: string[] };
export type MatchOn = "any" | "campaign" | "adset" | "ad";

/** One ad's numbers for a month (or the whole range), from a Meta insight row */
export type AdRow = {
  month: string | null;
  ad_id: string;
  ad_name: string;
  adset_name: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  actions: Record<string, number>;
  values: Record<string, number>;
};

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const r2 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const actionMap = (v: unknown) => Object.fromEntries(((Array.isArray(v) ? v : []) as { action_type: string; value: string }[]).map((a) => [a.action_type, num(a.value)]));

/** A Meta insight row (ad level) as an AdRow */
export function fromInsight(r: Record<string, unknown>, monthly: boolean): AdRow {
  return {
    month: monthly ? String(r.date_start ?? "").slice(0, 7) || null : null,
    ad_id: String(r.ad_id ?? ""),
    ad_name: String(r.ad_name ?? ""),
    adset_name: String(r.adset_name ?? ""),
    campaign_name: String(r.campaign_name ?? ""),
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.inline_link_clicks ?? r.clicks),
    actions: actionMap(r.actions),
    values: actionMap(r.action_values),
  };
}

/** What counts as a result when the KPI doesn't say, most valuable first */
export const RESULT_FALLBACK = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "lead", "complete_registration", "schedule_total", "landing_page_view", "link_click"];
const LPV = ["landing_page_view", "omni_landing_page_view"];
const CHECKOUT = ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"];
const pick = (m: Record<string, number>, keys: string[]) => keys.reduce((best, k) => Math.max(best, m[k] ?? 0), 0);

/** The result type to count: the first preferred one the rows report at all */
export function resultTypeOf(rows: AdRow[], preferred: string[] = []): string | null {
  const prefs = [...preferred.filter((t) => t && t !== "campaign_goal"), ...RESULT_FALLBACK];
  return prefs.find((t) => rows.some((r) => (r.actions[t] ?? 0) > 0)) ?? null;
}

/**
 * The offers a client named in plain words: "$99, $89, $49 and $7" → four groups matched on 99, 89, 49 and 7. Also
 * "99/89/49" after the word offer or price. Empty when no price points are named.
 */
export function offersFromText(text: string): OfferGroup[] {
  const t = String(text ?? "");
  const found = [...t.matchAll(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/g)].map((m) => m[1]);
  if (!found.length) {
    const m = t.match(/(?:offers?|price points?|prices?)\D{0,20}((?:\d{1,5}\s*(?:,|\/|and|&|or|vs\.?)\s*)+\d{1,5})/i);
    if (m) found.push(...m[1].split(/[^\d]+/).filter(Boolean));
  }
  const uniq = [...new Set(found.map((x) => x.replace(/\.0+$/, "")))].slice(0, 12);
  return uniq.length >= 2 ? uniq.map((x) => ({ label: `$${x}`, match: [x] })) : [];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a name carries one of a group's patterns. A price ("99", "$99", "99.00") matches as a whole number, so $99 is
 * never found inside $199, $9.99 or 990; anything else matches anywhere, ignoring case.
 */
export function nameMatches(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^\$/, "");
    if (!p) return false;
    // Not inside another number or a word ("V7", "7day") and not a date ("Oct 7"), so a small price like $7 isn't found
    // in a version tag or the day an ad was made
    if (/^\d+(\.\d+)?$/.test(p)) return new RegExp(`(?<!(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s{1,2})(?<![\\da-z.])\\$?${esc(p)}(?:\\.0+)?(?![\\da-z]|\\.\\d)`).test(n);
    return n.includes(p);
  });
}

/** Which group an ad belongs to: its own name first, then its ad set's, then its campaign's (the most specific wins) */
export function groupOf(r: Pick<AdRow, "ad_name" | "adset_name" | "campaign_name">, groups: OfferGroup[], on: MatchOn = "any"): string | null {
  const levels = on === "any" ? [r.ad_name, r.adset_name, r.campaign_name] : [on === "ad" ? r.ad_name : on === "adset" ? r.adset_name : r.campaign_name];
  for (const name of levels) {
    const g = groups.find((x) => nameMatches(name, x.match));
    if (g) return g.label;
  }
  return null;
}

export type Agg = {
  label: string;
  ads: number;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
  revenue: number | null;
  landing_views: number;
  checkouts: number;
  cost_per_result: number | null;
  roas: number | null;
  ctr: number | null;
  cpm: number | null;
  /** results per link click, % */
  click_to_result: number | null;
  /** results per landing page view, % */
  page_to_result: number | null;
  /** checkouts started that became results, % */
  checkout_to_result: number | null;
};

/** Rows added up into one line, with the rates that make offers and periods comparable */
export function aggregate(rows: AdRow[], type: string | null, roas: boolean, label: string): Agg {
  let spend = 0, impressions = 0, clicks = 0, results = 0, value = 0, lpv = 0, co = 0;
  const ads = new Set<string>();
  for (const r of rows) {
    spend += r.spend;
    impressions += r.impressions;
    clicks += r.clicks;
    if (type) {
      results += r.actions[type] ?? 0;
      value += r.values[type] ?? 0;
    }
    lpv += pick(r.actions, LPV);
    co += pick(r.actions, CHECKOUT);
    if (r.ad_id) ads.add(r.ad_id);
  }
  const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);
  return {
    label,
    ads: ads.size,
    spend: r2(spend) ?? 0,
    impressions,
    clicks,
    results: r2(results) ?? 0,
    revenue: roas ? r2(value) : null,
    landing_views: lpv,
    checkouts: co,
    cost_per_result: results > 0 ? r2(spend / results) : null,
    roas: roas && spend > 0 ? r2(value / spend) : null,
    ctr: pct(clicks, impressions),
    cpm: impressions > 0 ? r2((spend / impressions) * 1000) : null,
    click_to_result: pct(results, clicks),
    page_to_result: pct(results, lpv),
    checkout_to_result: co > 0 ? pct(results, co) : null,
  };
}

export type OfferBreakdown = { groups: Agg[]; unmatched: Agg; months: { month: string; groups: Agg[] }[] };

/** The offers side by side over the range (and month by month when the rows are monthly), plus what matched none */
export function byOffer(rows: AdRow[], groups: OfferGroup[], type: string | null, roas: boolean, on: MatchOn = "any"): OfferBreakdown {
  const tagged = rows.map((r) => ({ r, g: groupOf(r, groups, on) }));
  const of = (label: string, rs: { r: AdRow; g: string | null }[]) => aggregate(rs.filter((x) => x.g === label).map((x) => x.r), type, roas, label);
  const months = [...new Set(rows.map((r) => r.month).filter((m): m is string => Boolean(m)))].sort();
  return {
    groups: groups.map((g) => of(g.label, tagged)),
    unmatched: aggregate(tagged.filter((x) => !x.g).map((x) => x.r), type, roas, "Not matched to an offer"),
    months: months.map((m) => {
      const inMonth = tagged.filter((x) => x.r.month === m);
      return { month: m, groups: groups.map((g) => of(g.label, inMonth)) };
    }),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayN = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 86_400_000);
const dayOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/**
 * The two windows around a change made on `date`: the same number of days before it and from it on (the day of the change
 * counts as after), as many as asked for, else as many as there are since the change (2 to 90), never past yesterday.
 */
export function changeWindows(date: string, today: string, days?: number | null): { before: { start: string; end: string }; after: { start: string; end: string }; days: number } | { error: string } {
  if (!DAY.test(date)) return { error: "The change date must be YYYY-MM-DD." };
  const yesterday = dayN(today) - 1;
  const d = dayN(date);
  if (d > yesterday) return { error: "The change has to be before today to compare after it." };
  const room = yesterday - d + 1;
  const n = Math.max(1, Math.min(90, Math.round(days ?? 0) || Math.min(room, 30), room));
  return { before: { start: dayOf(d - n), end: dayOf(d - 1) }, after: { start: date, end: dayOf(d + n - 1) }, days: n };
}

export type Shift = { metric: string; before: number | null; after: number | null; change_pct: number | null; better: boolean | null };

/** What moved between the two sides of a change: the rates first (they don't depend on how much was spent) */
export function compareSides(before: Agg, after: Agg): Shift[] {
  const keys: [keyof Agg, string, boolean][] = [
    ["click_to_result", "Conversion rate (results per link click, %)", true],
    ["page_to_result", "Landing page conversion rate (results per landing page view, %)", true],
    ["checkout_to_result", "Checkout completion (results per checkout started, %)", true],
    ["cost_per_result", "Cost per result", false],
    ["roas", "ROAS", true],
    ["ctr", "CTR (%)", true],
    ["cpm", "CPM", false],
    ["spend", "Spend", true],
    ["results", "Results", true],
  ];
  return keys
    .map(([k, label, upGood]) => {
      const b = before[k] as number | null;
      const a = after[k] as number | null;
      const change = a != null && b != null && b !== 0 ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null;
      return { metric: label, before: b, after: a, change_pct: change, better: change == null || k === "spend" || change === 0 ? null : change > 0 === upGood };
    })
    .filter((s) => s.before != null || s.after != null);
}

export type CreativeRank = Agg & { ad_id: string; ad_name: string; campaign: string; adset: string };

/**
 * The best and the worst ads over the range, among the ones that spent enough to judge (default: the larger of $50 and
 * 2% of the spend, at most $500). Best: highest ROAS when it's purchases with value, else lowest cost per result. Worst:
 * the reverse, with ads that spent and got nothing first.
 */
export function rankCreatives(rows: AdRow[], type: string | null, roas: boolean, opts: { top?: number; worst?: number; minSpend?: number | null } = {}) {
  const byAd = new Map<string, AdRow[]>();
  for (const r of rows) if (r.ad_id) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  const all: CreativeRank[] = [...byAd.values()].map((rs) => ({ ...aggregate(rs, type, roas, rs[0].ad_name), ad_id: rs[0].ad_id, ad_name: rs[0].ad_name, campaign: rs[0].campaign_name, adset: rs[0].adset_name }));
  const total = all.reduce((n, a) => n + a.spend, 0);
  const threshold = opts.minSpend != null && opts.minSpend >= 0 ? opts.minSpend : Math.min(500, Math.max(50, Math.round(total * 0.02)));
  const judged = all.filter((a) => a.spend >= threshold);
  const useRoas = roas && judged.some((a) => (a.roas ?? 0) > 0);
  const score = (a: CreativeRank) => (useRoas ? (a.roas ?? 0) : a.cost_per_result == null ? -Infinity : -a.cost_per_result);
  const withResults = judged.filter((a) => a.results > 0);
  const top = [...withResults].sort((a, z) => score(z) - score(a) || z.results - a.results).slice(0, Math.max(0, Math.min(10, opts.top ?? 5)));
  const topIds = new Set(top.map((a) => a.ad_id));
  const nothing = judged.filter((a) => a.results === 0).sort((a, z) => z.spend - a.spend);
  const weak = withResults.filter((a) => !topIds.has(a.ad_id)).sort((a, z) => score(a) - score(z));
  const worst = [...nothing, ...weak].filter((a) => !topIds.has(a.ad_id)).slice(0, Math.max(0, Math.min(10, opts.worst ?? 5)));
  return { top, worst, threshold, judged: judged.length, ads: all.length, by: useRoas ? "roas" : "cost_per_result" };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date in a client's standing ask ("the checkout page changed on Oct 14", "since 2026-10-14"), as YYYY-MM-DD. A month
 * and day without a year is the most recent one before today.
 */
export function dateInText(text: string, today: string): string | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const m = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]) + 1;
  const d = Number(m[2]);
  if (d < 1 || d > 31) return null;
  let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  const pad = (x: number) => String(x).padStart(2, "0");
  if (!m[3] && `${y}-${pad(mo)}-${pad(d)}` >= today) y -= 1;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** The custom analyses a client's report style asks for, read from its rules, so the weekly and monthly drafts include them */
export function asksInStyle(rules: string[], today: string): { offers: OfferGroup[]; worst: boolean; change: { date: string; what: string } | null } {
  let offers: OfferGroup[] = [];
  let worst = false;
  let change: { date: string; what: string } | null = null;
  for (const r of rules) {
    if (!offers.length && /\b(offer|price|pricing|tier|plan)s?\b/i.test(r)) offers = offersFromText(r);
    if (/\b(worst|bottom|weakest|lowest[- ]performing|underperform\w*|losers?)\b/i.test(r)) worst = true;
    if (!change && /\b(before|after|since|changed?|update[ds]?|new)\b/i.test(r)) {
      const d = dateInText(r, today);
      if (d) change = { date: d, what: r };
    }
  }
  return { offers, worst, change };
}
