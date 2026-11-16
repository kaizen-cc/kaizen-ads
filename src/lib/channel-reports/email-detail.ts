import { deliverabilityScore, EMAIL_CHECKS, type EmailCheckKey } from "@/lib/email-score";
import type { CampaignLite, DailyRow, FlowLite } from "@/lib/klaviyo/insights";

// The email report's detail, the way the email team reads an account in Klaviyo's overview dashboard, but only what they
// use: orders, each day's revenue from campaigns against automated emails, campaign and flow performance for the
// report's own dates (each campaign sent, the flows that sent, best first), deliverability and subscriber growth, each
// against the period before. Pure, so the PDF, the writer's numbers and the tests read the same figures. A block with
// nothing behind it is null, so the PDF leaves it out instead of drawing zeros.

/** A flow's numbers on one day (klaviyo_flow_daily, written from Klaviyo's daily flow series) */
export type FlowDay = { flowId: string; date: string; recipients: number; delivered: number; opensUnique: number; clicksUnique: number; conversions: number; revenue: number };

/** A number for the period and the one before (null when there was nothing to read) */
export type Pair = { now: number | null; before: number | null };

/** Good, fair or poor against Kaizen's bar for the rate (src/lib/email-score.ts) */
export type Grade = "good" | "fair" | "poor";

const bar = (k: EmailCheckKey) => EMAIL_CHECKS.find((c) => c.key === k)!.bar;
/** Kaizen's bars: campaign open 30%, click 1%; flow open 35%, click 1.5% */
export const RATE_BARS = { campaign: { open: bar("campaignOpen"), click: bar("campaignClick") }, flow: { open: bar("flowOpen"), click: bar("flowClick") } } as const;

/** At or over the bar is good, within a quarter of it fair, further under poor */
export function grade(value: number | null | undefined, target: number): Grade | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= target) return "good";
  return value >= target * 0.75 ? "fair" : "poor";
}

/** One campaign or flow as a table row */
export type MessageRow = { id: string; name: string; date: string | null; channel: "email" | "sms"; status: string | null; recipients: number; delivered: number; openRate: number | null; clickRate: number | null; orders: number; orderRate: number | null; revenue: number };

/** The performance of campaigns (or flows) over the period and the one before */
export type PerfBlock = { recipients: Pair; open: Pair; click: Pair; orderRate: Pair; orders: Pair; revenue: Pair; sent: Pair };

export type EmailDetail = {
  version: 1;
  /** Placed orders attributed to email and SMS */
  orders: Pair;
  /** Each day of the period: revenue from campaigns and from automated emails */
  daily: { date: string; campaign: number; flow: number }[];
  campaign: PerfBlock;
  /** Every campaign sent in the period, oldest first */
  campaigns: MessageRow[];
  /** Null when the flows' daily numbers weren't read (the PDF falls back to Klaviyo's 30-day flow report) */
  flow: PerfBlock | null;
  /** The flows that sent in the period, best revenue first (the first eight) */
  flows: MessageRow[];
  /** The rest added up, when there are more than eight */
  flowsOther: (MessageRow & { count: number }) | null;
  /** Campaign email: bounces, spam complaints and unsubscribes, and Kaizen's deliverability score */
  deliverability: { recipients: Pair; bounce: Pair; spam: Pair; unsub: Pair; score: Pair } | null;
  /** The main list: its size at the end of each period, and the joins and leaves in it */
  subscribers: { total: Pair; joined: Pair; left: Pair } | null;
};

export type DetailInput = {
  main: { start: string; end: string };
  compare: { start: string; end: string };
  days: (DailyRow & { conversions?: number | null })[];
  campaigns: CampaignLite[];
  /** Null when the flows' daily numbers aren't stored (migration not applied, or never read) */
  flowDays: FlowDay[] | null;
  flows: Pick<FlowLite, "id" | "name" | "status">[];
  /** The main list's size on the days it was read */
  sizes: { date: string; profiles: number }[];
  /** How many flows the table shows before the rest are added up */
  topFlows?: number;
};

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const etDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
type Win = { start: string; end: string };
const inWin = (d: string, w: Win) => d >= w.start && d <= w.end;

const sentIn = (list: CampaignLite[], w: Win) => list.filter((c) => inWin(etDay(c.sendTime), w) && c.recipients > 0);

function campaignPerf(list: CampaignLite[]) {
  const em = list.filter((c) => c.channel !== "sms");
  const delivered = sum(em, (c) => c.delivered || c.recipients);
  const recipients = sum(list, (c) => c.recipients);
  const orders = sum(list, (c) => c.conversions);
  return {
    recipients: list.length ? recipients : null,
    open: ratio(sum(em, (c) => c.opensUnique), delivered),
    click: ratio(sum(em, (c) => c.clicksUnique), delivered),
    orderRate: ratio(orders, recipients),
    orders: list.length ? orders : null,
    revenue: list.length ? r2(sum(list, (c) => c.revenue)) : null,
    sent: list.length,
  };
}

