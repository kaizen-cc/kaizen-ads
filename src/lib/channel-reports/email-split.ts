// The conversion summary's attribution split: each day's revenue by channel and type, in four parts. Email campaigns and
// automated emails (flows) in two blues, SMS campaigns and automated texts in two oranges, a darker shade for campaigns
// and a lighter one for flows. The PDF's chart and legend and the live page draw from the same parts and the same
// palette, so they can never disagree. Pure: no database, no network.

export type SplitKey = "emailCampaign" | "emailFlow" | "smsCampaign" | "smsFlow";
export type Split = Record<SplitKey, number>;

export const SPLIT_ORDER: SplitKey[] = ["emailCampaign", "emailFlow", "smsCampaign", "smsFlow"];
export const SPLIT_LABEL: Record<SplitKey, string> = { emailCampaign: "Email campaigns", emailFlow: "Email automations", smsCampaign: "SMS campaigns", smsFlow: "SMS automations" };
/** Darker blue / lighter blue for email, darker orange / lighter orange for SMS */
export const SPLIT_HEX: Record<SplitKey, string> = { emailCampaign: "#1d4f9c", emailFlow: "#7fb1ec", smsCampaign: "#c2570c", smsFlow: "#f4a85e" };

const r2 = (n: number) => Math.round(n * 100) / 100;
export const emptySplit = (): Split => ({ emailCampaign: 0, emailFlow: 0, smsCampaign: 0, smsFlow: 0 });
export const splitTotal = (s: Split) => r2(s.emailCampaign + s.emailFlow + s.smsCampaign + s.smsFlow);
export const splitSms = (s: Split) => r2(s.smsCampaign + s.smsFlow);
export const splitEmail = (s: Split) => r2(s.emailCampaign + s.emailFlow);

/**
 * One day's revenue in four parts adding up to the day's campaigns plus automated messages. `sms` is the part of both that
 * came from texts and `smsCampaign` the part of that from SMS campaigns; the rest of the texts' revenue is automated. A
 * text number can never exceed what its side earned, so the parts never go negative and never add up to more than the day.
 */
export function splitDay(p: { campaign: number; flow: number; sms?: number; smsCampaign?: number }): Split {
  const campaign = Math.max(0, p.campaign);
  const flow = Math.max(0, p.flow);
  const sms = Math.max(0, Math.min(p.sms ?? 0, campaign + flow));
  const smsCampaign = Math.max(0, Math.min(p.smsCampaign ?? 0, sms, campaign));
  const smsFlow = Math.min(Math.max(0, sms - smsCampaign), flow);
  return { emailCampaign: r2(campaign - smsCampaign), emailFlow: r2(flow - smsFlow), smsCampaign: r2(smsCampaign), smsFlow: r2(smsFlow) };
}

/** Days added up (a period's totals are exactly its bars' sum) */
export function sumSplits(list: Split[]): Split {
  const out = emptySplit();
  for (const s of list) for (const k of SPLIT_ORDER) out[k] = r2(out[k] + s[k]);
  return out;
}

/** The period's split from its days, or null when there are none */
export const splitOfDays = (days: { campaign: number; flow: number; sms?: number; smsCampaign?: number }[]): Split | null => (days.length ? sumSplits(days.map(splitDay)) : null);

/** SMS shades only appear when texts earned something in the period */
export const hasSmsRevenue = (s: Split | null | undefined) => s != null && splitSms(s) > 0;

/** One legend line: a part's name, colour, revenue and share of the period's total (null share with no revenue at all) */
export type SplitLegendRow = { key: SplitKey; label: string; color: string; revenue: number; before: number | null; share: number | null };

/** The legend: the four parts (the SMS two only with SMS revenue), each with its share of the total and the period before */
export function splitLegend(now: Split, before: Split | null): { rows: SplitLegendRow[]; total: number; totalBefore: number | null; sms: boolean } {
  const sms = hasSmsRevenue(now);
  const keys = SPLIT_ORDER.filter((k) => sms || (k !== "smsCampaign" && k !== "smsFlow"));
  const total = splitTotal(now);
  return {
    rows: keys.map((key) => ({ key, label: SPLIT_LABEL[key], color: SPLIT_HEX[key], revenue: now[key], before: before ? before[key] : null, share: total > 0 ? now[key] / total : null })),
    total,
    totalBefore: before ? splitTotal(before) : null,
    sms,
  };
}
