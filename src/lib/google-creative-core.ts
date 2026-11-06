import { inScope, type KpiScope } from "@/lib/kpi/scope";

// The creative analysis of a Google Ads audit, as plain functions: on Google the creative is the copy. The KPI's
// campaigns only: the best and worst RSA headlines and descriptions (Google's Best / Good / Low rating, impressions,
// CTR, conversions, cost per conversion or ROAS), the Performance Max asset groups, and the themes in the search terms
// that convert (what the winning ads answer, and what no headline does yet).

export type GoogleAssetIn = {
  kind: "headline" | "long_headline" | "description" | "sitelink" | "callout";
  text: string;
  label: string | null;
  pinned: string | null;
  source: "rsa" | "pmax" | "campaign";
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
  spend: number;
};
export type GroupIn = { name: string; campaignId: string; campaignName: string; strength: string | null; impressions: number; clicks: number; conversions: number; value: number; spend: number };
export type TermIn = { term: string; campaignId: string; campaignName: string; spend: number; clicks: number; conversions: number; value: number };

export type GoogleCopyStat = { kind: GoogleAssetIn["kind"]; text: string; label: string | null; pinned: string | null; impressions: number; clicks: number; ctr: number | null; conversions: number; spend: number; cpa: number | null; roas: number | null; campaigns: number };
export type GoogleCreativeAnalysis = {
  days: number;
  roas: boolean;
  target: number | null;
  headlines: { top: GoogleCopyStat[]; bottom: GoogleCopyStat[] };
  descriptions: { top: GoogleCopyStat[]; bottom: GoogleCopyStat[] };
  /** Performance Max asset groups, by spend */
  groups: { name: string; campaign: string; strength: string | null; spend: number; conversions: number; cpa: number | null; roas: number | null; ctr: number | null; pmaxLow: number }[];
  /** What the converting searches are about, by conversions */
  themes: { theme: string; terms: string[]; conversions: number; spend: number; covered: boolean }[];
  low: number;
  read?: { common: string[]; fatiguing: string[]; gaps: string[] };
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const STOP = new Set("a an and the of for to in on near me my at by with from best top cheap how what is are i we you your our or vs near-me open now get buy price prices cost".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Add up each piece of copy across the ad groups and campaigns that ran it (the KPI's campaigns only) */
export function googleCopyStats(assets: GoogleAssetIn[], scope: KpiScope | null): GoogleCopyStat[] {
  type Acc = { kind: GoogleAssetIn["kind"]; text: string; label: string | null; pinned: string | null; impressions: number; clicks: number; conversions: number; value: number; spend: number; ids: Set<string> };
  const by = new Map<string, Acc>();
  const rank = ["BEST", "GOOD", "LOW", "LEARNING", "PENDING", "UNKNOWN"];
  for (const a of assets) {
    if (!inScope(scope, { id: a.campaignId, name: a.campaignName })) continue;
    const k = `${a.kind}|${a.text.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const s = by.get(k) ?? { kind: a.kind, text: a.text, label: null, pinned: null, impressions: 0, clicks: 0, conversions: 0, value: 0, spend: 0, ids: new Set<string>() };
    s.impressions += a.impressions;
    s.clicks += a.clicks;
    s.conversions += a.conversions;
    s.value += a.value;
    s.spend += a.spend;
    if (a.label && (!s.label || rank.indexOf(a.label) < rank.indexOf(s.label))) s.label = a.label;
    s.pinned ??= a.pinned;
    s.ids.add(a.campaignId);
    by.set(k, s);
  }
  return [...by.values()].map(({ ids, value, ...s }) => ({
    ...s,
    spend: r2(s.spend),
    conversions: Math.round(s.conversions * 10) / 10,
    campaigns: ids.size,
    ctr: s.impressions ? Math.round((s.clicks / s.impressions) * 10000) / 100 : null,
    cpa: s.conversions && s.spend ? r2(s.spend / s.conversions) : null,
    roas: s.spend && value ? r2(value / s.spend) : null,
  }));
}

/** Best and worst of one kind: converting and efficient (or rated Best) on top; rated Low or seen a lot with nothing back at the bottom */
export function rankGoogleCopy(stats: GoogleCopyStat[], kind: GoogleCopyStat["kind"], roas: boolean, size = 5) {
  const xs = stats.filter((s) => s.kind === kind && s.impressions >= 100);
  const eff = (s: GoogleCopyStat) => (roas ? (s.roas ?? 0) : s.cpa ? 1 / s.cpa : s.conversions ? 1 : 0);
  const top = xs
    .filter((s) => s.conversions > 0 || s.label === "BEST")
    .filter((s) => s.label !== "LOW")
    .sort((a, b) => Number(b.label === "BEST") - Number(a.label === "BEST") || eff(b) - eff(a) || b.conversions - a.conversions || (b.ctr ?? 0) - (a.ctr ?? 0))
    .slice(0, size);
  const taken = new Set(top.map((s) => s.text));
  const bottom = xs
    .filter((s) => !taken.has(s.text) && (s.label === "LOW" || (s.conversions === 0 && s.impressions >= 1000)))
    .sort((a, b) => Number(b.label === "LOW") - Number(a.label === "LOW") || b.impressions - a.impressions)
    .slice(0, size);
  return { top, bottom };
}

/** The themes in the converting search terms (shared words and pairs, by conversions) and whether any headline answers them */
export function termThemes(terms: TermIn[], headlines: string[], scope: KpiScope | null, size = 8) {
  const kept = terms.filter((t) => inScope(scope, { id: t.campaignId, name: t.campaignName }));
  const grams = new Map<string, { terms: Set<string>; conversions: number; spend: number }>();
  for (const t of kept) {
    const w = words(t.term);
    const keys = new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
    for (const k of keys) {
      const g = grams.get(k) ?? { terms: new Set(), conversions: 0, spend: 0 };
      g.terms.add(t.term);
      g.conversions += t.conversions;
      g.spend += t.spend;
      grams.set(k, g);
    }
  }
  const said = headlines.map((h) => h.toLowerCase()).join(" | ");
  const picked: GoogleCreativeAnalysis["themes"] = [];
  // Pairs first when they hold most of a word's conversions, so "emergency plumber" wins over "plumber"
  for (const [theme, g] of [...grams].filter(([, g]) => g.terms.size >= 2).sort((a, b) => b[1].conversions - a[1].conversions || b[0].split(" ").length - a[0].split(" ").length)) {
    if (picked.some((p) => p.theme.includes(theme) || theme.includes(p.theme))) continue;
    picked.push({ theme, terms: [...g.terms].slice(0, 4), conversions: Math.round(g.conversions * 10) / 10, spend: r2(g.spend), covered: theme.split(" ").every((w) => said.includes(w)) });
    if (picked.length >= size) break;
  }
  return picked;
}

export function analyzeGoogleCopy(o: { assets: GoogleAssetIn[]; groups: GroupIn[]; terms: TermIn[]; scope: KpiScope | null; roas: boolean; target: number | null; days?: number }): GoogleCreativeAnalysis | null {
  const stats = googleCopyStats(o.assets, o.scope);
  const groups = o.groups.filter((g) => inScope(o.scope, { id: g.campaignId, name: g.campaignName }));
  if (!stats.length && !groups.length) return null;
  const pmaxLow = (name: string) => o.assets.filter((a) => a.source === "pmax" && a.label === "LOW" && a.campaignName === name).length;
  const headlines = rankGoogleCopy(stats, "headline", o.roas);
  return {
    days: o.days ?? 90,
    roas: o.roas,
    target: o.target,
    headlines,
    descriptions: rankGoogleCopy(stats, "description", o.roas),
    groups: groups
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8)
      .map((g) => ({ name: g.name, campaign: g.campaignName, strength: g.strength, spend: r2(g.spend), conversions: Math.round(g.conversions * 10) / 10, cpa: g.conversions && g.spend ? r2(g.spend / g.conversions) : null, roas: g.spend && g.value ? r2(g.value / g.spend) : null, ctr: g.impressions ? Math.round((g.clicks / g.impressions) * 10000) / 100 : null, pmaxLow: pmaxLow(g.campaignName) })),
    themes: termThemes(o.terms, stats.filter((s) => s.kind === "headline" || s.kind === "long_headline").map((s) => s.text), o.scope),
    low: stats.filter((s) => s.label === "LOW").length,
  };
}

/** The analysis written for the Google auditor */
export function googleCreativeText(a: GoogleCreativeAnalysis) {
  const kpi = (s: { cpa: number | null; roas: number | null; conversions: number }) => (a.roas ? `ROAS ${s.roas ?? 0}x` : s.cpa != null ? `$${s.cpa}/conv` : `${s.conversions} conv`);
  const line = (s: GoogleCopyStat) => `- "${s.text}"${s.label ? ` [Google: ${s.label.toLowerCase()}]` : ""}${s.pinned ? ` [pinned ${s.pinned.toLowerCase()}]` : ""}: ${s.impressions.toLocaleString("en-US")} impressions, CTR ${s.ctr ?? "?"}%, ${s.conversions} conv, ${kpi(s)}${s.spend ? `, $${Math.round(s.spend)}` : ""}`;
  return [
    `Last ${a.days} days, the KPI's campaigns only. ${a.low} assets rated Low by Google.`,
    `TOP HEADLINES\n${a.headlines.top.map(line).join("\n") || "(none converting yet)"}`,
    `BOTTOM HEADLINES\n${a.headlines.bottom.map(line).join("\n") || "(none clearly weak)"}`,
    `TOP DESCRIPTIONS\n${a.descriptions.top.map(line).join("\n") || "(none converting yet)"}`,
    `BOTTOM DESCRIPTIONS\n${a.descriptions.bottom.map(line).join("\n") || "(none clearly weak)"}`,
    `PERFORMANCE MAX ASSET GROUPS\n${a.groups.map((g) => `- ${g.campaign} › ${g.name}${g.strength ? ` (ad strength ${g.strength.toLowerCase()})` : ""}: $${Math.round(g.spend)}, ${g.conversions} conv, ${kpi(g)}, CTR ${g.ctr ?? "?"}%${g.pmaxLow ? `, ${g.pmaxLow} text assets rated Low` : ""}`).join("\n") || "(no Performance Max)"}`,
    `THEMES IN THE CONVERTING SEARCH TERMS\n${a.themes.map((t) => `- "${t.theme}": ${t.conversions} conv from ${t.terms.map((x) => `"${x}"`).join(", ")}${t.covered ? "" : " · NO HEADLINE SAYS IT"}`).join("\n") || "(not enough converting searches)"}`,
  ].join("\n\n");
}

export const GOOGLE_CREATIVE_READ_RULES = `creativeRead: your read of the creative_analysis (on Google the creative is the copy; the KPI's campaigns only). common: 2 to 4 lines on what the top headlines and descriptions share (the promise, offer, proof, words from the converting searches) that the bottom ones don't, with the numbers. fatiguing: 1 to 3 lines on what Google rates Low, what's seen a lot with nothing back, and weak Performance Max asset groups; empty when nothing is. gaps: 1 to 3 lines on the converting search themes no headline answers, and messages or assets missing (sitelinks, callouts, a price or offer line). Quote the copy.`;
