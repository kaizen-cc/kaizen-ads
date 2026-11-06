import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { canApply, googleWritesOn } from "@/lib/ad-changes";
import { googleMutate, googleQuery } from "@/lib/context/google-ads";
import { isPublicHost, pageText } from "@/lib/references";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiTool } from "./types";

// The Google policy checker: one click reads every disapproved or limited ad, asset and keyword in a client's Google Ads
// account (and the account's own standing), finds the exact trigger Google names, reads Google's own policy article for
// it, opens the landing page (and every redirect on the way), and has the Google auditor say what's wrong, why (quoting
// the article), and the fix: a compliant rewrite within Google's character limits, or the change the page needs. Each
// issue gets three ways forward: apply the fix (a PAUSED replacement, only where live Google changes are on for the
// client; otherwise a checklist), a drafted appeal, and how to request a review.

export type PolicyKind = "ad" | "asset" | "keyword" | "account";
export type Severity = "high" | "medium" | "low";

export type PolicyTopic = { topic: string; type: string; evidence: string[]; destination: string | null };
export type PolicyArticle = { topic: string; url: string; title: string | null; quote: string | null };
export type LandingScan = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  redirects: string[];
  ms: number | null;
  https: boolean;
  privacy: boolean;
  contact: boolean;
  title: string | null;
  note: string | null;
};
export type PolicyFix = {
  kind: "rewrite" | "page" | "both" | "none";
  headlines: string[];
  descriptions: string[];
  keyword: string | null;
  assetText: string | null;
  page: string[];
};
export type PolicyReview = {
  wrong: string;
  why: string;
  quote: string;
  article: string | null;
  triggers: string[];
  fix: PolicyFix;
  appeal: string;
  requestReview: string;
};
export type PolicyIssue = {
  key: string;
  kind: PolicyKind;
  severity: Severity;
  status: string; // DISAPPROVED, APPROVED_LIMITED, ...
  review: string | null; // Google's review status
  label: string; // what it is, in words
  campaign: string | null;
  adGroup: string | null;
  resource: string | null;
  adGroupResource: string | null;
  text: { headlines: string[]; descriptions: string[]; path1: string | null; path2: string | null; keyword: string | null; match: string | null; asset: string | null; assetType: string | null };
  finalUrl: string | null;
  topics: PolicyTopic[];
  articles: PolicyArticle[];
  landing: LandingScan | null;
  ai: PolicyReview | null;
  applied: { at: string; by: string; result: string; resource: string | null } | null;
};

export const LIMITS = { headline: 30, description: 90, sitelink: 25, callout: 25, path: 15, keyword: 80 };

// ─── Google's policy articles ────────────────────────────────────────────────────────────────────────────────────────

const ARTICLE = (id: string) => `https://support.google.com/adspolicy/answer/${id}?hl=en`;
/** Topic names Google returns (e.g. DESTINATION_NOT_WORKING, TRADEMARKS_IN_AD_TEXT) to the article that governs them */
const TOPIC_ARTICLES: [RegExp, string][] = [
  [/DESTINATION|LANDING|UNREPLICABLE|CRAWL|MALWARE|UNVERIFIED_PHONE|PHONE_NUMBER|APP_STORE|URL/, "6368661"], // Destination requirements
  [/TRADEMARK/, "6118"],
  [/CAPITAL|PUNCTUATION|SYMBOL|SPACING|REPETI|GIMMICK|SPELLING|GRAMMAR|STYLE|EDITORIAL|UNCLEAR|NON_STANDARD|EMOJI|SUPERLATIVE|LANGUAGE/, "6021546"], // Editorial
  [/MISREPRESENT|UNACCEPTABLE_BUSINESS|DISHONEST_PRICING|UNRELIABLE_CLAIM|MISLEADING|CLICKBAIT|UNAVAILABLE_OFFER|SCAM|COORDINATED/, "6020955"],
  [/HEALTH|MEDICINE|PHARMA|PRESCRIPTION|UNAPPROVED_SUBSTANCE|SPECULATIVE_MEDICAL|ADDICTION|DRUG|CBD|HEMP|SUPPLEMENT/, "176031"],
  [/PERSONALIZED|SENSITIVE_CATEGOR/, "143465"],
  [/ALCOHOL/, "6012382"],
  [/GAMBLING|CASINO|BETTING|SWEEPSTAKES/, "6018017"],
  [/FINANCIAL|CRYPTO|LOAN|CREDIT|INVESTMENT|DEBT/, "2464998"],
  [/SEXUAL|ADULT|DATING/, "6023699"],
  [/DANGEROUS|WEAPON|EXPLOSIVE|TOBACCO|FIREWORK/, "6014299"],
  [/INAPPROPRIATE|SHOCKING|HATE|SELF_HARM|VIOLEN|PROFANIT/, "6015406"],
  [/POLITIC|ELECTION/, "6014595"],
  [/COPYRIGHT/, "6018015"],
  [/ABUS|CIRCUMVENT|CLOAK|BRIDGE_PAGE|ARBITRAGE/, "6020954"],
  [/DATA_COLLECTION|PERSONAL_INFORMATION/, "6020956"],
  [/DISHONEST_BEHAVIOR|HACKING|ACADEMIC/, "6016086"],
  [/COUNTERFEIT/, "176017"],
];
const POLICY_INDEX = "6008942"; // Google Ads policies, the index

