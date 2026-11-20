import "server-only";
import { conversionFor } from "@/lib/kpi/conversions";
import { campaignIncluded, type CampaignScope } from "@/lib/kpi/calc";
import { historyRange } from "@/lib/kaizen-ai/meta-history";
import { byOffer, changeWindows, compareSides, aggregate, fromInsight, rankCreatives, resultTypeOf, type AdRow, type MatchOn, type OfferGroup } from "./custom-core";

// A custom report analysis read live from a client's Meta account (read only, any range up to 37 months back): offers
// compared, before and after a change, the top and worst creatives with their previews. Used by Kaizen AI and the
// assistant (custom_report_data), the report studio's chat, and the drafts of a client whose report style asks for
// these every time. Only the KPI's campaigns count (a campaign left out of the KPI is the client's own).

export type CustomSpec = {
  since: string;
  until?: string | null;
  offers?: OfferGroup[];
  offersOn?: MatchOn;
  byMonth?: boolean;
  change?: { date: string; label?: string | null; days?: number | null } | null;
  creatives?: { top?: number; worst?: number; minSpend?: number | null } | null;
};
export type MetaTarget = CampaignScope & { ad_account_id: string | null; conversion?: string | null };

const FIELDS = "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions,action_values";
const MAX_ROWS = 20_000;

async function adRows(target: MetaTarget, since: string, until: string, monthly: boolean): Promise<{ rows: AdRow[]; capped: boolean }> {
  const { asyncReport } = await import("@/lib/context/meta");
  const excluded = (target.excluded_campaigns ?? []).filter(Boolean);
  const match = target.campaign_match?.trim() || null;
  // Only ads that spent, and only the KPI's campaigns (left out by Meta before it adds up)
  const filtering = [{ field: "spend", operator: "GREATER_THAN", value: 0 }, ...(excluded.length ? [{ field: "campaign.id", operator: "NOT_IN", value: excluded }] : []), ...(match ? [{ field: "campaign.name", operator: "CONTAIN", value: match }] : [])];
  // A background report at Meta: months of ads at once without timing out (read page by page where an account refuses it)
  const act = String(target.ad_account_id).startsWith("act_") ? String(target.ad_account_id) : `act_${target.ad_account_id}`;
  const all = (await asyncReport(act, { level: "ad", time_range: JSON.stringify({ since, until }), fields: FIELDS, filtering: JSON.stringify(filtering), ...(monthly ? { time_increment: "monthly" } : {}) }, 150_000)) as unknown as Record<string, unknown>[];
  const raw = all.slice(0, MAX_ROWS);
  const kept = raw.filter((r) => campaignIncluded(target, { id: r.campaign_id as string | null, name: r.campaign_name as string | null }));
  return { rows: kept.map((r) => fromInsight(r, monthly)), capped: all.length > MAX_ROWS };
}

/** Each picture and preview link for the creatives listed (Meta's own links: the picture expires in a few days) */
async function previews(ids: string[]) {
  if (!ids.length) return new Map<string, { image: string | null; link: string | null; format: string | null; headline: string | null }>();
  const { adPreviews } = await import("@/lib/context/meta");
  const got = await adPreviews(ids.slice(0, 20)).catch(() => null);
  return new Map(ids.map((id) => [id, { image: got?.get(id)?.image ?? null, link: got?.get(id)?.link ?? null, format: got?.get(id)?.format ?? null, headline: got?.get(id)?.headline ?? null }]));
}

export async function customAnalysis(target: MetaTarget, spec: CustomSpec, today: string) {
  if (!target.ad_account_id) throw new Error("No Meta ad account on the KPI board for this client.");
  const range = historyRange(spec.since, spec.until, today);
  if ("error" in range) throw new Error(range.error);
  // historyRange starts from the 1st of the month (for monthly rows); a range asked for from a day keeps that day
  const since = spec.byMonth ? range.since : String(spec.since) > range.since ? String(spec.since) : range.since;
  const monthly = Boolean(spec.byMonth && spec.offers?.length);
  const conv = conversionFor(target.conversion ?? "purchases");
  const main = await adRows(target, since, range.until, monthly);
  const type = resultTypeOf(main.rows, conv.types ?? []);
  const roas = Boolean(conv.roas) || /purchase/.test(type ?? "");
  const out: Record<string, unknown> = {
    range: { since, until: range.until },
    result: type ? `${conv.label} (counted as ${type})` : "no result reported in this range",
    total: aggregate(main.rows, type, roas, "Whole account (the KPI's campaigns)"),
  };
  if (main.capped) out.note = "Very many ads in this range: the newest rows may be cut. Ask for a shorter range or by month for exact totals.";

  if (spec.offers?.length) {
    const b = byOffer(main.rows, spec.offers, type, roas, spec.offersOn ?? "any");
    out.offers = { matched_on: spec.offersOn ?? "any (ad name, then ad set, then campaign)", groups: b.groups, not_matched: b.unmatched, ...(b.months.length ? { by_month: b.months } : {}) };
    if (b.groups.every((g) => g.spend === 0)) out.offers_note = "No ad, ad set or campaign name carries these offers. Read a few names with the creatives or a campaign breakdown and ask what each offer is called in the account.";
  }

  if (spec.change?.date) {
    const w = changeWindows(spec.change.date, today, spec.change.days ?? null);
    if ("error" in w) out.change = { error: w.error };
    else {
      const [before, after] = await Promise.all([adRows(target, w.before.start, w.before.end, false), adRows(target, w.after.start, w.after.end, false)]);
      const b = aggregate(before.rows, type, roas, `Before (${w.before.start} to ${w.before.end})`);
      const a = aggregate(after.rows, type, roas, `After (${w.after.start} to ${w.after.end})`);
      out.change = {
        what: spec.change.label ?? "the change",
        date: spec.change.date,
        days_each_side: w.days,
        before: b,
        after: a,
        moved: compareSides(b, a),
        ...(spec.offers?.length ? { by_offer: spec.offers.map((g) => ({ offer: g.label, before: byOffer(before.rows, [g], type, roas, spec.offersOn ?? "any").groups[0], after: byOffer(after.rows, [g], type, roas, spec.offersOn ?? "any").groups[0] })) } : {}),
        note: "The change day counts as after. Conversion rates don't depend on spend, so read them first; a big shift in spend or audience on either side also moves them.",
      };
    }
  }

  if (spec.creatives) {
    const r = rankCreatives(main.rows, type, roas, spec.creatives);
    const pics = await previews([...r.top, ...r.worst].map((a) => a.ad_id));
    const withPic = (a: (typeof r.top)[number]) => ({ ...a, preview: pics.get(a.ad_id) ?? null, deck_image: `ad:${a.ad_id}` });
    out.creatives = { ranked_by: r.by, min_spend_to_judge: r.threshold, ads_judged: r.judged, ads_total: r.ads, top: r.top.map(withPic), worst: r.worst.map(withPic) };
  }
  return out;
}
