// Launching new Google Ads from the client chat: the plan a buyer agrees to (campaigns, ad groups, keywords by match
// type, negatives, responsive search ads, extensions, Performance Max text), checked here against Google's limits
// before Google is asked, turned into one GoogleAdsService.Mutate batch with temporary resource names (so a new
// campaign, its budget, its ad groups, keywords and ads go in one call, all or nothing), and read back. Pure: shared by
// the server, the launch card and the tests (tests/google-launch.test.ts). Everything launched is created PAUSED.

import type { LaunchItem, LaunchQuestion } from "@/lib/launch-sheet/types";

export type Match = "EXACT" | "PHRASE" | "BROAD";
/** A keyword as Google takes it. from: how its match type was known (written as [kw] / "kw", a match type column, or nothing given) */
export type Kw = { text: string; match: Match; from?: "notation" | "column" | "default" };
export type Pin = 0 | 1 | 2 | 3;
export type AdLine = { text: string; pin: Pin };
export type Rsa = { key: string; headlines: AdLine[]; descriptions: AdLine[]; path1: string; path2: string; finalUrl: string };
export type Sitelink = { text: string; line1: string; line2: string; url: string };
export type Snippet = { header: string; values: string[] };
export type Bidding = "MAXIMIZE_CONVERSIONS" | "MAXIMIZE_CONVERSION_VALUE" | "MAXIMIZE_CLICKS" | "MANUAL_CPC";
export type CampaignType = "SEARCH" | "PERFORMANCE_MAX";

export type GCampaign = {
  key: string;
  mode: "new" | "existing";
  existingId: string | null;
  name: string;
  type: CampaignType;
  /** Daily, in dollars (new campaigns) */
  budget: number | null;
  bidding: Bidding;
  targetCpa: number | null;
  targetRoas: number | null;
  /** Geo target constants (new campaigns): the resource and its name */
  locations: { geo: string; name: string }[];
  negatives: Kw[];
  sitelinks: Sitelink[];
  callouts: string[];
  snippets: Snippet[];
};

export type GAdGroup = { key: string; campaignKey: string; mode: "new" | "existing"; existingId: string | null; name: string; keywords: Kw[]; negatives: Kw[]; rsas: Rsa[] };

/** Performance Max text (and what's asked for by hand) for an asset group */
export type GAssetGroup = {
  key: string;
  campaignKey: string;
  mode: "new" | "existing";
  existingId: string | null;
  name: string;
  finalUrl: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  searchThemes: string[];
  /** Images, videos and audience signals, as the buyer described them: added by hand for now */
  byHand: string[];
};

export type GooglePlan = { account: string; campaigns: GCampaign[]; adGroups: GAdGroup[]; assetGroups: GAssetGroup[]; note: string };

/** What was read from a sheet or the buyer's words, before it's placed in the account */
export type DraftAdGroup = { campaign: string; name: string; finalUrl: string; keywords: Kw[]; negatives: Kw[]; rsas: Omit<Rsa, "key">[] };
export type GoogleDraft = { adGroups: DraftAdGroup[]; campaignNegatives: { campaign: string; keywords: Kw[] }[]; notes: string[] };

// ─── Google's limits ──────────────────────────────────────────────────────────────────────────────────────────────

export const G = {
  headline: 30,
  description: 90,
  path: 15,
  keyword: 80,
  keywordWords: 10,
  headlinesMax: 15,
  headlinesMin: 3,
  descriptionsMax: 4,
  descriptionsMin: 2,
  sitelink: 25,
  sitelinkLine: 35,
  callout: 25,
  snippetValue: 25,
  longHeadline: 90,
  pmaxHeadlinesMax: 15,
  pmaxLongMax: 5,
  pmaxDescriptionsMax: 5,
  searchThemesMax: 25,
} as const;

// ─── Keywords ─────────────────────────────────────────────────────────────────────────────────────────────────────

const QUOTES = /^["“”'‘’](.+)["“”'‘’]$/;
const MATCH_WORD: [RegExp, Match][] = [
  [/^\s*(exact|e|\[\s*\])\s*$/i, "EXACT"],
  [/^\s*(phrase|p|"\s*"|“\s*”)\s*$/i, "PHRASE"],
  [/^\s*(broad|b|bmm|broad match modifier|modified broad)\s*$/i, "BROAD"],
];

/** A match type column's value ("Exact", "P", "[ ]") as Google's, or null when it isn't one */
export function matchOf(v: string | null | undefined): Match | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  for (const [re, m] of MATCH_WORD) if (re.test(t)) return m;
  if (/exact/i.test(t)) return "EXACT";
  if (/phrase/i.test(t)) return "PHRASE";
  if (/broad/i.test(t)) return "BROAD";
  return null;
}

/**
 * One keyword as a buyer writes it: [kw] is exact, "kw" phrase, +kw +words (the old broad match modifier) broad, a
 * plain kw takes the match type column's (or `fallback`, marked "default" so the buyer is asked). A leading "-" is a
 * negative. Spaces are tidied; the text Google gets has no notation left in it.
 */
export function parseKeyword(raw: string, column?: Match | null, fallback: Match = "PHRASE"): (Kw & { negative: boolean }) | null {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  let negative = false;
  if (/^-\s*\S/.test(t)) {
    negative = true;
    t = t.replace(/^-\s*/, "");
  }
  let match: Match | null = null;
  let from: Kw["from"] = "notation";
  const br = t.match(/^\[(.+)\]$/);
  const q = t.match(QUOTES);
  if (br) {
    match = "EXACT";
    t = br[1];
  } else if (q) {
    match = "PHRASE";
    t = q[1];
  } else if (/(^|\s)\+\S/.test(t)) {
    match = "BROAD";
    t = t.replace(/(^|\s)\+/g, "$1");
  }
  if (!match) {
    match = column ?? fallback;
    from = column ? "column" : "default";
  }
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return null;
  return { text: t, match, from, negative };
}

/** A cell that may hold several keywords (one per line, or separated by ; or ,), each parsed */
export function splitKeywords(cell: string, column?: Match | null, fallback: Match = "PHRASE") {
  const parts = String(cell ?? "")
    .split(/\r?\n|;|,(?![^[\]]*\])|\t/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.map((p) => parseKeyword(p, column, fallback)).filter((k): k is NonNullable<ReturnType<typeof parseKeyword>> => Boolean(k));
}

/** How a keyword reads with its notation, as buyers write it */
export const kwText = (k: Pick<Kw, "text" | "match">) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text);
export const kwKey = (k: Pick<Kw, "text" | "match">) => `${k.match}|${k.text.toLowerCase()}`;