export function articleFor(topic: string) {
  const t = topic.toUpperCase();
  return ARTICLE(TOPIC_ARTICLES.find(([re]) => re.test(t))?.[1] ?? POLICY_INDEX);
}

const WEEK = 7 * 86_400_000;

/** Google's article, read from support.google.com (kept a week): its title and its text, to quote */
export async function policyArticle(admin: SupabaseClient, url: string): Promise<{ title: string | null; body: string }> {
  const { data: kept } = await admin.from("policy_articles").select("title, body, fetched_at").eq("url", url).maybeSingle();
  if (kept && Date.now() - new Date(kept.fetched_at as string).getTime() < WEEK && (kept.body as string)) return { title: (kept.title as string) ?? null, body: kept.body as string };
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenAds/1.0; policy reader)", accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`article ${res.status}`);
    const p = pageText(await res.text());
    const title = (p.title || p.ogTitle || "").replace(/\s*-\s*(Google Ads|Advertising Policies) Help\s*$/i, "").trim() || null;
    // The article itself, not the help centre's menus around it
    const body = p.body.replace(/^[\s\S]*?(?=\n[^\n]{40,})/, "").slice(0, 9000);
    await admin.from("policy_articles").upsert({ url, title, body, fetched_at: new Date().toISOString() });
    return { title, body };
  } catch (e) {
    console.error("[policy] article", url, e instanceof Error ? e.message : e);
    return { title: (kept?.title as string) ?? null, body: (kept?.body as string) ?? "" };
  }
}

// ─── The landing page ────────────────────────────────────────────────────────────────────────────────────────────────