type FlowTotals = { recipients: number; delivered: number; opens: number; clicks: number; orders: number; revenue: number };
function flowTotals(rows: FlowDay[]): FlowTotals {
  return { recipients: sum(rows, (r) => r.recipients), delivered: sum(rows, (r) => r.delivered), opens: sum(rows, (r) => r.opensUnique), clicks: sum(rows, (r) => r.clicksUnique), orders: sum(rows, (r) => r.conversions), revenue: sum(rows, (r) => r.revenue) };
}
const flowPerf = (t: FlowTotals, flowsSent: number) => ({ recipients: t.recipients, open: ratio(t.opens, t.delivered || t.recipients), click: ratio(t.clicks, t.delivered || t.recipients), orderRate: ratio(t.orders, t.recipients), orders: t.orders, revenue: r2(t.revenue), sent: flowsSent });

const pair = <K extends string>(a: Record<K, number | null>, b: Record<K, number | null>, k: K): Pair => ({ now: a[k], before: b[k] });
const perfPair = (a: ReturnType<typeof campaignPerf>, b: ReturnType<typeof campaignPerf>): PerfBlock => ({
  recipients: pair(a, b, "recipients"),
  open: pair(a, b, "open"),
  click: pair(a, b, "click"),
  orderRate: pair(a, b, "orderRate"),
  orders: pair(a, b, "orders"),
  revenue: pair(a, b, "revenue"),
  sent: pair(a, b, "sent"),
});

/** The main list's size on a day: the latest read on or before it */
function sizeOn(sizes: { date: string; profiles: number }[], day: string): number | null {
  let best: { date: string; profiles: number } | null = null;
  for (const s of sizes) if (s.date <= day && (!best || s.date > best.date)) best = s;
  return best ? best.profiles : null;
}

/** Orders in a window: the daily rows when they carry them, else campaigns sent plus the flows' days */
function ordersIn(i: DetailInput, w: Win): number | null {
  const ds = i.days.filter((d) => inWin(d.date, w) && d.conversions != null);
  if (ds.length) return Math.round(sum(ds, (d) => d.conversions ?? 0));
  const camp = sum(sentIn(i.campaigns, w), (c) => c.conversions);
  const flows = i.flowDays ? sum(i.flowDays.filter((r) => inWin(r.date, w)), (r) => r.conversions) : 0;
  return camp || flows ? Math.round(camp + flows) : null;
}

function deliverabilityOf(list: CampaignLite[]) {
  const em = list.filter((c) => c.channel !== "sms");
  const recipients = sum(em, (c) => c.recipients);
  const delivered = sum(em, (c) => c.delivered || c.recipients);
  const bounced = sum(em, (c) => c.bounced);
  const spam = sum(em, (c) => c.spamComplaints);
  const unsubs = sum(em, (c) => c.unsubscribes);
  const opens = sum(em, (c) => c.opensUnique);
  const clicks = sum(em, (c) => c.clicksUnique);
  return { recipients: em.length ? recipients : null, bounce: ratio(bounced, recipients), spam: ratio(spam, delivered), unsub: ratio(unsubs, delivered), score: deliverabilityScore({ recipients, delivered, bounced, spam, unsubscribes: unsubs, opens, clicks })?.score ?? null };
}

