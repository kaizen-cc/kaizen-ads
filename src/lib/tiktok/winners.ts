// TikTok's side of Ads Lab, the plain parts: which of our own clients' TikTok ads count as winners. TikTok has no
// public ad library API for US ads, so there is no "In the market" for TikTok: everything here is our accounts.
//
// Hall of Fame (the same rule as Meta's, src/lib/hall-of-fame.ts): an ad that ran 30+ days, spent $300+ with 5+
// results, and over that run hit or beat the client's TikTok KPI target (cost per result at or under it, or ROAS at or
// above it); clients without a TikTok target are held to their sub-vertical's researched "good" cost per result. It
// stays six months after it last ran as a winner.
//
// Live winners: ads TikTok is delivering now that beat that same yardstick over the last 14 days ($100+, 3+ results,
// the bar Meta's live winners use).
//
// The creative number shown with each: the 6s view rate, TikTok's 6-second views over impressions (src/lib/tiktok/core.ts
// hookRate, the same math; kept here so the cards can use this file without the server's crypto). TikTok judges
// creative on it: the share of people shown the ad who stayed six seconds.

const DAY = 86_400_000;
export const FAME_MIN_DAYS = 30;
export const FAME_MIN_SPEND = 300;
export const FAME_MIN_RESULTS = 5;
export const FAME_KEEP_DAYS = 182;
export const LIVE_DAYS = 14;
export const LIVE_MIN_SPEND = 100;
export const LIVE_MIN_RESULTS = 3;

/** One ad's day, as tiktok_ad_daily keeps it */
export type TikTokAdDay = {
  ad_id: string;
  date: string;
  ad_name?: string | null;
  campaign_name?: string | null;
  spend: number | string | null;
  impressions: number | string | null;
  clicks?: number | string | null;
  conversions: number | string | null;
  conversion_value: number | string | null;
  purchases: number | string | null;
  video_2s?: number | string | null;
  video_6s: number | string | null;
};

/** What a client's TikTok ads are judged against */
export type Yardstick = {
  /** cpa: cost per result at or under target; roas: purchase value over spend at or above it */
  kind: "cpa" | "roas";
  /** What counts as a result: TikTok's optimization event, or complete payments */
  counts: "conversions" | "purchases";
  target: number;
  source: "kpi" | "benchmark";
  /** The result in words ("Conversions", "Purchases") */
  label: string;
  /** Only campaigns whose name has this (the KPI card's campaign filter) */
  match: string | null;
};

type TargetRow = { conversion: string | null; target: number | string | null; campaign_match?: string | null };
type Benchmark = { metric: string; good?: number | null };
type SubVertical = { conversion: string | null; benchmarks: Benchmark[] | null } | null | undefined;

/**
 * The yardstick for a client: its own TikTok KPI target when it counts a business result (conversions, purchases or
 * ROAS; clicks don't), else its sub-vertical's "good" cost per result (purchases for a sub-vertical that sells, the
 * optimization event otherwise). null: nothing to judge against.
 */
export function yardstickFor(t: TargetRow | null | undefined, sub: SubVertical): Yardstick | null {
  const target = Number(t?.target);
  if (t && target > 0) {
    const match = t.campaign_match?.trim() || null;
    if (t.conversion === "tiktok_roas") return { kind: "roas", counts: "purchases", target, source: "kpi", label: "Purchases", match };
    if (t.conversion === "tiktok_purchases") return { kind: "cpa", counts: "purchases", target, source: "kpi", label: "Purchases", match };
    if (t.conversion === "tiktok_conversions" || !t.conversion) return { kind: "cpa", counts: "conversions", target, source: "kpi", label: "Conversions", match };
  }
  if (!sub) return null;
  const good = Number((sub.benchmarks ?? []).find((b) => b.metric === "cost_per_result" && b.good != null)?.good);
  if (!(good > 0)) return null;
  const words = (sub.conversion ?? "").toLowerCase();
  if (!words.trim()) return null;
  const buys = /purchase|order|sale|checkout/.test(words);
  return { kind: "cpa", counts: buys ? "purchases" : "conversions", target: good, source: "benchmark", label: buys ? "Purchases" : "Conversions", match: null };
}

const num = (v: unknown) => Number(v) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The 6s view rate, as a percent: 6-second views over impressions (null with no impressions) */
export const sixSecondRate = (views6s: number, impressions: number) => (impressions > 0 ? Math.round((views6s / impressions) * 10000) / 100 : null);

export type Judged = {
  adId: string;
  adName: string | null;
  campaign: string | null;
  firstDate: string;
  lastDate: string;
  daysLive: number;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
  /** Cost per result, or ROAS */
  value: number;
  /** How far past the target: 0.25 = 25% better */
  beatBy: number;
  sixSecRate: number | null;
  ctr: number | null;
};

