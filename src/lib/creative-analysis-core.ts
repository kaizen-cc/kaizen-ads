// The creative analysis inside an audit, as plain functions (shared by the account audit, the business audit and the
// pages that show them): every ad in the KPI's campaigns over the last 30 days, ranked by the account's own KPI, the
// best and the worst with their thumbnails and numbers (hook rate, hold, watch %, CTR, CPA or ROAS, share of spend),
// what the winners share (angle, avatar, format, hook, offer, length), what's tiring, and what's missing.

export type CreativeAdStats = {
  id: string;
  name: string;
  headline: string | null;
  /** The ad's picture, through our ad-media proxy */
  thumb: string;
  format: string | null;
  angle: string | null;
  avatar: string | null;
  hook: string | null;
  offer: string | null;
  videoSeconds: number | null;
  spend: number;
  share: number; // % of the window's spend
  results: number;
  cpa: number | null;
  roas: number | null;
  ctr: number | null;
  hookRate: number | null;
  holdRate: number | null;
  watchPct: number | null;
  age: number; // days since it first spent
  fatigue: "tiring" | "tired" | null;
};

export type Trait = { dimension: "angle" | "avatar" | "format" | "hook" | "offer" | "length"; value: string; winners: number; losers: number };

export type CreativeAnalysis = {
  days: number;
  roas: boolean;
  target: number | null;
  label: string;
  spend: number;
  ads: number;
  /** The account's own average over the window: what "good" means here */
  average: number | null;
  top: CreativeAdStats[];
  bottom: CreativeAdStats[];
  traits: Trait[];
  fatiguing: { id: string; name: string; thumb: string; severity: "tiring" | "tired"; note: string }[];
  gaps: string[];
  /** The auditor's read of it */
  read?: { common: string[]; fatiguing: string[]; gaps: string[] };
};

export type AdInput = Omit<CreativeAdStats, "share" | "cpa" | "roas" | "thumb"> & { revenue: number };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Seconds of video as a length band ("image" for no video) */
export function lengthBand(seconds: number | null, format: string | null) {
  if (seconds == null) return format && format !== "video" ? format : null;
  return seconds <= 15 ? "video up to 15s" : seconds <= 30 ? "video 16 to 30s" : seconds <= 60 ? "video 31 to 60s" : "video over 60s";
}

/**
 * Rank the window's ads by the KPI. Only ads with a fair share of spend are judged (at least 2% of the window or $20);
 * the top are the most efficient with results, the bottom the least efficient or the biggest spenders with none.
 */
export function rankCreatives(input: AdInput[], o: { roas: boolean; target: number | null; label: string; days: number; size?: number }): Omit<CreativeAnalysis, "fatiguing" | "gaps" | "read"> {
  const size = o.size ?? 5;
  const spend = input.reduce((s, a) => s + a.spend, 0);
  const results = input.reduce((s, a) => s + a.results, 0);
  const revenue = input.reduce((s, a) => s + a.revenue, 0);
  const average = o.roas ? (spend ? r2(revenue / spend) : null) : results ? r2(spend / results) : null;
  const ads: CreativeAdStats[] = input.map(({ revenue: rev, ...a }) => ({
    ...a,
    thumb: `/api/ad-media/${a.id}`,
    share: spend ? Math.round((a.spend / spend) * 1000) / 10 : 0,
    cpa: a.results ? r2(a.spend / a.results) : null,
    roas: a.spend && rev ? r2(rev / a.spend) : null,
  }));
  const min = Math.max(20, spend * 0.02);
  const judged = ads.filter((a) => a.spend >= min);
  // Efficiency: higher is better (ROAS as is, cost per result inverted)
  const eff = (a: CreativeAdStats) => (o.roas ? (a.roas ?? 0) : a.cpa ? 1 / a.cpa : 0);
  const ref = o.target ?? average;
  const beats = (a: CreativeAdStats) => ref == null || (o.roas ? (a.roas ?? 0) >= ref : (a.cpa ?? Infinity) <= ref);
  const good = judged.filter((a) => (o.roas ? (a.roas ?? 0) > 0 : a.results > 0)).sort((a, b) => eff(b) - eff(a) || b.spend - a.spend);
  // The top: the ones at or better than the target (or the account's average); when none are, the best two
  const top = (good.some(beats) ? good.filter(beats) : good.slice(0, 2)).slice(0, size);
  const taken = new Set(top.map((a) => a.id));
  // The bottom: spend with nothing back first (biggest first), then the least efficient
  const none = judged.filter((a) => !taken.has(a.id) && eff(a) === 0).sort((a, b) => b.spend - a.spend);
  const weak = judged.filter((a) => !taken.has(a.id) && eff(a) > 0).sort((a, b) => eff(a) - eff(b) || b.spend - a.spend);
  // Only ads worse than the account's own average (or the target) count as the bottom
  const worse = weak.filter((a) => !beats(a));
  const bottom = [...none, ...worse].slice(0, size);
  return { days: o.days, roas: o.roas, target: o.target, label: o.label, spend: r2(spend), ads: ads.filter((a) => a.spend > 0).length, average, top, bottom, traits: traitsOf(top, bottom) };
}

