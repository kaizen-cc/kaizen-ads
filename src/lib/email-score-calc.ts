import { deliverabilityScore, emailScore, type EmailInputs, type EmailScore } from "./email-score";

// The pure half of the email score loader: raw Klaviyo rows in, the seven inputs out. No database, so it is tested alone.

export type ScoreDay = { revenue: number; storeRevenue: number | null; campaignRecipients: number; flowRecipients: number };
export type ScoreCampaign = { channel: string | null; recipients: number; delivered: number; bounced: number; spam: number; unsubscribes: number; opens: number; openRate: number | null; clickRate: number | null };
export type ScoreFlow = { status: string | null; recipients30: number; openRate30: number | null; clickRate30: number | null };

export type EmailScoreTotals = {
  revenue: number;
  storeRevenue: number;
  /** True when any day carried a store revenue figure */
  storeRead: boolean;
  recipients: number;
  campaignsSent: number;
  campaignDelivered: number;
  flowsLive: number;
  flowRecipients: number;
};

export type Deliverability = NonNullable<ReturnType<typeof deliverabilityScore>>;
export type EmailScoreResult = EmailScore & {
  inputs: EmailInputs;
  /** Kaizen's deliverability parts (null when no email campaign went out in the window) */
  deliverability: Deliverability | null;
  window: { from: string; to: string };
  totals: EmailScoreTotals;
};

const money = (x: number, currency: string | null) => `${!currency || currency === "USD" ? "$" : `${currency} `}${x.toFixed(2)}`;

const pct = (x: number, d: number) => `${(x * 100).toFixed(d)}%`;

/**
 * A check's value or bar as text: percent, money per recipient, or the 0 to 100 deliverability score. Small rates get
 * the decimals they need (a 0.02% spam rate never reads 0.0%), and with `bar` a value just under it shows enough decimals
 * not to read as the bar itself (34.96% against 35% reads 34.96%, never 35%).
 */
export function checkText(unit: "pct" | "money" | "score", x: number | null, currency: string | null = "USD", bar?: number | null): string {
  if (x == null) return "n/a";
  if (unit === "pct") {
    let d = x === 0 ? 0 : x < 0.0001 ? 3 : x < 0.01 ? 2 : x < 0.1 ? 1 : 0;
    while (bar != null && x !== bar && d < 4 && pct(x, d) === pct(bar, Math.max(d, bar < 0.1 ? 1 : 0))) d++;
    return pct(x, d);
  }
  if (unit === "money") {
    const t = money(x, currency);
    return bar != null && x < bar && t === money(bar, currency) ? `${!currency || currency === "USD" ? "$" : `${currency} `}${x.toFixed(3)}` : t;
  }
  return bar != null && x < bar && Math.round(x) >= bar ? String(Math.floor(x * 10) / 10) : String(Math.round(x));
}

/** Points a check costs the score, a whole number of at least 1 once it is under its bar */
export const pointsLost = (c: { weight: number; points: number }) => Math.max(1, Math.round(c.weight - c.points));

const isEmail = (c: ScoreCampaign) => (c.channel ?? "email").toLowerCase() !== "sms";
export const isLiveFlow = (status: string | null) => ["live", "active"].includes((status ?? "").toLowerCase());

/** Weighted mean of rate by weight, skipping rows with no rate; null when nothing carries weight */
function weighted(rows: { w: number; rate: number | null }[]): number | null {
  let w = 0;
  let s = 0;
  for (const r of rows) {
    if (r.rate == null || !Number.isFinite(r.rate) || !(r.w > 0)) continue;
    w += r.w;
    s += r.w * r.rate;
  }
  return w > 0 ? s / w : null;
}

/**
 * The seven inputs from the window's rows. Deliverability reads email campaigns only: Klaviyo's flow stats stored here
 * carry no bounce or spam counts. Campaign rates are weighted by delivered (recipients when that is missing); flow
 * rates by their 30-day recipients, over live flows only.
 */
export function aggregateEmailScore(d: { days: ScoreDay[]; campaigns: ScoreCampaign[]; flows: ScoreFlow[] }): { inputs: EmailInputs; deliverability: Deliverability | null; totals: EmailScoreTotals } {
  const revenue = d.days.reduce((n, x) => n + x.revenue, 0);
  const storeDays = d.days.filter((x) => x.storeRevenue != null);
  const storeRevenue = storeDays.reduce((n, x) => n + (x.storeRevenue ?? 0), 0);
  const recipients = d.days.reduce((n, x) => n + x.campaignRecipients + x.flowRecipients, 0);
  const em = d.campaigns.filter((c) => isEmail(c) && c.recipients > 0);
  const live = d.flows.filter((f) => isLiveFlow(f.status));
  const base = (c: ScoreCampaign) => c.delivered || c.recipients;
  const deliverability = deliverabilityScore({
    recipients: em.reduce((n, c) => n + c.recipients, 0),
    delivered: em.reduce((n, c) => n + c.delivered, 0),
    bounced: em.reduce((n, c) => n + c.bounced, 0),
    spam: em.reduce((n, c) => n + c.spam, 0),
    unsubscribes: em.reduce((n, c) => n + c.unsubscribes, 0),
    opens: em.reduce((n, c) => n + c.opens, 0),
    // Clicks from each campaign's click rate (the counts aren't stored), on the same base as the rate
    clicks: em.reduce((n, c) => n + (c.clickRate ?? 0) * base(c), 0),
  });
  const inputs: EmailInputs = {
    attributed: storeDays.length && storeRevenue > 0 ? revenue / storeRevenue : null,
    rpr: recipients > 0 ? revenue / recipients : null,
    deliverability: deliverability ? deliverability.score : null,
    campaignOpen: weighted(em.map((c) => ({ w: base(c), rate: c.openRate }))),
    campaignClick: weighted(em.map((c) => ({ w: base(c), rate: c.clickRate }))),
    flowOpen: weighted(live.map((f) => ({ w: f.recipients30, rate: f.openRate30 }))),
    flowClick: weighted(live.map((f) => ({ w: f.recipients30, rate: f.clickRate30 }))),
  };
  return {
    inputs,
    deliverability,
    totals: { revenue, storeRevenue, storeRead: storeDays.length > 0, recipients, campaignsSent: em.length, campaignDelivered: em.reduce((n, c) => n + base(c), 0), flowsLive: live.length, flowRecipients: live.reduce((n, f) => n + f.recipients30, 0) },
  };
}

/** Rows in, the full result out */
export function scoreFromRows(d: { days: ScoreDay[]; campaigns: ScoreCampaign[]; flows: ScoreFlow[] }, window: { from: string; to: string }): EmailScoreResult {
  const a = aggregateEmailScore(d);
  return { ...emailScore(a.inputs), ...a, window };
}