export function emailDetail(i: DetailInput): EmailDetail {
  const top = i.topFlows ?? 8;
  const now = sentIn(i.campaigns, i.main);
  const before = sentIn(i.campaigns, i.compare);

  // Each day of the period, campaigns against automated emails (quiet days kept, at zero)
  const byDate = new Map(i.days.map((d) => [d.date, d]));
  const daily: EmailDetail["daily"] = [];
  if (i.days.some((d) => inWin(d.date, i.main)))
    for (let d = i.main.start; d <= i.main.end; d = nextDay(d)) {
      const row = byDate.get(d);
      daily.push({ date: d, campaign: r2(row?.campaignRevenue ?? 0), flow: r2(row?.flowRevenue ?? 0) });
    }

  const campaigns: MessageRow[] = [...now]
    .sort((a, b) => (a.sendTime ?? "").localeCompare(b.sendTime ?? "") || a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      date: etDay(c.sendTime),
      channel: c.channel === "sms" ? "sms" : "email",
      status: null,
      recipients: c.recipients,
      delivered: c.delivered,
      openRate: c.channel === "sms" ? null : ratio(c.opensUnique, c.delivered || c.recipients) ?? c.openRate,
      clickRate: ratio(c.clicksUnique, c.delivered || c.recipients) ?? c.clickRate,
      orders: Math.round(c.conversions),
      orderRate: ratio(c.conversions, c.recipients),
      revenue: r2(c.revenue),
    }));

  // Flows: exact for the period from their daily rows; nothing read at all means the store doesn't have them yet
  let flow: PerfBlock | null = null;
  let flows: MessageRow[] = [];
  let flowsOther: EmailDetail["flowsOther"] = null;
  if (i.flowDays && i.flowDays.length) {
    const meta = new Map(i.flows.map((f) => [f.id, f]));
    const mainRows = i.flowDays.filter((r) => inWin(r.date, i.main));
    const prevRows = i.flowDays.filter((r) => inWin(r.date, i.compare));
    const per = new Map<string, FlowDay[]>();
    for (const r of mainRows) per.set(r.flowId, [...(per.get(r.flowId) ?? []), r]);
    const rows: MessageRow[] = [...per.entries()]
      .map(([id, rs]) => {
        const t = flowTotals(rs);
        const m = meta.get(id);
        return { id, name: m?.name ?? "Flow", date: null, channel: "email" as const, status: m?.status ?? null, recipients: t.recipients, delivered: t.delivered, openRate: ratio(t.opens, t.delivered || t.recipients), clickRate: ratio(t.clicks, t.delivered || t.recipients), orders: Math.round(t.orders), orderRate: ratio(t.orders, t.recipients), revenue: r2(t.revenue) };
      })
      .filter((r) => r.recipients > 0 || r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue || b.recipients - a.recipients);
    flows = rows.slice(0, top);
    const rest = rows.slice(top);
    if (rest.length) {
      const t = { recipients: sum(rest, (r) => r.recipients), delivered: sum(rest, (r) => r.delivered), orders: sum(rest, (r) => r.orders), revenue: r2(sum(rest, (r) => r.revenue)) };
      const opens = sum(rest, (r) => (r.openRate ?? 0) * (r.delivered || r.recipients));
      const clicks = sum(rest, (r) => (r.clickRate ?? 0) * (r.delivered || r.recipients));
      flowsOther = { id: "other", name: `Other flows (${rest.length})`, date: null, channel: "email", status: null, ...t, openRate: ratio(opens, t.delivered || t.recipients), clickRate: ratio(clicks, t.delivered || t.recipients), orderRate: ratio(t.orders, t.recipients), count: rest.length };
    }
    const sentFlows = (rs: FlowDay[]) => new Set(rs.filter((r) => r.recipients > 0).map((r) => r.flowId)).size;
    flow = perfPair(flowPerf(flowTotals(mainRows), sentFlows(mainRows)), flowPerf(flowTotals(prevRows), sentFlows(prevRows)));
  }

  const dNow = deliverabilityOf(now);
  const dBefore = deliverabilityOf(before);
  // Read from campaign email: a period with none sent has nothing to show (the period before alone isn't news)
  const deliverability = dNow.recipients == null ? null : { recipients: pair(dNow, dBefore, "recipients"), bounce: pair(dNow, dBefore, "bounce"), spam: pair(dNow, dBefore, "spam"), unsub: pair(dNow, dBefore, "unsub"), score: pair(dNow, dBefore, "score") };

  const moves = (w: Win) => {
    const ds = i.days.filter((d) => inWin(d.date, w) && (d.subscribed != null || d.unsubscribed != null));
    return ds.length ? { joined: sum(ds, (d) => d.subscribed ?? 0), left: sum(ds, (d) => d.unsubscribed ?? 0) } : { joined: null, left: null };
  };
  const mNow = moves(i.main);
  const mBefore = moves(i.compare);
  const total = { now: sizeOn(i.sizes, i.main.end), before: sizeOn(i.sizes, i.compare.end) };
  const subscribers = total.now == null && mNow.joined == null ? null : { total, joined: { now: mNow.joined, before: mBefore.joined }, left: { now: mNow.left, before: mBefore.left } };

  return {
    version: 1,
    orders: { now: ordersIn(i, i.main), before: ordersIn(i, i.compare) },
    daily,
    campaign: perfPair(campaignPerf(now), campaignPerf(before)),
    campaigns,
    flow,
    flows,
    flowsOther,
    deliverability,
    subscribers,
  };
}

// ─── What's coming up ──────────────────────────────────────────────────────

/** A dated item the client can expect: a campaign scheduled in Klaviyo, or one the team planned (email_suggestions) */
export type Upcoming = { date: string; title: string; source: "klaviyo" | "planned" | "idea" };

/** The next few weeks' items after the period, by date, each once (a planned one already scheduled in Klaviyo shows once) */
export function upcomingItems(items: Upcoming[], after: string, days = 21): Upcoming[] {
  const until = new Date(Date.parse(`${after}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set<string>();
  const rank = { klaviyo: 0, planned: 1, idea: 2 } as const;
  return items
    .filter((x) => x.date > after && x.date <= until && x.title.trim())
    .sort((a, b) => a.date.localeCompare(b.date) || rank[a.source] - rank[b.source])
    .filter((x) => {
      const k = `${x.date}:${key(x.title)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
}