/** What the winners have in common, against the losers: each value of each trait, counted on both sides */
export function traitsOf(top: CreativeAdStats[], bottom: CreativeAdStats[]): Trait[] {
  const dims: [Trait["dimension"], (a: CreativeAdStats) => string | null][] = [
    ["angle", (a) => a.angle],
    ["avatar", (a) => a.avatar],
    ["format", (a) => a.format],
    ["hook", (a) => a.hook],
    ["offer", (a) => a.offer],
    ["length", (a) => lengthBand(a.videoSeconds, a.format)],
  ];
  const out: Trait[] = [];
  for (const [dimension, get] of dims) {
    const m = new Map<string, Trait>();
    const add = (a: CreativeAdStats, side: "winners" | "losers") => {
      const v = get(a)?.trim();
      if (!v) return;
      const k = v.toLowerCase();
      const t = m.get(k) ?? { dimension, value: v, winners: 0, losers: 0 };
      t[side]++;
      m.set(k, t);
    };
    top.forEach((a) => add(a, "winners"));
    bottom.forEach((a) => add(a, "losers"));
    out.push(...m.values());
  }
  // Shared by two or more winners first, then what keeps losing
  return out.filter((t) => t.winners >= 2 || t.losers >= 2).sort((a, b) => b.winners - b.losers - (a.winners - a.losers) || b.winners - a.winners);
}

/** What's missing: formats not running, the client's angles and avatars with no ad in the window */
export function gapsOf(ads: { format: string | null; angle: string | null; avatar: string | null; spend: number }[], known: { angles: string[]; avatars: string[] }) {
  const running = ads.filter((a) => a.spend > 0);
  const has = (get: (a: (typeof ads)[number]) => string | null, v: string) => running.some((a) => (get(a) ?? "").toLowerCase() === v.toLowerCase());
  const out: string[] = [];
  const formats = ["image", "video", "carousel"].filter((f) => !has((a) => a.format, f));
  if (running.length && formats.length && formats.length < 3) out.push(`No ${formats.join(" or ")} ads spent in the window.`);
  const angles = known.angles.filter((x) => !has((a) => a.angle, x));
  if (angles.length) out.push(`The client's angles with no ad running: ${angles.slice(0, 6).join(", ")}.`);
  const avatars = known.avatars.filter((x) => !has((a) => a.avatar, x));
  if (avatars.length) out.push(`Avatars no ad speaks to right now: ${avatars.slice(0, 6).join(", ")}.`);
  return out;
}

const money = (x: number | null, roas: boolean) => (x == null ? "none" : roas ? `${x}x` : `$${x}`);

/** The analysis written for the auditor */
export function creativeAnalysisText(a: CreativeAnalysis) {
  const kpi = (x: CreativeAdStats) => (a.roas ? `ROAS ${x.roas ?? 0}x` : x.cpa == null ? "no results" : `$${x.cpa} per ${a.label.replace(/s$/, "")}`);
  const ad = (x: CreativeAdStats) =>
    `- ${x.name} [${x.id}]${x.headline ? ` "${x.headline}"` : ""}: ${kpi(x)}, $${Math.round(x.spend)} (${x.share}% of spend), CTR ${x.ctr ?? "?"}%${x.hookRate != null ? `, hook ${x.hookRate}%` : ""}${x.holdRate != null ? `, hold ${x.holdRate}%` : ""}${x.watchPct != null ? `, watched ${x.watchPct}%` : ""}, ${x.age} days old${[x.format, x.videoSeconds ? `${x.videoSeconds}s` : null, x.angle && `angle: ${x.angle}`, x.avatar && `avatar: ${x.avatar}`, x.hook && `hook: ${x.hook}`, x.offer && `offer: ${x.offer}`].filter(Boolean).length ? ` · ${[x.format, x.videoSeconds ? `${x.videoSeconds}s` : null, x.angle && `angle: ${x.angle}`, x.avatar && `avatar: ${x.avatar}`, x.hook && `hook: ${x.hook}`, x.offer && `offer: ${x.offer}`].filter(Boolean).join(", ")}` : ""}${x.fatigue ? ` · ${x.fatigue}` : ""}`;
  return [
    `Last ${a.days} days, the KPI's campaigns only: ${a.ads} ads spent $${Math.round(a.spend)}; the account's average is ${money(a.average, a.roas)}${a.target != null ? `, target ${money(a.target, a.roas)}` : ""}.`,
    `TOP CREATIVES\n${a.top.map(ad).join("\n") || "(none with a fair share of spend and results)"}`,
    `BOTTOM CREATIVES\n${a.bottom.map(ad).join("\n") || "(none clearly worse than the account)"}`,
    `TRAITS (winners / losers sharing each)\n${a.traits.map((t) => `- ${t.dimension}: ${t.value} (${t.winners} / ${t.losers})`).join("\n") || "(not enough labeled ads to compare)"}`,
    `TIRING\n${a.fatiguing.map((f) => `- ${f.name}: ${f.severity}${f.note ? `, ${f.note}` : ""}`).join("\n") || "(none flagged)"}`,
    `GAPS\n${a.gaps.map((g) => `- ${g}`).join("\n") || "(none found)"}`,
  ].join("\n\n");
}

export const CREATIVE_READ_SCHEMA = {
  type: "object",
  properties: { common: { type: "array", items: { type: "string" } }, fatiguing: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } } },
  required: ["common", "fatiguing", "gaps"],
  additionalProperties: false,
} as const;

export const CREATIVE_READ_RULES = `creativeRead: your read of the creative_analysis (the KPI's campaigns only). common: 2 to 4 lines on what the top creatives have in common that the bottom ones don't (angle, avatar, format, hook, offer, video length), each with the numbers that show it; say so when the sample is too thin. fatiguing: 1 to 3 lines on what's wearing out and what that costs, empty when nothing is. gaps: 1 to 3 lines on the formats, angles or avatars missing that the account needs. Name the ads.`;