/** Duplicates (same text and match) dropped, the first kept */
export function uniqKeywords<T extends Kw>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((k) => {
    const key = kwKey(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Copy ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A headline or description with its pin written in it: "Text (pin 1)", "[P2] Text", "Text - pinned 1" */
export function parsePinned(raw: string, max: 2 | 3 = 3): AdLine {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim();
  let pin = 0;
  const tail = t.match(/\s*[([{-]?\s*(?:pin(?:ned)?(?:\s*(?:to|position|pos))?)\s*(?:h|d)?#?\s*([1-3])\s*[)\]}]?\s*$/i);
  const head = t.match(/^\s*[[(]?\s*(?:p|pin)\s*([1-3])\s*[\])]?\s*[:-]?\s+/i);
  if (tail) {
    pin = Number(tail[1]);
    t = t.slice(0, tail.index).trim();
  } else if (head) {
    pin = Number(head[1]);
    t = t.slice(head[0].length).trim();
  }
  return { text: t, pin: (pin > max ? 0 : pin) as Pin };
}

/** Text as Google counts it (what the buyer sees), for the char counts on the card */
export const chars = (s: string) => [...String(s ?? "")].length;

const RISKY: { re: RegExp; level: "error" | "warn"; why: string; fix?: (s: string) => string }[] = [
  { re: /!/, level: "error", why: "Google doesn't allow an exclamation mark in a headline.", fix: (s) => s.replace(/!+/g, "").trim() },
  { re: /([!?.,])\1/, level: "error", why: "Repeated punctuation is refused (Google's punctuation policy).", fix: (s) => s.replace(/([!?.,])\1+/g, "$1") },
  { re: /\b[A-Z]{4,}\b/, level: "warn", why: "A word in all caps can be refused as excessive capitalization (brand names and acronyms are fine).", fix: (s) => s.replace(/\b([A-Z])([A-Z]{3,})\b/g, (_, a: string, b: string) => a + b.toLowerCase()) },
  { re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, level: "error", why: "Emojis and symbols aren't allowed in Google ad text.", fix: (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").replace(/\s+/g, " ").trim() },
  { re: /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, level: "error", why: "A phone number in ad text is refused: use a call asset." },
  { re: /\bclick here\b/i, level: "warn", why: "\"Click here\" is a generic call to action Google can refuse." },
  { re: /#\s?1\b|\bnumber one\b|\bbest\b|\bcheapest\b|\blowest price\b/i, level: "warn", why: "A superlative needs proof on the landing page (Google's unverified claims policy)." },
  { re: /\bguarantee(d|s)?\b/i, level: "warn", why: "A guarantee needs its terms on the landing page; health and finance claims get extra review." },
  { re: /[*©®™]/, level: "warn", why: "Symbols like * and trademark marks are often refused in ad text." },
];

/** What Google is likely to refuse or question in one piece of ad text */
export function copyRisks(text: string, kind: "headline" | "description" | "other") {
  return RISKY.filter((r, i) => (i === 0 ? kind === "headline" : true) && r.re.test(text)).map((r) => ({ level: r.level, why: r.why }));
}

/** The text with what can be fixed without rewriting it fixed (punctuation, emojis, caps), and over-long left as is */
export function tidyCopy(text: string, kind: "headline" | "description" | "other") {
  let t = text.replace(/\s+/g, " ").trim();
  // Only what Google refuses outright: a warning (caps, a superlative) can be right for the client, so it's the buyer's call
  for (const [i, r] of RISKY.entries()) if (r.fix && r.level === "error" && (i !== 0 || kind === "headline") && r.re.test(t)) t = r.fix(t);
  return t;
}

// ─── Checking the plan ────────────────────────────────────────────────────────────────────────────────────────────

export type Issue = { key: string; level: "error" | "warn"; message: string; fix?: string };

const isUrl = (u: string) => /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(u.trim());
const BAD_KW = /[!@%^*=;~`<>?\\|{}]/;

/**
 * Every line of the plan against Google's limits and rules, before Google is asked: lengths and counts, duplicates
 * (within an RSA, within an ad group, across ad groups, against the account), keywords a negative blocks, a missing or
 * broken final URL, risky wording. `inAccount`: keywords already running (kwKey), so a duplicate is caught.
 */
export function checkGooglePlan(plan: GooglePlan, inAccount: Set<string> = new Set()): Issue[] {
  const out: Issue[] = [];
  const seenKw = new Map<string, string>();
  for (const c of plan.campaigns) {
    if (c.mode === "new") {
      if (!c.name.trim()) out.push({ key: `campaign:${c.key}`, level: "error", message: "The new campaign has no name." });
      if (c.type === "SEARCH" && !(c.budget && c.budget > 0)) out.push({ key: `budget:${c.key}`, level: "error", message: "A new campaign needs a daily budget.", fix: "Say the daily budget in the chat, or edit it here." });
      if (c.type === "SEARCH" && !c.locations.length) out.push({ key: `targeting:${c.key}`, level: "warn", message: "No locations: it would show everywhere Google serves.", fix: "Say where to show it (cities, a radius, states)." });
      if (c.bidding === "MAXIMIZE_CONVERSIONS" && c.targetCpa != null && c.targetCpa <= 0) out.push({ key: `campaign:${c.key}`, level: "error", message: "The target CPA must be above $0." });
      if (c.type === "PERFORMANCE_MAX") out.push({ key: `campaign:${c.key}`, level: "warn", message: "A new Performance Max campaign is built by hand for now (it needs images, logos and video Kaizen Ads can't upload yet): it stays on the checklist." });
    }
    c.negatives.forEach((k, i) => {
      if (chars(k.text) > G.keyword) out.push({ key: `cneg:${c.key}:${i}`, level: "error", message: `Negative "${k.text}" is ${chars(k.text)} characters (Google's limit is ${G.keyword}).` });
    });
    c.sitelinks.forEach((s, i) => {
      const k = `sitelink:${c.key}:${i}`;
      if (chars(s.text) > G.sitelink) out.push({ key: k, level: "error", message: `Sitelink "${s.text}" is ${chars(s.text)} of ${G.sitelink} characters.` });
      if (chars(s.line1) > G.sitelinkLine || chars(s.line2) > G.sitelinkLine) out.push({ key: k, level: "error", message: `A sitelink description is over ${G.sitelinkLine} characters.` });
      if (!isUrl(s.url)) out.push({ key: k, level: "error", message: `Sitelink "${s.text}" has no working link.` });
    });
    c.callouts.forEach((t, i) => chars(t) > G.callout && out.push({ key: `callout:${c.key}:${i}`, level: "error", message: `Callout "${t}" is ${chars(t)} of ${G.callout} characters.` }));
    c.snippets.forEach((s, i) => {
      if (s.values.length < 3) out.push({ key: `snippet:${c.key}:${i}`, level: "error", message: `Structured snippet "${s.header}" needs at least 3 values.` });
      if (s.values.some((v) => chars(v) > G.snippetValue)) out.push({ key: `snippet:${c.key}:${i}`, level: "error", message: `A "${s.header}" value is over ${G.snippetValue} characters.` });
    });
  }
  for (const g of plan.adGroups) {
    const camp = plan.campaigns.find((c) => c.key === g.campaignKey);
    if (!camp) out.push({ key: `adgroup:${g.key}`, level: "error", message: `Ad group "${g.name}" belongs to no campaign in the plan.` });
    if (camp?.type === "PERFORMANCE_MAX") out.push({ key: `adgroup:${g.key}`, level: "error", message: `Performance Max has asset groups, not ad groups: "${g.name}" can't go into it.` });
    if (g.mode === "new" && !g.rsas.length) out.push({ key: `adgroup:${g.key}`, level: "warn", message: `New ad group "${g.name}" has no ad: it won't show until one is added.` });
    if (g.mode === "new" && !g.keywords.length) out.push({ key: `adgroup:${g.key}`, level: "warn", message: `New ad group "${g.name}" has no keywords.` });
    const negs = new Set([...(camp?.negatives ?? []), ...g.negatives].map((k) => k.text.toLowerCase()));
    const local = new Set<string>();
    g.keywords.forEach((k, i) => {
      const key = `kw:${g.key}:${i}`;
      if (chars(k.text) > G.keyword) out.push({ key, level: "error", message: `"${k.text}" is ${chars(k.text)} characters (the limit is ${G.keyword}).` });
      if (k.text.split(/\s+/).length > G.keywordWords) out.push({ key, level: "error", message: `"${k.text}" has more than ${G.keywordWords} words.` });
      if (BAD_KW.test(k.text)) out.push({ key, level: "error", message: `"${k.text}" has characters Google doesn't allow in keywords.`, fix: "Remove symbols like ! @ % * ? from it." });
      const kk = kwKey(k);
      if (local.has(kk)) out.push({ key, level: "warn", message: `${kwText(k)} is in "${g.name}" twice: it goes in once.` });
      else if (seenKw.has(kk)) out.push({ key, level: "warn", message: `${kwText(k)} is also in "${seenKw.get(kk)}": the two ad groups would compete for the same searches.` });
      else if (inAccount.has(kk)) out.push({ key, level: "warn", message: `${kwText(k)} already runs in the account.` });
      if (negs.has(k.text.toLowerCase())) out.push({ key, level: "warn", message: `${kwText(k)} is also a negative here, so it would never show.` });
      local.add(kk);
      seenKw.set(kk, g.name);
    });
    g.negatives.forEach((k, i) => chars(k.text) > G.keyword && out.push({ key: `aneg:${g.key}:${i}`, level: "error", message: `Negative "${k.text}" is over ${G.keyword} characters.` }));
    for (const r of g.rsas) {
      const key = `rsa:${g.key}:${r.key}`;
      if (!isUrl(r.finalUrl)) out.push({ key, level: "error", message: r.finalUrl ? `The final URL "${r.finalUrl}" isn't a full link.` : "This ad has no final URL.", fix: "Give the landing page (https://…)." });
      if (r.headlines.length < G.headlinesMin) out.push({ key, level: "error", message: `${r.headlines.length} headline${r.headlines.length === 1 ? "" : "s"}: Google needs at least ${G.headlinesMin}.` });
      if (r.headlines.length > G.headlinesMax) out.push({ key, level: "error", message: `${r.headlines.length} headlines: Google takes up to ${G.headlinesMax}.`, fix: "Remove the weakest." });
      if (r.descriptions.length < G.descriptionsMin) out.push({ key, level: "error", message: `${r.descriptions.length} description${r.descriptions.length === 1 ? "" : "s"}: Google needs at least ${G.descriptionsMin}.` });
      if (r.descriptions.length > G.descriptionsMax) out.push({ key, level: "error", message: `${r.descriptions.length} descriptions: Google takes up to ${G.descriptionsMax}.`, fix: "Remove the weakest." });
      const seen = new Set<string>();
      r.headlines.forEach((h, i) => {
        if (chars(h.text) > G.headline) out.push({ key, level: "error", message: `Headline ${i + 1} "${h.text}" is ${chars(h.text)} of ${G.headline} characters.`, fix: "Shorten it." });
        const n = h.text.trim().toLowerCase();
        if (seen.has(n)) out.push({ key, level: "error", message: `Headline "${h.text}" is there twice (Google refuses duplicates).` });
        seen.add(n);
        for (const x of copyRisks(h.text, "headline")) out.push({ key, level: x.level, message: `Headline ${i + 1} "${h.text}": ${x.why}` });
      });
      r.descriptions.forEach((d, i) => {
        if (chars(d.text) > G.description) out.push({ key, level: "error", message: `Description ${i + 1} is ${chars(d.text)} of ${G.description} characters.`, fix: "Shorten it." });
        for (const x of copyRisks(d.text, "description")) out.push({ key, level: x.level, message: `Description ${i + 1}: ${x.why}` });
      });
      if (new Set(r.descriptions.map((d) => d.text.trim().toLowerCase())).size < r.descriptions.length) out.push({ key, level: "error", message: "Two descriptions are the same (Google refuses duplicates)." });
      if (chars(r.path1) > G.path || chars(r.path2) > G.path) out.push({ key, level: "error", message: `A display path is over ${G.path} characters.` });
      if (r.path2 && !r.path1) out.push({ key, level: "error", message: "Path 2 needs a path 1." });
      const pinned1 = r.headlines.filter((h) => h.pin === 1).length;
      if (pinned1 && r.headlines.length - r.headlines.filter((h) => h.pin).length < 2) out.push({ key, level: "warn", message: "Almost every headline is pinned: Google rates ad strength Poor when it can't mix them." });
    }
  }
  for (const a of plan.assetGroups) {
    const key = `assetgroup:${a.key}`;
    if (a.mode === "new") out.push({ key, level: "warn", message: `New asset group "${a.name}" is built by hand for now (images, logos and video can't be uploaded from here yet).` });
    if (a.headlines.some((h) => chars(h) > G.headline)) out.push({ key, level: "error", message: `A headline in "${a.name}" is over ${G.headline} characters.` });
    if (a.longHeadlines.some((h) => chars(h) > G.longHeadline)) out.push({ key, level: "error", message: `A long headline in "${a.name}" is over ${G.longHeadline} characters.` });
    if (a.descriptions.some((h) => chars(h) > G.description)) out.push({ key, level: "error", message: `A description in "${a.name}" is over ${G.description} characters.` });
    if (a.headlines.length > G.pmaxHeadlinesMax || a.longHeadlines.length > G.pmaxLongMax || a.descriptions.length > G.pmaxDescriptionsMax) out.push({ key, level: "error", message: `"${a.name}" has more text than an asset group takes (15 headlines, 5 long headlines, 5 descriptions).` });
    if (a.searchThemes.length > G.searchThemesMax) out.push({ key, level: "error", message: `"${a.name}" has more than ${G.searchThemesMax} search themes.` });
  }
  return out;
}

// ─── The lines of the plan ────────────────────────────────────────────────────────────────────────────────────────

const pinTag = (p: Pin, kind: "h" | "d") => (p ? ` (pinned ${kind === "h" ? "H" : "D"}${p})` : "");

/** Every object the launch creates or changes, one line each, in the order they're created */
export function googleItems(plan: GooglePlan): LaunchItem[] {
  const items: LaunchItem[] = [];
  const add = (key: string, kind: LaunchItem["kind"], label: string, parentKey: string | null, existing = false, metaId: string | null = null) =>
    items.push({ key, kind, position: items.length, parentKey, label, status: existing ? "existing" : "planned", metaId, error: null, help: null, checked: null });
  for (const c of plan.campaigns) {
    if (c.mode === "new") {
      if (c.type === "SEARCH") add(`budget:${c.key}`, "budget", `$${c.budget ?? 0}/day budget`, null);
      add(`campaign:${c.key}`, "campaign", c.name, c.type === "SEARCH" ? `budget:${c.key}` : null);
      if (c.type === "SEARCH") add(`targeting:${c.key}`, "targeting", `${c.locations.map((l) => l.name).join(", ") || "Everywhere"} · English`, `campaign:${c.key}`);
    } else add(`campaign:${c.key}`, "campaign", c.name, null, true, c.existingId);
    c.negatives.forEach((k, i) => add(`cneg:${c.key}:${i}`, "negative", kwText(k), `campaign:${c.key}`));
    c.sitelinks.forEach((s, i) => add(`sitelink:${c.key}:${i}`, "extension", `Sitelink: ${s.text}`, `campaign:${c.key}`));
    c.callouts.forEach((t, i) => add(`callout:${c.key}:${i}`, "extension", `Callout: ${t}`, `campaign:${c.key}`));
    c.snippets.forEach((s, i) => add(`snippet:${c.key}:${i}`, "extension", `${s.header}: ${s.values.join(", ")}`, `campaign:${c.key}`));
  }
  for (const g of plan.adGroups) {
    add(`adgroup:${g.key}`, "ad_group", g.name, `campaign:${g.campaignKey}`, g.mode === "existing", g.existingId);
    g.keywords.forEach((k, i) => add(`kw:${g.key}:${i}`, "keyword", kwText(k), `adgroup:${g.key}`));
    g.negatives.forEach((k, i) => add(`aneg:${g.key}:${i}`, "negative", kwText(k), `adgroup:${g.key}`));
    for (const r of g.rsas) add(`rsa:${g.key}:${r.key}`, "rsa", `Responsive search ad: ${r.headlines[0]?.text ?? "no headline"}${pinTag(r.headlines[0]?.pin ?? 0, "h")}`, `adgroup:${g.key}`);
  }
  for (const a of plan.assetGroups) {
    add(`assetgroup:${a.key}`, "pmax_asset", `${a.name}: ${a.headlines.length} headlines, ${a.longHeadlines.length} long, ${a.descriptions.length} descriptions${a.searchThemes.length ? `, ${a.searchThemes.length} search themes` : ""}`, `campaign:${a.campaignKey}`, false, a.existingId);
  }
  return items;
}

/** "I read 3 ad groups, 42 keywords (18 phrase, 24 exact), 2 RSAs with 15 headlines each" */
export function draftSummary(d: GoogleDraft) {
  const kws = d.adGroups.flatMap((g) => g.keywords);
  const by = (m: Match) => kws.filter((k) => k.match === m).length;
  const parts = [`${by("PHRASE")} phrase`, `${by("EXACT")} exact`, `${by("BROAD")} broad`].filter((p) => !p.startsWith("0 "));
  const rsas = d.adGroups.flatMap((g) => g.rsas);
  const heads = [...new Set(rsas.map((r) => r.headlines.length))];
  const negs = d.adGroups.reduce((n, g) => n + g.negatives.length, 0) + d.campaignNegatives.reduce((n, c) => n + c.keywords.length, 0);
  const campaigns = [...new Set(d.adGroups.map((g) => g.campaign).filter(Boolean))];
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  return [
    `I read ${campaigns.length ? `${n(campaigns.length, "campaign")}, ` : ""}${n(d.adGroups.length, "ad group")}, ${n(kws.length, "keyword")}${parts.length ? ` (${parts.join(", ")})` : ""}`,
    `${n(rsas.length, "RSA")}${rsas.length ? ` with ${heads.length === 1 ? `${heads[0]} headline${heads[0] === 1 ? "" : "s"} each` : `${Math.min(...heads)} to ${Math.max(...heads)} headlines`}` : ""}`,
    negs ? n(negs, "negative") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Keywords whose match type wasn't written anywhere (asked about before planning) */
export const unsureMatches = (d: GoogleDraft) => d.adGroups.flatMap((g) => g.keywords.filter((k) => k.from === "default").map((k) => k.text));

// ─── What the buyer is asked ──────────────────────────────────────────────────────────────────────────────────────

export type AccountCampaign = { id: string; name: string; status: string; type: string; bidding: string; budget: number | null; spend30: number; conversions30: number };
export type AccountAdGroup = { id: string; name: string; status: string; campaignId: string; campaign: string; rsas: number; strength: string | null };

const q = (key: string, question: string, why: string, proposal: string, options: string[] = [], required = true): LaunchQuestion => ({ key, question, why, proposal, options, required, answer: null });
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** The live campaigns most likely to fit what's being launched: same words in the name, then Search and spend */
export function relevantCampaigns(campaigns: AccountCampaign[], about: string, type: CampaignType | null = null, n = 4) {
  const want = new Set(words(about));
  const score = (c: AccountCampaign) => words(c.name).filter((w) => want.has(w)).length * 100 + (c.status === "ENABLED" ? 1000 : 0) + (type && c.type === type ? 30 : 0) + Math.min(40, c.spend30 / 50);
  // Only live campaigns: nothing added to a paused one runs
  return [...campaigns].filter((c) => c.status === "ENABLED" && ["SEARCH", "PERFORMANCE_MAX"].includes(c.type)).sort((a, b) => score(b) - score(a)).slice(0, n);
}

export const campaignOption = (c: AccountCampaign) => `${c.name} (${c.type === "PERFORMANCE_MAX" ? "PMax" : "Search"}, ${c.status === "ENABLED" ? "on" : "paused"}, $${Math.round(c.spend30)} in 30 days)`;

/**
 * The decisions a Google launch needs, given what's known so far: which campaign (the live ones that fit, or a new
 * one, with its type, budget, bidding and places), which ad group, the landing page, keywords and their match types,
 * the ads. Only what's missing is asked; the model rewrites them for the client but can never drop one.
 */
export function googleQuestions(d: GoogleDraft, campaigns: AccountCampaign[], adGroups: AccountAdGroup[], about: string, scopeType: CampaignType | null = null): LaunchQuestion[] {
  const out: LaunchQuestion[] = [];
  const named = [...new Set(d.adGroups.map((g) => g.campaign.trim()).filter(Boolean))];
  const known = (n: string) => campaigns.find((c) => c.name.toLowerCase() === n.toLowerCase());
  const fits = relevantCampaigns(campaigns, `${about} ${named.join(" ")} ${d.adGroups.map((g) => g.name).join(" ")}`, scopeType);
  if (!named.length || named.some((n) => !known(n))) {
    const opts = [...fits.map(campaignOption), "A new Search campaign", "A new Performance Max campaign"];
    out.push(
      q(
        "campaign",
        named.length ? `The sheet names ${named.map((n) => `"${n}"`).join(", ")}, which ${named.length === 1 ? "isn't a campaign" : "aren't campaigns"} in the account. Add to one that's running, or build it new?` : "Which campaign should this go into?",
        fits.length ? "These are the live campaigns that fit best, by name, type and spend." : "Nothing in the account fits yet.",
        fits[0] ? `Add to ${campaignOption(fits[0])}` : "A new Search campaign",
        opts,
      ),
    );
  }
  const groupNames = d.adGroups.map((g) => g.name).filter(Boolean);
  if (!groupNames.length) {
    const groups = adGroups.filter((g) => fits.some((c) => c.id === g.campaignId) && g.status !== "REMOVED").slice(0, 4);
    out.push(q("ad_group", "Into an ad group that's running, or a new one?", "Keywords and ads live in an ad group; a new theme deserves its own.", groups[0] ? `A new ad group named for the theme` : "A new ad group named for the theme", [...groups.map((g) => `${g.name} (in ${g.campaign}${g.rsas ? `, ${g.rsas} ad${g.rsas === 1 ? "" : "s"}` : ""})`), "A new ad group named for the theme"]));
  }
  if (!d.adGroups.some((g) => g.finalUrl || g.rsas.some((r) => r.finalUrl))) out.push(q("final_url", "Which landing page should the ads send people to (the full link)?", "Every ad needs a final URL; the page should match the keywords.", "The page that matches the theme best on the client's site"));
  if (!d.adGroups.some((g) => g.keywords.length)) out.push(q("keywords", "Which keywords, and in what match type? Write [exact] and \"phrase\" as you'd write them in Google Ads.", "Search ads only show for the keywords given.", "I'll propose them from the searches that already convert in the account, for you to cut"));
  const unsure = unsureMatches(d);
  if (unsure.length) out.push(q("match_types", `${unsure.length} keyword${unsure.length === 1 ? " has" : "s have"} no match type written (no [ ], no quotes, no match type column). Which match type should ${unsure.length === 1 ? "it" : "they"} use?`, "Google treats a plain keyword as broad match, which can spend on loosely related searches.", "Phrase", ["Phrase", "Exact", "Broad", "Exact and phrase, both"]));
  if (!d.adGroups.some((g) => g.rsas.length)) out.push(q("ads", "Which ads? Paste up to 15 headlines (30 characters) and 4 descriptions (90 characters), or should I write them?", "Each ad group needs at least one responsive search ad.", "I'll write one per ad group from the client's winning lines in the Copy library, for you to edit"));
  out.push(q("go_live", "Everything is created paused for you to turn on in Google Ads. OK?", "Kaizen creates launches paused so you can check them first.", "Paused", ["Paused"]));
  return out;
}

/** The buyer's pick for "campaign", read: an existing campaign (its id), a new one (its type), or unknown */
export function campaignChoice(answer: string | null | undefined, campaigns: AccountCampaign[]): { mode: "existing"; id: string } | { mode: "new"; type: CampaignType } | null {
  const a = String(answer ?? "").toLowerCase();
  if (!a) return null;
  const hit = [...campaigns].sort((x, y) => y.name.length - x.name.length).find((c) => a.includes(c.name.toLowerCase()));
  if (hit) return { mode: "existing", id: hit.id };
  if (/performance max|pmax/.test(a) && /new/.test(a)) return { mode: "new", type: "PERFORMANCE_MAX" };
  if (/new/.test(a)) return { mode: "new", type: "SEARCH" };
  return null;
}

/** Every live campaign an answer names (an answer naming two, "if brand, X; if non-brand, Y", picks neither) */
export function campaignsNamed(answer: string | null | undefined, campaigns: AccountCampaign[]) {
  const a = String(answer ?? "").toLowerCase();
  if (!a) return [];
  // Longest names first, each match taken out so a name inside a longer one isn't counted twice
  let rest = a;
  const out: AccountCampaign[] = [];
  for (const c of [...campaigns].sort((x, y) => y.name.length - x.name.length)) {
    const n = c.name.toLowerCase();
    if (n && rest.includes(n)) {
      out.push(c);
      rest = rest.split(n).join(" ");
    }
  }
  return out;
}

export const NEW_AD_GROUP = "A new ad group named for the theme";

/**
 * The ad group question follows the campaign answer: only the ad groups inside the chosen campaign (never ones from
 * other campaigns), only a new one for a new campaign, and nothing to pick until one campaign is chosen. A campaign
 * answer that names more than one campaign is cleared and asked again; proposals are always one of the options.
 */
export function followCampaign(questions: LaunchQuestion[], campaigns: AccountCampaign[], adGroups: AccountAdGroup[]): LaunchQuestion[] {
  const camp = questions.find((x) => x.key === "campaign");
  let out = questions.map((x) => ({ ...x }));
  if (camp) {
    const named = campaignsNamed(camp.answer, campaigns);
    out = out.map((x) => {
      if (x.key !== "campaign") return x;
      const proposal = x.options.length && !x.options.includes(x.proposal) ? x.options[0] : x.proposal;
      if (named.length > 1) return { ...x, proposal, answer: null, why: `Pick one campaign: that answer named ${named.length} (${named.map((c) => c.name).join(", ")}).` };
      // Nothing added to a paused campaign runs: it isn't taken as the answer
      if (named.length === 1 && named[0].status !== "ENABLED") return { ...x, proposal, answer: null, why: `${named[0].name} is paused, so nothing added there would run. Pick a live campaign or a new one.` };
      return { ...x, proposal };
    });
  }
  const answer = out.find((x) => x.key === "campaign")?.answer ?? null;
  const choice = camp ? campaignChoice(answer, campaigns) : null;
  return out.map((x) => {
    if (x.key !== "ad_group") return x;
    if (!camp) return x;
    if (!choice) return { ...x, options: [], proposal: "Pick the campaign first", answer: null, why: "The ad groups to choose from depend on the campaign." };
    if (choice.mode === "new") return { ...x, options: [NEW_AD_GROUP], proposal: NEW_AD_GROUP, answer: x.answer && !/new/i.test(x.answer) ? null : x.answer };
    // Only live ad groups: nothing added to a paused one runs
    const inside = adGroups.filter((g) => g.campaignId === choice.id && g.status === "ENABLED");
    const options = [...inside.slice(0, 8).map((g) => `${g.name}${g.status === "PAUSED" ? " (paused)" : ""}${g.rsas ? `, ${g.rsas} ad${g.rsas === 1 ? "" : "s"}` : ""}`), NEW_AD_GROUP];
    // An answer naming an ad group from another campaign no longer stands
    const ans = x.answer;
    const stands = !ans || /new/i.test(ans) || inside.some((g) => ans.toLowerCase().includes(g.name.toLowerCase()));
    return { ...x, options, proposal: options.includes(x.proposal) ? x.proposal : NEW_AD_GROUP, answer: stands ? ans : null };
  });
}

// ─── Edits on the card ────────────────────────────────────────────────────────────────────────────────────────────

export type PlanEdit =
  | { type: "remove"; key: string }
  | { type: "line"; key: string; field: "headline" | "description"; index: number; text: string; pin?: Pin }
  | { type: "rsa"; key: string; field: "path1" | "path2" | "finalUrl"; text: string }
  | { type: "keyword"; key: string; text: string; match: Match }
  | { type: "budget"; campaignKey: string; amount: number }
  | { type: "name"; key: string; text: string };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * One edit from the card, applied to the plan: a line removed (with what hangs off it), copy fixed inline, a keyword or
 * its match type changed, a budget or a name. Unknown keys leave the plan as it was.
 */
export function editPlan(plan: GooglePlan, e: PlanEdit): GooglePlan {
  const p = clone(plan);
  const [kind, a, b] = ("key" in e ? e.key : "").split(":");
  if (e.type === "budget") {
    const c = p.campaigns.find((x) => x.key === e.campaignKey);
    if (c && c.mode === "new" && Number.isFinite(e.amount) && e.amount > 0) c.budget = Math.round(e.amount * 100) / 100;
    return p;
  }
  if (e.type === "remove") {
    if (kind === "campaign" || kind === "budget") {
      const gone = new Set(p.adGroups.filter((g) => g.campaignKey === a).map((g) => g.key));
      p.campaigns = p.campaigns.filter((c) => c.key !== a);
      p.adGroups = p.adGroups.filter((g) => !gone.has(g.key) && g.campaignKey !== a);
      p.assetGroups = p.assetGroups.filter((x) => x.campaignKey !== a);
    } else if (kind === "targeting") {
      const c = p.campaigns.find((x) => x.key === a);
      if (c) c.locations = [];
    } else if (kind === "cneg" || kind === "sitelink" || kind === "callout" || kind === "snippet") {
      const c = p.campaigns.find((x) => x.key === a);
      const i = Number(b);
      if (c) {
        if (kind === "cneg") c.negatives.splice(i, 1);
        if (kind === "sitelink") c.sitelinks.splice(i, 1);
        if (kind === "callout") c.callouts.splice(i, 1);
        if (kind === "snippet") c.snippets.splice(i, 1);
      }
    } else if (kind === "adgroup") p.adGroups = p.adGroups.filter((g) => g.key !== a);
    else if (kind === "kw" || kind === "aneg") {
      const g = p.adGroups.find((x) => x.key === a);
      if (g) (kind === "kw" ? g.keywords : g.negatives).splice(Number(b), 1);
    } else if (kind === "rsa") {
      const g = p.adGroups.find((x) => x.key === a);
      if (g) g.rsas = g.rsas.filter((r) => r.key !== b);
    } else if (kind === "assetgroup") p.assetGroups = p.assetGroups.filter((x) => x.key !== a);
    return p;
  }
  if (e.type === "line" || e.type === "rsa") {
    const r = p.adGroups.find((x) => x.key === a)?.rsas.find((x) => x.key === b);
    if (!r) return p;
    if (e.type === "rsa") {
      r[e.field] = e.text.trim();
      return p;
    }
    const list = e.field === "headline" ? r.headlines : r.descriptions;
    const text = e.text.replace(/\s+/g, " ").trim();
    if (!text) list.splice(e.index, 1);
    else if (e.index >= list.length) list.push({ text, pin: (e.pin ?? 0) as Pin });
    else list[e.index] = { text, pin: (e.pin ?? list[e.index].pin) as Pin };
    return p;
  }
  if (e.type === "keyword") {
    const g = p.adGroups.find((x) => x.key === a);
    const k = parseKeyword(e.text, e.match);
    if (g && k && (kind === "kw" || kind === "aneg")) (kind === "kw" ? g.keywords : g.negatives)[Number(b)] = { text: k.text, match: k.from === "notation" ? k.match : e.match, from: "column" };
    return p;
  }
  if (e.type === "name") {
    const t = e.text.trim().slice(0, 255);
    if (!t) return p;
    if (kind === "campaign") p.campaigns.filter((c) => c.key === a && c.mode === "new").forEach((c) => (c.name = t));
    if (kind === "adgroup") p.adGroups.filter((g) => g.key === a && g.mode === "new").forEach((g) => (g.name = t));
  }
  return p;
}

/** The fixes that don't need rewriting, applied across the plan: punctuation, emojis, caps, duplicates, whitespace */
export function tidyPlan(plan: GooglePlan): GooglePlan {
  const p = clone(plan);
  for (const g of p.adGroups) {
    g.keywords = uniqKeywords(g.keywords);
    g.negatives = uniqKeywords(g.negatives);
    for (const r of g.rsas) {
      const dedupe = (list: AdLine[], kind: "headline" | "description") => {
        const seen = new Set<string>();
        return list
          .map((l) => ({ ...l, text: tidyCopy(l.text, kind) }))
          .filter((l) => {
            const n = l.text.toLowerCase();
            if (!n || seen.has(n)) return false;
            seen.add(n);
            return true;
          });
      };
      r.headlines = dedupe(r.headlines, "headline").slice(0, G.headlinesMax);
      r.descriptions = dedupe(r.descriptions, "description").slice(0, G.descriptionsMax);
      r.path1 = r.path1.replace(/\s+/g, "-").replace(/^\/+|\/+$/g, "");
      r.path2 = r.path2.replace(/\s+/g, "-").replace(/^\/+|\/+$/g, "");
    }
  }
  for (const c of p.campaigns) c.negatives = uniqKeywords(c.negatives);
  return p;
}

// ─── Google's operations ──────────────────────────────────────────────────────────────────────────────────────────

const HEAD_PIN = ["", "HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const;
const DESC_PIN = ["", "DESCRIPTION_1", "DESCRIPTION_2"] as const;
export const ENGLISH = "languageConstants/1000";

export type Ops = { ops: Record<string, unknown>[]; keys: string[]; byHand: { key: string; why: string }[] };

/**
 * The whole plan as GoogleAdsService.Mutate operations, in dependency order, with temporary resource names (negative
 * ids) for what's new so one call creates it all. keys[i] is the plan line operation i belongs to (a line can need
 * several: a sitelink is an asset and its link to the campaign). Every campaign, ad group, keyword, ad and asset link
 * is created PAUSED. What Kaizen Ads can't create yet is listed in byHand, with why.
 */
export function googleOperations(plan: GooglePlan, customer: string): Ops {
  const cust = `customers/${String(customer).replace(/\D/g, "")}`;
  let temp = 0;
  const tempName = (service: string) => `${cust}/${service}/${--temp}`;
  const ops: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const byHand: Ops["byHand"] = [];
  const push = (key: string, op: Record<string, unknown>) => {
    ops.push(op);
    keys.push(key);
  };
  const campaignRes = new Map<string, string>();
  const groupRes = new Map<string, string>();
  for (const c of plan.campaigns) {
    if (c.mode === "existing" && c.existingId) {
      campaignRes.set(c.key, `${cust}/campaigns/${c.existingId}`);
      continue;
    }
    if (c.type === "PERFORMANCE_MAX") {
      byHand.push({ key: `campaign:${c.key}`, why: "A new Performance Max campaign needs images, logos and video: build it in Google Ads from this plan." });
      continue;
    }
    const budget = tempName("campaignBudgets");
    push(`budget:${c.key}`, { campaignBudgetOperation: { create: { resourceName: budget, name: `${c.name} budget`.slice(0, 255), amountMicros: String(Math.round((c.budget ?? 0) * 1_000_000)), deliveryMethod: "STANDARD", explicitlyShared: false } } });
    const res = tempName("campaigns");
    campaignRes.set(c.key, res);
    const bidding =
      c.bidding === "MAXIMIZE_CONVERSION_VALUE"
        ? { maximizeConversionValue: c.targetRoas ? { targetRoas: c.targetRoas } : {} }
        : c.bidding === "MAXIMIZE_CLICKS"
          ? { targetSpend: {} }
          : c.bidding === "MANUAL_CPC"
            ? { manualCpc: {} }
            : { maximizeConversions: c.targetCpa ? { targetCpaMicros: String(Math.round(c.targetCpa * 1_000_000)) } : {} };
    push(`campaign:${c.key}`, {
      campaignOperation: {
        create: {
          resourceName: res,
          name: c.name.slice(0, 255),
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budget,
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          ...bidding,
        },
      },
    });
    for (const l of c.locations) push(`targeting:${c.key}`, { campaignCriterionOperation: { create: { campaign: res, location: { geoTargetConstant: l.geo } } } });
    push(`targeting:${c.key}`, { campaignCriterionOperation: { create: { campaign: res, language: { languageConstant: ENGLISH } } } });
  }
  for (const c of plan.campaigns) {
    const res = campaignRes.get(c.key);
    if (!res) continue;
    c.negatives.forEach((k, i) => push(`cneg:${c.key}:${i}`, { campaignCriterionOperation: { create: { campaign: res, negative: true, keyword: { text: k.text, matchType: k.match } } } }));
    const link = (key: string, asset: Record<string, unknown>, fieldType: string) => {
      const a = tempName("assets");
      push(key, { assetOperation: { create: { resourceName: a, ...asset } } });
      push(key, { campaignAssetOperation: { create: { campaign: res, asset: a, fieldType, status: "PAUSED" } } });
    };
    c.sitelinks.forEach((s, i) => link(`sitelink:${c.key}:${i}`, { finalUrls: [s.url], sitelinkAsset: { linkText: s.text, ...(s.line1 ? { description1: s.line1 } : {}), ...(s.line2 ? { description2: s.line2 } : {}) } }, "SITELINK"));
    c.callouts.forEach((t, i) => link(`callout:${c.key}:${i}`, { calloutAsset: { calloutText: t } }, "CALLOUT"));
    c.snippets.forEach((s, i) => link(`snippet:${c.key}:${i}`, { structuredSnippetAsset: { header: s.header, values: s.values } }, "STRUCTURED_SNIPPET"));
  }
  for (const g of plan.adGroups) {
    const camp = plan.campaigns.find((c) => c.key === g.campaignKey);
    const cRes = campaignRes.get(g.campaignKey);
    if (!camp || camp.type === "PERFORMANCE_MAX" || (!cRes && !(g.mode === "existing" && g.existingId))) {
      byHand.push({ key: `adgroup:${g.key}`, why: "Its campaign isn't one Kaizen Ads can create yet." });
      continue;
    }
    let res: string;
    if (g.mode === "existing" && g.existingId) res = `${cust}/adGroups/${g.existingId}`;
    else {
      res = tempName("adGroups");
      push(`adgroup:${g.key}`, { adGroupOperation: { create: { resourceName: res, name: g.name.slice(0, 255), campaign: cRes, status: "PAUSED", type: "SEARCH_STANDARD" } } });
    }
    groupRes.set(g.key, res);
    g.keywords.forEach((k, i) => push(`kw:${g.key}:${i}`, { adGroupCriterionOperation: { create: { adGroup: res, status: "PAUSED", keyword: { text: k.text, matchType: k.match } } } }));
    g.negatives.forEach((k, i) => push(`aneg:${g.key}:${i}`, { adGroupCriterionOperation: { create: { adGroup: res, negative: true, keyword: { text: k.text, matchType: k.match } } } }));
    for (const r of g.rsas)
      push(`rsa:${g.key}:${r.key}`, {
        adGroupAdOperation: {
          create: {
            adGroup: res,
            status: "PAUSED",
            ad: {
              finalUrls: [r.finalUrl],
              responsiveSearchAd: {
                headlines: r.headlines.map((h) => ({ text: h.text, ...(h.pin ? { pinnedField: HEAD_PIN[h.pin] } : {}) })),
                descriptions: r.descriptions.map((d) => ({ text: d.text, ...(d.pin ? { pinnedField: DESC_PIN[Math.min(2, d.pin)] } : {}) })),
                ...(r.path1 ? { path1: r.path1 } : {}),
                ...(r.path2 && r.path1 ? { path2: r.path2 } : {}),
              },
            },
          },
        },
      });
  }
  for (const a of plan.assetGroups) {
    if (a.mode !== "existing" || !a.existingId) {
      byHand.push({ key: `assetgroup:${a.key}`, why: "A new asset group needs images, logos and video: build it in Google Ads from this plan." });
      continue;
    }
    const ag = `${cust}/assetGroups/${a.existingId}`;
    const text = (t: string, fieldType: string) => {
      const asset = tempName("assets");
      push(`assetgroup:${a.key}`, { assetOperation: { create: { resourceName: asset, textAsset: { text: t } } } });
      push(`assetgroup:${a.key}`, { assetGroupAssetOperation: { create: { assetGroup: ag, asset, fieldType, status: "PAUSED" } } });
    };
    a.headlines.forEach((t) => text(t, "HEADLINE"));
    a.longHeadlines.forEach((t) => text(t, "LONG_HEADLINE"));
    a.descriptions.forEach((t) => text(t, "DESCRIPTION"));
    if (a.searchThemes.length || a.byHand.length) byHand.push({ key: `assetgroup:${a.key}`, why: `Added by hand in Google Ads: ${[a.searchThemes.length ? `${a.searchThemes.length} search themes (they'd take effect right away on a live asset group)` : "", ...a.byHand].filter(Boolean).join("; ")}.` });
  }
  return { ops, keys, byHand };
}

/** One error Google returned, with the operation it's about (its index in the batch) */
export type GoogleError = { index: number | null; code: string; message: string; trigger: string | null; policy: string[] };

/** Google's failure (the raw JSON) as one error per problem, each pointing at its operation */
export function parseGoogleErrors(raw: string): GoogleError[] {
  try {
    const j = JSON.parse(raw) as unknown;
    const err = (Array.isArray(j) ? (j[0] as { error?: unknown })?.error : (j as { error?: unknown }).error) as { message?: string; details?: { errors?: unknown[] }[] } | undefined;
    const list = (err?.details ?? []).flatMap((d) => (d.errors ?? []) as Record<string, unknown>[]);
    if (!list.length) return err?.message ? [{ index: null, code: "", message: err.message, trigger: null, policy: [] }] : [];
    return list.map((e) => {
      const path = ((e.location as { fieldPathElements?: { fieldName?: string; index?: number }[] } | undefined)?.fieldPathElements ?? []) as { fieldName?: string; index?: number }[];
      const at = path.find((p) => /mutate_operations|operations/.test(p.fieldName ?? ""));
      const code = Object.entries((e.errorCode ?? {}) as Record<string, string>).map(([k, v]) => `${k}.${v}`)[0] ?? "";
      const det = (e.details ?? {}) as { policyViolationDetails?: { externalPolicyName?: string }; policyFindingDetails?: { policyTopicEntries?: { topic?: string }[] } };
      const policy = [det.policyViolationDetails?.externalPolicyName, ...(det.policyFindingDetails?.policyTopicEntries ?? []).map((t) => t.topic)].filter((x): x is string => Boolean(x));
      const trig = (e.trigger as { stringValue?: string } | undefined)?.stringValue ?? null;
      return { index: typeof at?.index === "number" ? at.index : at ? 0 : null, code, message: String(e.message ?? ""), trigger: trig, policy };
    });
  } catch {
    return [];
  }
}

/** A Google error in words a buyer can act on */
export function plainGoogleError(e: GoogleError): { plain: string; fix: string | null } {
  const c = e.code;
  const t = e.trigger ? ` ("${e.trigger}")` : "";
  if (e.policy.length || /POLICY/.test(c)) return { plain: `Google's policy check flagged it${t}: ${e.policy.map((p) => p.toLowerCase().replace(/_/g, " ")).join(", ") || "a policy"}.`, fix: "Reword it, or request an exception in Google Ads after it's created if the claim is allowed for this client." };
  if (/TOO_LONG/.test(c)) return { plain: `Too long for Google${t}.`, fix: "Shorten it on the card." };
  if (/DUPLICATE/.test(c)) return { plain: `It's a duplicate${t}: Google takes it once.`, fix: "Remove one copy." };
  if (/INVALID_CHARACTER|ILLEGAL_CHAR|INVALID_INPUT/.test(c)) return { plain: `Google won't take a character in it${t}.`, fix: "Remove symbols and emojis." };
  if (/NOT_ENOUGH|TOO_FEW|REQUIRED/.test(c)) return { plain: `Something required is missing: ${e.message}`, fix: null };
  if (/URL|DESTINATION/.test(c)) return { plain: `Google can't use the landing page: ${e.message}`, fix: "Check the final URL loads and is on the client's domain." };
  if (/BUDGET/.test(c)) return { plain: `Google won't take the budget: ${e.message}`, fix: null };
  if (/RESOURCE_NOT_FOUND|NOT_FOUND/.test(c)) return { plain: "The campaign or ad group it goes into isn't in the account any more.", fix: "Pick another one in the chat." };
  return { plain: `Google: ${e.message}${t}`, fix: null };
}

/** Each line's errors from one batch (the operations' keys), and errors Google gave without saying where */
export function errorsByLine(errors: GoogleError[], keys: string[]) {
  const by = new Map<string, GoogleError[]>();
  const loose: GoogleError[] = [];
  for (const e of errors) {
    const k = e.index != null ? keys[e.index] : undefined;
    if (!k) loose.push(e);
    else by.set(k, [...(by.get(k) ?? []), e]);
  }
  return { by, loose };
}

// ─── The gate ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the plan can be deployed now, and if not why: the client's Google switch (the write status read the same way
 * googleMutate reads it), who's asking, a checked plan, and nothing left that Google or the checks refused.
 */
export function deployBlocked(o: { live: boolean; liveReason: string | null; canConfirm: boolean; status: string; items: Pick<LaunchItem, "status">[]; errors: number }): string | null {
  if (!o.live) return o.liveReason ?? "Live changes in Google Ads are off for this client.";
  if (!o.canConfirm) return "Only the client's Google buyer, the head of Google, a lead or an exec can deploy a launch.";
  if (o.status !== "ready") return "There's no checked plan to deploy.";
  if (o.errors > 0) return `${o.errors} line${o.errors === 1 ? " needs" : "s need"} fixing first: see each line.`;
  if (o.items.some((i) => i.status === "invalid")) return "Google refused some lines in the dry run: fix or remove them first.";
  if (!o.items.some((i) => i.status !== "existing")) return "There's nothing new in the plan.";
  return null;
}