/** The final URL opened the way Google's crawler would: every redirect followed (and listed), what the page says */
export async function scanLanding(url: string): Promise<LandingScan & { text: string }> {
  const out: LandingScan & { text: string } = { url, finalUrl: null, status: null, redirects: [], ms: null, https: url.startsWith("https://"), privacy: false, contact: false, title: null, note: null, text: "" };
  let at = url;
  const started = Date.now();
  try {
    for (let hop = 0; hop < 8; hop++) {
      if (!isPublicHost(at)) {
        out.note = "Not a public website";
        return out;
      }
      const res = await fetch(at, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html) KaizenAds/1.0", accept: "text/html,*/*" }, signal: AbortSignal.timeout(15_000) });
      out.status = res.status;
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (next) {
        at = new URL(next, at).toString();
        out.redirects.push(at);
        continue;
      }
      out.finalUrl = at;
      out.ms = Date.now() - started;
      out.https = at.startsWith("https://");
      if (!res.ok) {
        out.note = `The page answered ${res.status}`;
        return out;
      }
      const html = await res.text();
      const p = pageText(html);
      out.title = p.title || p.ogTitle || null;
      out.privacy = /privacy|datenschutz|privacidad/i.test(html);
      out.contact = /href=["'](tel:|mailto:)|contact|get in touch|call us|\(\d{3}\)\s?\d{3}-\d{4}|\d{3}[-.]\d{3}[-.]\d{4}/i.test(html);
      out.text = `${p.title}\n${p.description}\n${p.body}`.slice(0, 7000);
      if (p.body.length < 120) out.note = "Almost no readable text (it may need JavaScript, which Google's crawler may not run)";
      return out;
    }
    out.note = "Too many redirects";
    return out;
  } catch (e) {
    out.ms = Date.now() - started;
    out.note = e instanceof Error && e.name === "TimeoutError" ? "The page didn't answer within 15 seconds" : `The page couldn't be opened (${e instanceof Error ? e.message : "error"})`;
    return out;
  }
}

// ─── Reading the account ─────────────────────────────────────────────────────────────────────────────────────────────

type J = Record<string, unknown>;
const obj = (v: unknown) => (v && typeof v === "object" ? (v as J) : {});
const arr = (v: unknown) => (Array.isArray(v) ? (v as J[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const human = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function topicsOf(entries: unknown): PolicyTopic[] {
  return arr(entries).map((e) => {
    const evidence: string[] = [];
    let destination: string | null = null;
    for (const ev of arr(e.evidences)) {
      evidence.push(...(arr(obj(ev.textList).texts) as unknown as string[]));
      evidence.push(...(arr(obj(ev.websiteList).websites) as unknown as string[]));
      evidence.push(...(arr(obj(ev.destinationTextList).destinationTexts) as unknown as string[]));
      const mm = obj(ev.destinationMismatch);
      if (arr(mm.urlTypes).length) evidence.push(`Mismatch between: ${(mm.urlTypes as string[]).map(human).join(", ")}`);
      const dn = obj(ev.destinationNotWorking);
      if (Object.keys(dn).length) {
        destination = str(dn.expandedUrl);
        evidence.push(["Destination not working", str(dn.device) && `on ${human(str(dn.device)!)}`, str(dn.httpErrorCode) && `HTTP ${dn.httpErrorCode}`, str(dn.dnsErrorType) && human(str(dn.dnsErrorType)!), str(dn.lastCheckedDateTime) && `checked ${dn.lastCheckedDateTime}`].filter(Boolean).join(" · "));
      }
      if (str(ev.languageCode)) evidence.push(`Language: ${ev.languageCode}`);
    }
    return { topic: str(e.topic) ?? "UNKNOWN", type: str(e.type) ?? "UNKNOWN", evidence: [...new Set(evidence.filter(Boolean).map(String))].slice(0, 12), destination };
  });
}

const severityOf = (status: string): Severity => (status === "DISAPPROVED" || status === "SUSPENDED" ? "high" : status === "APPROVED_LIMITED" ? "medium" : "low");
const texts = (v: unknown) => arr(v).map((a) => str(a.text) ?? "").filter(Boolean);

/** Every disapproved or limited item in the account, with Google's own reasons. Reads that fail are noted, not fatal. */
export async function readPolicyIssues(account: string): Promise<{ issues: PolicyIssue[]; notes: string[] }> {
  const notes: string[] = [];
  const read = (what: string, q: string) =>
    googleQuery(account, q).catch((e) => {
      notes.push(`Couldn't read ${what}: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
      return [] as Record<string, Record<string, unknown>>[];
    });
  const blank = { headlines: [], descriptions: [], path1: null, path2: null, keyword: null, match: null, asset: null, assetType: null };
  const [ads, assets, keywords, customer] = await Promise.all([
    read(
      "ads",
      "SELECT campaign.name, ad_group.name, ad_group.resource_name, ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad WHERE ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY') AND ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 200",
    ),
    read(
      "assets (sitelinks, callouts, images)",
      "SELECT asset.resource_name, asset.id, asset.name, asset.type, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, asset.text_asset.text, asset.image_asset.full_size.url, asset.policy_summary.approval_status, asset.policy_summary.review_status, asset.policy_summary.policy_topic_entries FROM asset WHERE asset.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY') LIMIT 200",
    ),
    read(
      "keywords",
      "SELECT campaign.name, ad_group.name, ad_group.resource_name, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.approval_status, ad_group_criterion.disapproval_reasons, ad_group_criterion.final_urls FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.approval_status = 'DISAPPROVED' AND ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 200",
    ),
    read("the account", "SELECT customer.id, customer.descriptive_name, customer.status, customer.final_url_suffix FROM customer LIMIT 1"),
  ]);

  const issues: PolicyIssue[] = [];
  for (const r of ads) {
    const aga = obj(r.adGroupAd);
    const ad = obj(aga.ad);
    const rsa = obj(ad.responsiveSearchAd);
    const ps = obj(aga.policySummary);
    const status = str(ps.approvalStatus) ?? "UNKNOWN";
    const headlines = texts(rsa.headlines);
    issues.push({
      key: `ad:${str(ad.id)}`,
      kind: "ad",
      severity: severityOf(status),
      status,
      review: str(ps.reviewStatus),
      label: headlines[0] ? `Ad · ${headlines.slice(0, 2).join(" | ")}` : `Ad ${str(ad.id)} (${human(str(ad.type) ?? "ad")})`,
      campaign: str(obj(r.campaign).name),
      adGroup: str(obj(r.adGroup).name),
      resource: str(aga.resourceName),
      adGroupResource: str(obj(r.adGroup).resourceName),
      text: { ...blank, headlines, descriptions: texts(rsa.descriptions), path1: str(rsa.path1), path2: str(rsa.path2) },
      finalUrl: (arr(ad.finalUrls) as unknown as string[])[0] ?? null,
      topics: topicsOf(ps.policyTopicEntries),
      articles: [],
      landing: null,
      ai: null,
      applied: null,
    });
  }
  for (const r of assets) {
    const a = obj(r.asset);
    const ps = obj(a.policySummary);
    const status = str(ps.approvalStatus) ?? "UNKNOWN";
    const type = str(a.type) ?? "ASSET";
    const sl = obj(a.sitelinkAsset);
    const text = str(sl.linkText) ?? str(obj(a.calloutAsset).calloutText) ?? str(obj(a.textAsset).text) ?? (obj(a.structuredSnippetAsset).header ? `${obj(a.structuredSnippetAsset).header}: ${(arr(obj(a.structuredSnippetAsset).values) as unknown as string[]).join(", ")}` : null);
    issues.push({
      key: `asset:${str(a.id)}`,
      kind: "asset",
      severity: severityOf(status),
      status,
      review: str(ps.reviewStatus),
      label: `${human(type)}${text ? ` · ${text}` : str(a.name) ? ` · ${a.name}` : ""}`,
      campaign: null,
      adGroup: null,
      resource: str(a.resourceName),
      adGroupResource: null,
      text: { ...blank, asset: [text, str(sl.description1), str(sl.description2)].filter(Boolean).join(" · ") || str(obj(obj(a.imageAsset).fullSize).url), assetType: type },
      finalUrl: (arr(a.finalUrls) as unknown as string[])[0] ?? null,
      topics: topicsOf(ps.policyTopicEntries),
      articles: [],
      landing: null,
      ai: null,
      applied: null,
    });
  }
  for (const r of keywords) {
    const c = obj(r.adGroupCriterion);
    const kw = obj(c.keyword);
    const reasons = (arr(c.disapprovalReasons) as unknown as string[]).map(String);
    issues.push({
      key: `keyword:${str(c.resourceName)}`,
      kind: "keyword",
      severity: "high",
      status: str(c.approvalStatus) ?? "DISAPPROVED",
      review: null,
      label: `Keyword · ${str(kw.text)} (${human(str(kw.matchType) ?? "")})`,
      campaign: str(obj(r.campaign).name),
      adGroup: str(obj(r.adGroup).name),
      resource: str(c.resourceName),
      adGroupResource: str(obj(r.adGroup).resourceName),
      text: { ...blank, keyword: str(kw.text), match: str(kw.matchType) },
      finalUrl: (arr(c.finalUrls) as unknown as string[])[0] ?? null,
      topics: (reasons.length ? reasons : ["KEYWORD_DISAPPROVED"]).map((t) => ({ topic: t, type: "PROHIBITED", evidence: [str(kw.text) ?? ""].filter(Boolean), destination: null })),
      articles: [],
      landing: null,
      ai: null,
      applied: null,
    });
  }
  const cu = obj(customer[0]?.customer);
  const cs = str(cu.status);
  if (cs && cs !== "ENABLED") {
    issues.push({
      key: "account",
      kind: "account",
      severity: cs === "SUSPENDED" ? "high" : "medium",
      status: cs,
      review: null,
      label: `The account is ${human(cs).toLowerCase()}`,
      campaign: null,
      adGroup: null,
      resource: `customers/${account.replace(/\D/g, "")}`,
      adGroupResource: null,
      text: blank,
      finalUrl: null,
      topics: [{ topic: cs === "SUSPENDED" ? "ACCOUNT_SUSPENDED" : `ACCOUNT_${cs}`, type: "PROHIBITED", evidence: [], destination: null }],
      articles: [],
      landing: null,
      ai: null,
      applied: null,
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return { issues: issues.sort((a, b) => rank[a.severity] - rank[b.severity]), notes };
}

// ─── The review: what's wrong, why, the fix ──────────────────────────────────────────────────────────────────────────

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    wrong: { type: "string" },
    why: { type: "string" },
    quote: { type: "string" },
    article: { type: ["string", "null"] },
    triggers: { type: "array", items: { type: "string" } },
    fix: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["rewrite", "page", "both", "none"] },
        headlines: { type: "array", items: { type: "string" } },
        descriptions: { type: "array", items: { type: "string" } },
        keyword: { type: ["string", "null"] },
        assetText: { type: ["string", "null"] },
        page: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "headlines", "descriptions", "keyword", "assetText", "page"],
      additionalProperties: false,
    },
    appeal: { type: "string" },
    requestReview: { type: "string" },
  },
  required: ["wrong", "why", "quote", "article", "triggers", "fix", "appeal", "requestReview"],
  additionalProperties: false,
};

const SYSTEM = `You are Kaizen's Google Ads policy specialist. An item in a client's Google Ads account was disapproved or limited. You get Google's own reasons (the policy topics and the evidence Google quotes), Google's official policy article for each topic, the item's text, and what our crawler found on its landing page (redirects, status, privacy policy and contact details, the page text).

Say, plainly and briefly:
- wrong: what exactly is wrong, naming the exact trigger (the word, phrase, claim, symbol or page problem).
- why: why it breaks the policy.
- quote: a short, exact quote from the policy article given that backs it (copy it word for word from the article; empty if no article text was given).
- article: the article URL you quoted.
- triggers: the exact words or phrases in the ad, keyword or asset that set it off (empty if it's the page).
- fix: kind "rewrite" when the text must change, "page" when the landing page must, "both", or "none" when nothing on our side is wrong (then the appeal carries it).
  For a rewrite of an ad, give the COMPLETE new set: every headline (3 to 15, each 30 characters or fewer) and every description (2 to 4, each 90 characters or fewer), keeping what was fine and changing only what broke the policy, in the client's voice. For a keyword, the compliant keyword. For a sitelink or callout, the new text (25 characters or fewer). Count characters carefully.
  page: each change the landing page needs, one line each (what and where), e.g. add a privacy policy link in the footer, fix the broken redirect, remove an unsupported claim.
- appeal: a ready-to-send appeal or support case to Google: what the item is, what was changed (or why it already complies), citing the policy; polite, factual, under 150 words. Never claim something was changed if it wasn't.
- requestReview: how to request a review for this item in Google Ads, step by step in one or two sentences (e.g. hover the status in Ads & assets and choose Appeal; for a destination problem, fix the page first, then appeal "Changes made to comply").

Never invent evidence. Only Google's reasons, the article and the page given.`;

function fitFix(issue: PolicyIssue, fix: PolicyFix): PolicyFix {
  const fits = (n: number) => (s: string) => s.trim().length > 0 && s.trim().length <= n;
  const headlines = [...new Set(fix.headlines.map((s) => s.trim()))].filter(fits(LIMITS.headline)).slice(0, 15);
  const descriptions = [...new Set(fix.descriptions.map((s) => s.trim()))].filter(fits(LIMITS.description)).slice(0, 4);
  const assetLimit = issue.text.assetType === "SITELINK" || issue.text.assetType === "CALLOUT" ? LIMITS.sitelink : LIMITS.description;
  return {
    kind: fix.kind,
    headlines: issue.kind === "ad" && headlines.length >= 3 ? headlines : [],
    descriptions: issue.kind === "ad" && descriptions.length >= 2 ? descriptions : [],
    keyword: issue.kind === "keyword" && fix.keyword && fits(LIMITS.keyword)(fix.keyword) ? fix.keyword.trim() : null,
    assetText: issue.kind === "asset" && fix.assetText && fits(assetLimit)(fix.assetText) ? fix.assetText.trim() : null,
    page: fix.page.filter(Boolean).slice(0, 8),
  };
}

/** The scan as kept (the page text was for the AI only) */
function withoutText(l: (LandingScan & { text: string }) | null): LandingScan | null {
  if (!l) return null;
  const rest: Partial<LandingScan & { text: string }> = { ...l };
  delete rest.text;
  return rest as LandingScan;
}

/** One issue reviewed: articles read, landing page opened, and the AI's what, why and fix */
export async function reviewIssue(admin: SupabaseClient, clientId: string, issue: PolicyIssue, pages: Map<string, Promise<LandingScan & { text: string }>>): Promise<PolicyIssue> {
  const urls = [...new Set(issue.topics.map((t) => articleFor(t.topic)))].slice(0, 3);
  const read = await Promise.all(urls.map(async (url) => ({ url, ...(await policyArticle(admin, url)) })));
  const target = issue.topics.find((t) => t.destination)?.destination ?? issue.finalUrl;
  let landing: (LandingScan & { text: string }) | null = null;
  if (target && /^https?:\/\//.test(target)) {
    if (!pages.has(target)) pages.set(target, scanLanding(target));
    landing = await pages.get(target)!;
  }
  const t = issue.text;
  const itemText = [
    t.headlines.length ? `Headlines (${t.headlines.length}):\n${t.headlines.map((h) => `- ${h} (${h.length})`).join("\n")}` : "",
    t.descriptions.length ? `Descriptions:\n${t.descriptions.map((d) => `- ${d} (${d.length})`).join("\n")}` : "",
    t.path1 || t.path2 ? `Display path: /${[t.path1, t.path2].filter(Boolean).join("/")}` : "",
    t.keyword ? `Keyword: ${t.keyword} (${t.match ?? ""})` : "",
    t.asset ? `${human(t.assetType ?? "asset")}: ${t.asset}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const prompt = `<item kind="${issue.kind}" status="${issue.status}" review="${issue.review ?? ""}">
${issue.label}${issue.campaign ? `\nCampaign: ${issue.campaign}` : ""}${issue.adGroup ? ` · Ad group: ${issue.adGroup}` : ""}
${itemText}
Final URL: ${issue.finalUrl ?? "none"}
</item>

<google_reasons>
${issue.topics.map((p) => `- ${p.topic} (${p.type})${p.evidence.length ? `: ${p.evidence.join(" | ")}` : ""}`).join("\n")}
</google_reasons>

${read.map((a) => `<policy_article url="${a.url}" title="${a.title ?? ""}">\n${a.body.slice(0, 5000) || "(couldn't be read)"}\n</policy_article>`).join("\n\n")}

${
  landing
    ? `<landing_page url="${landing.url}">
Final URL: ${landing.finalUrl ?? "never reached"}${landing.redirects.length ? `\nRedirects: ${landing.redirects.join(" → ")}` : ""}
Status: ${landing.status ?? "no answer"} · ${landing.ms != null ? `${(landing.ms / 1000).toFixed(1)}s` : ""} · ${landing.https ? "HTTPS" : "not HTTPS"}
Privacy policy link: ${landing.privacy ? "yes" : "not found"} · Contact details: ${landing.contact ? "yes" : "not found"}${landing.note ? `\nNote: ${landing.note}` : ""}
Page text:
${landing.text || "(none)"}
</landing_page>`
    : "<landing_page>No landing page to read.</landing_page>"
}`;
  try {
    const ai = await askJson<PolicyReview>({ agent: "google_auditor", label: "google policy check ", clientId, override: { model: "sonnet", effort: "medium" }, maxTokens: 6000, system: SYSTEM, prompt, schema: REVIEW_SCHEMA });
    return {
      ...issue,
      articles: read.map((a, i) => ({ topic: issue.topics[i]?.topic ?? issue.topics[0]?.topic ?? "", url: a.url, title: a.title, quote: a.url === ai.article ? ai.quote : null })),
      landing: withoutText(landing),
      ai: { ...ai, triggers: (ai.triggers ?? []).slice(0, 8), fix: fitFix(issue, ai.fix) },
    };
  } catch (e) {
    console.error("[policy] review", issue.key, e instanceof Error ? e.message : e);
    return { ...issue, articles: read.map((a) => ({ topic: issue.topics[0]?.topic ?? "", url: a.url, title: a.title, quote: null })), landing: withoutText(landing) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const at = i++;
        out[at] = await fn(items[at]);
      }
    }),
  );
  return out;
}

/** The client's Google Ads account (their Google KPI card) */
export async function googleAccountOf(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("kpi_targets").select("ad_account_id, owner_id").eq("client_id", clientId).eq("platform", "google").not("ad_account_id", "is", null).order("active", { ascending: false }).limit(1).maybeSingle();
  return data?.ad_account_id ? { account: String(data.ad_account_id).replace(/\D/g, ""), ownerId: (data.owner_id as string) ?? null } : null;
}

/** Start "Check everything": a row now, the work after (it reads Google, every article and page, and the AI per item) */
export async function startPolicyCheck(admin: SupabaseClient, clientId: string, by: string | null) {
  const acc = await googleAccountOf(admin, clientId);
  if (!acc) throw new Error("No Google Ads account on this client's Google KPI card.");
  const { data: running } = await admin.from("policy_checks").select("id, created_at").eq("client_id", clientId).eq("status", "running").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (running && Date.now() - new Date(running.created_at as string).getTime() < 15 * 60_000) return { id: running.id as string, account: acc.account, already: true };
  const { data, error } = await admin.from("policy_checks").insert({ client_id: clientId, account: acc.account, created_by: by }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't start the check");
  return { id: data.id as string, account: acc.account, already: false };
}

export async function runPolicyCheck(admin: SupabaseClient, checkId: string) {
  const { data: row } = await admin.from("policy_checks").select("client_id, account").eq("id", checkId).single();
  if (!row) return;
  try {
    const { issues, notes } = await readPolicyIssues(row.account as string);
    const pages = new Map<string, Promise<LandingScan & { text: string }>>();
    const reviewed = await pool(issues.slice(0, 40), 4, (i) => reviewIssue(admin, row.client_id as string, i, pages));
    const rest = issues.slice(40);
    const counts = { high: issues.filter((i) => i.severity === "high").length, limited: issues.filter((i) => i.severity !== "high").length };
    const summary = issues.length
      ? `${counts.high} disapproved, ${counts.limited} limited${rest.length ? ` (the first 40 reviewed)` : ""}.${notes.length ? ` ${notes.join(" ")}` : ""}`
      : `Nothing disapproved or limited.${notes.length ? ` ${notes.join(" ")}` : ""}`;
    await admin.from("policy_checks").update({ status: "done", issues: [...reviewed, ...rest], summary, finished_at: new Date().toISOString() }).eq("id", checkId);
  } catch (e) {
    await admin.from("policy_checks").update({ status: "failed", error: e instanceof Error ? e.message.slice(0, 500) : "Failed", finished_at: new Date().toISOString() }).eq("id", checkId);
  }
}

export async function latestPolicyCheck(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("policy_checks").select("id, account, status, issues, summary, error, created_at, finished_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? { ...data, issues: (data.issues ?? []) as PolicyIssue[] } : null;
}

// ─── The three ways forward ──────────────────────────────────────────────────────────────────────────────────────────

/** What to do by hand when the fix can't (or may not) be applied here */
export function fixChecklist(issue: PolicyIssue): string[] {
  const f = issue.ai?.fix;
  const steps: string[] = [];
  if (!f) return ["Run the check again: this item hasn't been reviewed yet."];
  const where = [issue.campaign && `campaign "${issue.campaign}"`, issue.adGroup && `ad group "${issue.adGroup}"`].filter(Boolean).join(", ");
  if (issue.kind === "ad" && f.headlines.length) {
    steps.push(`In Google Ads, open Ads & assets${where ? ` (${where})` : ""} and edit the ad "${issue.label.replace(/^Ad · /, "")}" (or make a copy, paused).`);
    steps.push(`Headlines: ${f.headlines.join(" | ")}`);
    if (f.descriptions.length) steps.push(`Descriptions: ${f.descriptions.join(" | ")}`);
  }
  if (issue.kind === "keyword" && f.keyword) steps.push(`In ${where || "the ad group"}, pause "${issue.text.keyword}" and add "${f.keyword}" (${(issue.text.match ?? "").toLowerCase()}).`);
  if (issue.kind === "asset" && f.assetText) steps.push(`In Assets, replace the ${human(issue.text.assetType ?? "asset").toLowerCase()} "${issue.text.asset}" with "${f.assetText}".`);
  for (const p of f.page) steps.push(`On the landing page: ${p}`);
  steps.push("Then request a review (Appeal) for the item, with the drafted appeal.");
  return steps;
}

export type ApplyResult = { ok: true; mode: "applied"; note: string; resource: string | null } | { ok: true; mode: "checklist"; note: string; steps: string[] } | { ok: false; error: string };

/**
 * Apply the fix: a PAUSED replacement next to the item (a new responsive search ad with the compliant text, or the
 * compliant keyword), checked by Google first, then made. Only where live changes in Google Ads are on for this client
 * and the person may change the account; otherwise, and for page fixes and assets, the checklist.
 */
export async function applyPolicyFix(admin: SupabaseClient, me: Staff, checkId: string, key: string): Promise<ApplyResult> {
  const { data: row } = await admin.from("policy_checks").select("client_id, account, issues").eq("id", checkId).single();
  if (!row) return { ok: false, error: "That check isn't there any more." };
  const issues = (row.issues ?? []) as PolicyIssue[];
  const issue = issues.find((i) => i.key === key);
  if (!issue?.ai) return { ok: false, error: "That item hasn't been reviewed yet." };
  const steps = fixChecklist(issue);
  const acc = await googleAccountOf(admin, row.client_id as string);
  if (!canApply(me, acc?.ownerId ?? null, "google")) return { ok: true, mode: "checklist", note: "Only an exec, the Head of Google or the account's buyer can change the account; here's the fix to make by hand.", steps };
  if (!(await googleWritesOn(admin, row.account as string))) return { ok: true, mode: "checklist", note: "Live Google changes are off for this client, so here's the fix to make by hand.", steps };
  const f = issue.ai.fix;
  let service: "adGroupAds" | "adGroupCriteria" | null = null;
  let ops: unknown[] = [];
  if (issue.kind === "ad" && issue.adGroupResource && f.headlines.length >= 3 && f.descriptions.length >= 2 && issue.finalUrl) {
    service = "adGroupAds";
    ops = [
      {
        create: {
          adGroup: issue.adGroupResource,
          status: "PAUSED",
          ad: {
            finalUrls: [issue.finalUrl],
            responsiveSearchAd: {
              headlines: f.headlines.map((text) => ({ text })),
              descriptions: f.descriptions.map((text) => ({ text })),
              ...(issue.text.path1 ? { path1: issue.text.path1.slice(0, LIMITS.path) } : {}),
              ...(issue.text.path2 ? { path2: issue.text.path2.slice(0, LIMITS.path) } : {}),
            },
          },
        },
      },
    ];
  } else if (issue.kind === "keyword" && issue.adGroupResource && f.keyword) {
    service = "adGroupCriteria";
    ops = [{ create: { adGroup: issue.adGroupResource, status: "PAUSED", keyword: { text: f.keyword, matchType: issue.text.match ?? "PHRASE" } } }];
  }
  if (!service) return { ok: true, mode: "checklist", note: f.kind === "page" ? "The fix is on the landing page, so here's what to change." : "This kind of item is fixed by hand; here's how.", steps };
  try {
    await googleMutate(row.account as string, service, ops, true);
    const made = await googleMutate(row.account as string, service, ops, false);
    const resource = made.results?.[0]?.resourceName ?? null;
    const note = issue.kind === "ad" ? "A compliant copy of the ad was made next to it, paused. Turn it on and pause the old one when you're happy." : "The compliant keyword was added next to it, paused.";
    const next = issues.map((i) => (i.key === key ? { ...i, applied: { at: new Date().toISOString(), by: me.fullName, result: note, resource } } : i));
    await admin.from("policy_checks").update({ issues: next }).eq("id", checkId);
    await admin
      .from("ad_changes")
      .insert({ client_id: row.client_id, platform: "google", account: row.account, status: "applied", source: "policy", title: `Policy fix: ${issue.label}`.slice(0, 200), note, ops: [{ kind: "policy_fix", service, resource, why: issue.ai.wrong }], planned_by: me.id, applied_by: me.id, applied_at: new Date().toISOString() })
      .then(
        () => null,
        () => null,
      );
    return { ok: true, mode: "applied", note, resource };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Google refused it";
    return { ok: true, mode: "checklist", note: `Google wouldn't take the replacement (${msg.slice(0, 220)}). Here's the fix to make by hand.`, steps };
  }
}

/** The appeal, ready to send: what Google support or the Appeal form should read */
export function appealFor(issue: PolicyIssue) {
  return issue.ai?.appeal ?? "";
}

/**
 * Request review. The Google Ads API has no appeal call for a disapproved ad, asset or keyword (appeals are made in
 * Google Ads or the Policy Manager), so this is the how-to and the appeal to paste, with the item's direct place.
 */
export function requestReviewFor(issue: PolicyIssue, account: string) {
  const ocid = account.replace(/\D/g, "");
  return {
    viaApi: false,
    steps: [issue.ai?.requestReview ?? "In Google Ads, hover the item's status in Ads & assets (or Keywords) and choose Appeal.", "Pick \"Changes made to comply\" once the fix is in, or \"Dispute decision\" if nothing needed to change, and paste the appeal."],
    appeal: appealFor(issue),
    link: `https://ads.google.com/aw/policymanager?ocid=${ocid}`,
  };
}

// ─── For Kaizen AI ───────────────────────────────────────────────────────────────────────────────────────────────────

async function clientIdFor(admin: SupabaseClient, input: Record<string, unknown>) {
  if (typeof input.client_id === "string") return input.client_id;
  if (typeof input.client === "string") {
    const { data } = await admin.from("clients").select("id").or(`slug.eq.${input.client.replace(/[^\w-]/g, "")},name.ilike.%${input.client.replace(/[%,()]/g, "")}%`).limit(1).maybeSingle();
    if (data) return data.id as string;
  }
  throw new Error("Which client? Give client_id or the client's name.");
}

export const tools: AiTool[] = [
  {
    name: "google_policy_check",
    description: "Check a client's Google Ads account for policy problems: every disapproved or limited ad, asset and keyword, with the exact trigger, Google's policy article, a landing page scan and the fix. Runs now and returns the findings (can take a minute or two).",
    input_schema: { type: "object", properties: { client_id: { type: "string" }, client: { type: "string", description: "The client's name or slug, when the id isn't known" } } },
    run: async (user, input) => {
      const admin = createAdminClient();
      const clientId = await clientIdFor(admin, input);
      const s = await startPolicyCheck(admin, clientId, user.id);
      if (!s.already) await runPolicyCheck(admin, s.id);
      const c = await latestPolicyCheck(admin, clientId);
      return {
        check_id: c?.id,
        status: c?.status,
        summary: c?.summary ?? c?.error,
        issues: (c?.issues ?? []).map((i) => ({ key: i.key, severity: i.severity, item: i.label, status: i.status, triggers: i.ai?.triggers ?? i.topics.flatMap((t) => t.evidence), wrong: i.ai?.wrong, why: i.ai?.why, article: i.ai?.article ?? i.articles[0]?.url, fix: i.ai?.fix, appeal: i.ai?.appeal })),
      };
    },
  },
  {
    name: "google_policy_latest",
    description: "The latest Google policy check for a client (without running a new one).",
    input_schema: { type: "object", properties: { client_id: { type: "string" }, client: { type: "string" } } },
    run: async (_user, input) => {
      const admin = createAdminClient();
      return latestPolicyCheck(admin, await clientIdFor(admin, input));
    },
  },
  {
    name: "google_policy_apply_fix",
    description: "Apply the fix for one item from a policy check: a paused compliant replacement in Google Ads where live Google changes are on and the person may change the account; otherwise the checklist to do by hand.",
    input_schema: { type: "object", properties: { check_id: { type: "string" }, key: { type: "string", description: "The item's key from the check" } }, required: ["check_id", "key"] },
    run: async (user, input) => applyPolicyFix(createAdminClient(), user, String(input.check_id), String(input.key)),
  },
  {
    name: "google_policy_request_review",
    description: "How to request Google's review for one item, with the drafted appeal to paste (the API has no appeal call).",
    input_schema: { type: "object", properties: { check_id: { type: "string" }, key: { type: "string" } }, required: ["check_id", "key"] },
    run: async (_user, input) => {
      const { data } = await createAdminClient().from("policy_checks").select("account, issues").eq("id", String(input.check_id)).single();
      const issue = ((data?.issues ?? []) as PolicyIssue[]).find((i) => i.key === input.key);
      if (!data || !issue) throw new Error("That item isn't in the check.");
      return requestReviewFor(issue, data.account as string);
    },
  },
];
