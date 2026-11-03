// The Google health checks Kaizen runs on every account, the lines our Google team draws:
//   - brand spend over 10% of the month's spend (brand always "wins", so it hides what's really working);
//   - search impression share under 10%: not spending enough to compete, so raise the budget or cut keywords;
//   - website conversion rate under 2% (ecommerce) or 5% (lead gen): CRO or a new landing page, now;
//   - a low click-through rate: new copy.
// Pure, so reports, audits and the KPI board all read the same numbers.

export type GoogleFlagKey = "brand_share" | "impression_share" | "conversion_rate" | "ctr";
export type GoogleFlag = { key: GoogleFlagKey; level: "bad" | "warn"; title: string; detail: string; fix: string };
export type GoogleHealth = {
  spend: number;
  brandSpend: number;
  /** Brand campaigns' share of spend, % (null with no spend) */
  brandShare: number | null;
  /** Search impression share across search campaigns, %, with what was lost to budget and to rank */
  impressionShare: { share: number; lostBudget: number; lostRank: number } | null;
  /** Non-brand: clicks, conversions, CTR % and conversion rate % (brand would flatter both) */
  ctr: number | null;
  conversionRate: number | null;
  clicks: number;
  conversions: number;
  model: "ecommerce" | "lead_gen";
  flags: GoogleFlag[];
};

type Row = { campaign_name?: string | null; spend?: number | string | null; impressions?: number | string | null; clicks?: number | string | null; actions?: Record<string, number> | null };

export const BRAND_SHARE_MAX = 10;
export const IMPRESSION_SHARE_MIN = 10;
export const CONVERSION_RATE_MIN = { ecommerce: 2, lead_gen: 5 } as const;
/** Search ads below this click-through rate need new copy */
export const SEARCH_CTR_MIN = 3;

/** A brand campaign: named brand or branded (the convention our Google team uses) */
export function isBrandCampaign(name: string | null | undefined) {
  return /(^|[^a-z])brand(ed)?([^a-z]|$)/i.test(name ?? "");
}

/** Ecommerce when the KPI is a purchase or ROAS; everything else is lead gen */
export function businessModel(conversion: string | null | undefined, roas = false): "ecommerce" | "lead_gen" {
  return roas || /purchase|order|sale|revenue|roas|checkout|cart/i.test(conversion ?? "") ? "ecommerce" : "lead_gen";
}

const n = (v: unknown) => Number(v) || 0;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** The checks over a set of Google campaign days (one period, one account) */
export function googleHealth(rows: Row[], model: "ecommerce" | "lead_gen"): GoogleHealth {
  let spend = 0;
  let brandSpend = 0;
  let clicks = 0;
  let impressions = 0;
  let conversions = 0;
  const is = { imp: 0, el: 0, lb: 0, lr: 0 };
  for (const r of rows) {
    const s = n(r.spend);
    spend += s;
    const a = r.actions ?? {};
    is.imp += n(a["_is:impressions"]);
    is.el += n(a["_is:eligible"]);
    is.lb += n(a["_is:lost_budget"]);
    is.lr += n(a["_is:lost_rank"]);
    if (isBrandCampaign(r.campaign_name)) {
      brandSpend += s;
      continue;
    }
    clicks += n(r.clicks);
    impressions += n(r.impressions);
    conversions += n(a.conversions);
  }
  const brandShare = pct(brandSpend, spend);
  const impressionShare = is.el ? { share: pct(is.imp, is.el)!, lostBudget: pct(is.lb, is.el)!, lostRank: pct(is.lr, is.el)! } : null;
  const ctr = pct(clicks, impressions);
  const conversionRate = clicks >= 50 ? pct(conversions, clicks) : null;
  const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  const flags: GoogleFlag[] = [];
  if (brandShare != null && brandShare > BRAND_SHARE_MAX && spend >= 100)
    flags.push({ key: "brand_share", level: brandShare > 20 ? "bad" : "warn", title: `Brand is ${brandShare}% of spend`, detail: `${money(brandSpend)} of ${money(spend)} went to brand campaigns (over ${BRAND_SHARE_MAX}%). Brand always looks like the winner; the money should be finding new customers.`, fix: "Move budget from brand to non-brand, unless competitors are bidding on the brand name" });
  if (impressionShare && impressionShare.share < IMPRESSION_SHARE_MIN)
    flags.push({ key: "impression_share", level: "bad", title: `Search impression share ${impressionShare.share}%`, detail: `Under ${IMPRESSION_SHARE_MIN}%: not spending enough to compete in this market (lost ${impressionShare.lostBudget}% to budget, ${impressionShare.lostRank}% to rank).`, fix: "Raise the budget or cut keywords to focus it" });
  if (conversionRate != null && conversionRate < CONVERSION_RATE_MIN[model])
    flags.push({ key: "conversion_rate", level: "bad", title: `Website conversion rate ${conversionRate}%`, detail: `Under ${CONVERSION_RATE_MIN[model]}% for ${model === "ecommerce" ? "ecommerce" : "lead gen"} (${Math.round(conversions)} conversions from ${clicks.toLocaleString("en-US")} non-brand clicks).`, fix: "Conversion rate optimization or a new landing page, now" });
  if (ctr != null && impressions >= 1000 && ctr < SEARCH_CTR_MIN)
    flags.push({ key: "ctr", level: "warn", title: `Click-through rate ${ctr}%`, detail: `Under ${SEARCH_CTR_MIN}% on non-brand: the ads aren't earning the click.`, fix: "New ad copy" });
  return { spend: Math.round(spend * 100) / 100, brandSpend: Math.round(brandSpend * 100) / 100, brandShare, impressionShare, ctr, conversionRate, clicks, conversions: Math.round(conversions * 10) / 10, model, flags };
}

/** The checks as lines for a writer or an auditor */
export function googleHealthText(h: GoogleHealth) {
  const lines = [
    `Google health checks (Kaizen's lines: brand ≤ ${BRAND_SHARE_MAX}% of spend, search impression share ≥ ${IMPRESSION_SHARE_MIN}%, website conversion rate ≥ ${CONVERSION_RATE_MIN[h.model]}% for ${h.model === "ecommerce" ? "ecommerce" : "lead gen"}, non-brand CTR ≥ ${SEARCH_CTR_MIN}%; brand campaigns never count as winners):`,
    `- Brand vs non-brand: ${h.brandShare == null ? "no spend" : `${h.brandShare}% brand ($${Math.round(h.brandSpend)} of $${Math.round(h.spend)})`}`,
    `- Search impression share: ${h.impressionShare ? `${h.impressionShare.share}% (lost ${h.impressionShare.lostBudget}% to budget, ${h.impressionShare.lostRank}% to rank)` : "not reported (no search campaigns)"}`,
    `- Non-brand CTR ${h.ctr ?? "?"}%, website conversion rate ${h.conversionRate ?? "too few clicks to judge"}${h.conversionRate != null ? "%" : ""}`,
  ];
  if (h.flags.length) lines.push("FLAGGED (call each out, with the fix):", ...h.flags.map((f) => `- ${f.title}: ${f.detail} Fix: ${f.fix}.`));
  else lines.push("Nothing flagged.");
  return lines.join("\n");
}