/** One ad's days added up against the yardstick: null when it has no result to judge (no spend, no results) */
export function judge(adId: string, days: TikTokAdDay[], y: Yardstick): Judged | null {
  const spent = days.filter((d) => num(d.spend) > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!spent.length) return null;
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let results = 0;
  let worth = 0;
  let v6 = 0;
  for (const d of days) {
    spend += num(d.spend);
    impressions += num(d.impressions);
    clicks += num(d.clicks);
    results += num(y.counts === "purchases" ? d.purchases : d.conversions);
    worth += num(d.conversion_value);
    v6 += num(d.video_6s);
  }
  let value: number;
  let beatBy: number;
  if (y.kind === "roas") {
    value = spend > 0 ? worth / spend : 0;
    beatBy = (value - y.target) / y.target;
  } else {
    if (results <= 0) return null;
    value = spend / results;
    beatBy = (y.target - value) / y.target;
  }
  const first = spent[0].date;
  const last = spent[spent.length - 1].date;
  const named = [...days].reverse().find((d) => d.ad_name || d.campaign_name);
  return {
    adId,
    adName: named?.ad_name ?? null,
    campaign: named?.campaign_name ?? null,
    firstDate: first,
    lastDate: last,
    daysLive: Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1,
    spend: r2(spend),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    results: Math.round(results * 10) / 10,
    value: r2(value),
    beatBy: Math.round(beatBy * 1000) / 1000,
    sixSecRate: sixSecondRate(v6, impressions),
    ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
  };
}

/** Days grouped by ad, keeping only the campaigns the yardstick covers */
function byAd(days: TikTokAdDay[], y: Yardstick) {
  const m = new Map<string, TikTokAdDay[]>();
  const match = y.match?.toLowerCase() ?? null;
  for (const d of days) {
    if (match && !(d.campaign_name ?? "").toLowerCase().includes(match)) continue;
    const id = String(d.ad_id);
    const list = m.get(id);
    if (list) list.push(d);
    else m.set(id, [d]);
  }
  return m;
}

/** The ad passes the bar: enough spend and results, and at or past the target */
const passes = (j: Judged, y: Yardstick, minSpend: number, minResults: number) => j.spend >= minSpend && (y.kind === "roas" || j.results >= minResults) && j.value > 0 && j.beatBy >= 0;

/**
 * One client's TikTok Hall of Fame from its ad days: 30+ days between the first and last day with spend, $300+, 5+
 * results (a ROAS target counts value instead), at or past the yardstick over the whole run, and its last day within
 * six months of today. Best first.
 */
export function fameWinners(days: TikTokAdDay[], y: Yardstick, today: string): Judged[] {
  const keepFrom = new Date(Date.parse(today) - FAME_KEEP_DAYS * DAY).toISOString().slice(0, 10);
  const out: Judged[] = [];
  for (const [id, list] of byAd(days, y)) {
    const j = judge(id, list, y);
    if (!j || j.daysLive < FAME_MIN_DAYS || j.lastDate < keepFrom) continue;
    if (passes(j, y, FAME_MIN_SPEND, FAME_MIN_RESULTS)) out.push(j);
  }
  return out.sort((a, b) => b.beatBy - a.beatBy);
}

/**
 * One client's live TikTok winners: ads TikTok is delivering now (active) that beat the yardstick over the last 14
 * days, through today, with $100+ and 3+ results in that window. Best first.
 */
export function liveWinners(days: TikTokAdDay[], y: Yardstick, active: ReadonlySet<string>, today: string): Judged[] {
  const from = new Date(Date.parse(today) - (LIVE_DAYS - 1) * DAY).toISOString().slice(0, 10);
  const recent = days.filter((d) => d.date >= from && d.date <= today && active.has(String(d.ad_id)));
  const out: Judged[] = [];
  for (const [id, list] of byAd(recent, y)) {
    const j = judge(id, list, y);
    if (j && passes(j, y, LIVE_MIN_SPEND, LIVE_MIN_RESULTS)) out.push(j);
  }
  return out.sort((a, b) => b.beatBy - a.beatBy);
}

/** TikTok's ad status (operation_status): switched on */
export const isActiveStatus = (status: string | null | undefined) => /^(ENABLE|ACTIVE)$/i.test(String(status ?? "").trim());

/**
 * The ads running now: switched on in TikTok and spending in the last 3 days (an ad left on in a paused campaign
 * isn't running). Ads TikTok's list hasn't reached yet count when they spent.
 */
export function activeAds(ads: { ad_id: string; status: string | null }[], days: { ad_id: string; date: string; spend: number | string | null }[], today: string): Set<string> {
  const from = new Date(Date.parse(today) - 2 * DAY).toISOString().slice(0, 10);
  const status = new Map(ads.map((a) => [String(a.ad_id), a.status]));
  const out = new Set<string>();
  for (const d of days) {
    const id = String(d.ad_id);
    if (d.date < from || num(d.spend) <= 0) continue;
    const s = status.get(id);
    if (s === undefined || s === null || isActiveStatus(s)) out.add(id);
  }
  return out;
}

/** The hook: the ad text's opening line (TikTok ads have no headline; the first words on screen and in the caption) */
export function hookOf(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const first = t.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? t;
  return first.length > 120 ? `${first.slice(0, 117).trimEnd()}...` : first;
}

/** The result against the target, in words for a card ("$18.20 vs $25 target per conversion", "3.1x ROAS vs 2.5x target") */
export function resultLine(a: { roas: boolean; value: number; target: number; targetSource: "kpi" | "benchmark"; conversion: string }) {
  const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
  if (a.roas) return `${a.value.toFixed(2)}x ROAS vs ${a.target}x ${a.targetSource === "kpi" ? "target" : "benchmark"}`;
  return `${money(a.value)} vs ${money(a.target)} ${a.targetSource === "kpi" ? "target" : "benchmark"} per ${a.conversion.toLowerCase().replace(/s$/, "")}`;
}
