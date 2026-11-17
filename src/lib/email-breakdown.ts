import { EMAIL_CHECKS } from "./email-score";
import { isLiveFlow, paceInput, scoreFromRows, type EmailScoreResult } from "./email-score-calc";
import { revenueTarget } from "./email-metrics";

// The pure side of the account breakdown (campaigns and flows under the score): row shapes, the colour of a rate against
// its bar, the campaign tabs and the flow sort. Shared by the KPI board and the client's Email panel.

export type BCampaign = { id: string; name: string; channel: "email" | "sms"; sendTime: string | null; recipients: number; openRate: number | null; clickRate: number | null; revenue: number; rpr: number | null; /** For the hover preview */ subject?: string | null; previewText?: string | null };
export type BFlow = { id: string; name: string; status: string | null; recipients30: number; openRate30: number | null; clickRate30: number | null; revenue30: number; recipients90: number; openRate90: number | null; clickRate90: number | null; revenue90: number };

export type CampaignTab = "last10" | "all" | "email" | "sms";
export const CAMPAIGN_TABS: { id: CampaignTab; label: string }[] = [
  { id: "last10", label: "Last 10" },
  { id: "all", label: "All campaigns" },
  { id: "email", label: "Email" },
  { id: "sms", label: "SMS" },
];
export const PAGE = 25;

type CampaignInput = { id: string; name: string; channel: string; sendTime: string | null; recipients: number; openRate: number | null; clickRate: number | null; revenue: number; subject?: string | null; previewText?: string | null };
type FlowInput = { id: string; name: string; status: string | null; recipients30: number; openRate30: number | null; clickRate30: number | null; revenue30: number; recipients90: number; openRate90: number | null; clickRate90: number | null; revenue90: number };

/** Sent campaigns, newest first, with revenue per recipient (drafts and never-sent rows have no send time or recipients) */
export function campaignRows(list: CampaignInput[]): BCampaign[] {
  return list
    .filter((c) => c.sendTime && c.recipients > 0)
    .map((c) => ({ id: c.id, name: c.name, channel: (c.channel.toLowerCase() === "sms" ? "sms" : "email") as "email" | "sms", sendTime: c.sendTime, recipients: c.recipients, openRate: c.openRate, clickRate: c.clickRate, revenue: c.revenue, rpr: c.revenue / c.recipients, subject: c.subject ?? null, previewText: c.previewText ?? null }))
    .sort((a, b) => (b.sendTime ?? "").localeCompare(a.sendTime ?? ""));
}

export function flowRows(list: FlowInput[]): BFlow[] {
  return list.filter((f) => isLiveFlow(f.status)).map((f) => ({ id: f.id, name: f.name, status: f.status, recipients30: f.recipients30, openRate30: f.openRate30, clickRate30: f.clickRate30, revenue30: f.revenue30, recipients90: f.recipients90, openRate90: f.openRate90, clickRate90: f.clickRate90, revenue90: f.revenue90 }));
}

/** The campaigns a tab shows, before "show more" cuts them */
export function campaignsFor(rows: BCampaign[], tab: CampaignTab): BCampaign[] {
  if (tab === "last10") return rows.slice(0, 10);
  if (tab === "email") return rows.filter((c) => c.channel === "email");
  if (tab === "sms") return rows.filter((c) => c.channel === "sms");
  return rows;
}

const BAR = Object.fromEntries(EMAIL_CHECKS.map((c) => [c.key, c.bar])) as Record<string, number>;
export const BARS = { campaignOpen: BAR.campaignOpen, campaignClick: BAR.campaignClick, flowOpen: BAR.flowOpen, flowClick: BAR.flowClick };

/** A flow's editor in Klaviyo (opens in the account the person is signed in to) */
export const klaviyoFlowUrl = (flowId: string) => `https://www.klaviyo.com/flow/${encodeURIComponent(flowId)}/edit`;

export type RateTone = "ok" | "warn" | "bad";
/** At or over the bar is green, within a fifth under it yellow, further under red. No rate, no colour. */
export function rateTone(rate: number | null, bar: number): RateTone | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return rate >= bar ? "ok" : rate >= bar * 0.8 ? "warn" : "bad";
}

export type FlowSortKey = "name" | "recipients" | "open" | "click" | "revenue" | "rpr";
export type FlowWindow = 30 | 90;
export const FLOW_SORTS: FlowSortKey[] = ["name", "recipients", "open", "click", "revenue", "rpr"];

export const flowRpr = (f: BFlow, w: FlowWindow) => {
  const rec = w === 30 ? f.recipients30 : f.recipients90;
  return rec > 0 ? (w === 30 ? f.revenue30 : f.revenue90) / rec : null;
};

const flowValue = (f: BFlow, key: FlowSortKey, w: FlowWindow): number | string | null => {
  const n = w === 30;
  if (key === "name") return f.name.toLowerCase();
  if (key === "recipients") return n ? f.recipients30 : f.recipients90;
  if (key === "open") return n ? f.openRate30 : f.openRate90;
  if (key === "click") return n ? f.clickRate30 : f.clickRate90;
  if (key === "revenue") return n ? f.revenue30 : f.revenue90;
  return flowRpr(f, w);
};

/**
 * Flows in the chosen order. The default (no key) is the least performing first: lowest revenue per recipient, ties by
 * click rate. A flow with nothing to rank on (no recipients) always sits last, whichever way the column runs.
 */
export function sortFlows(flows: BFlow[], key: FlowSortKey | null, dir: "asc" | "desc", w: FlowWindow): BFlow[] {
  const click = (f: BFlow) => (w === 30 ? f.clickRate30 : f.clickRate90) ?? 0;
  if (!key) return [...flows].sort((a, b) => (flowRpr(a, w) ?? Infinity) - (flowRpr(b, w) ?? Infinity) || click(a) - click(b) || a.name.localeCompare(b.name));
  const sign = dir === "asc" ? 1 : -1;
  return [...flows].sort((a, b) => {
    const x = flowValue(a, key, w);
    const y = flowValue(b, key, w);
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string") return sign * String(x).localeCompare(String(y));
    return sign * (x - y) || a.name.localeCompare(b.name);
  });
}

/** The score read from what the client page already holds (its 90 days of daily rows, campaigns and flows), same math as the server loader */
export function scoreFromKlaviyo(k: {
  today: string;
  /** False when the source reports no revenue: the money checks are left out */
  revenueMeasured?: boolean;
  /** A monthly revenue target typed on the board; the pace check uses last month +10% when it's higher or missing */
  targetManual?: number | null;
  daily: { date: string; revenue: number; storeRevenue: number | null; recipients: number }[];
  campaigns: { channel: string; sendTime: string | null; recipients: number; delivered: number; bounced: number; spamComplaints: number; unsubscribes: number; opensUnique: number; openRate: number | null; clickRate: number | null }[];
  flows: { status: string | null; recipients30: number; openRate30: number | null; clickRate30: number | null }[];
}): EmailScoreResult {
  const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const from = shift(k.today, -29);
  const ny = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // The revenue pace check, the way the board works it out: this month so far against last month +10% (or higher by hand)
  const [y, m, dom] = k.today.split("-").map(Number);
  const start = k.today.slice(0, 8) + "01";
  const prevEnd = shift(start, -1);
  const prevStart = prevEnd.slice(0, 8) + "01";
  const sum = (a: string, b: string) => k.daily.filter((d) => d.date >= a && d.date <= b).reduce((n, d) => n + d.revenue, 0);
  const hadLast = k.daily.some((d) => d.date >= prevStart && d.date <= prevEnd);
  const target = revenueTarget(hadLast ? sum(prevStart, prevEnd) : null, k.targetManual ?? null).target;
  const pace = paceInput(sum(start, k.today), target, { dayOfMonth: dom, daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() });
  return scoreFromRows(
    {
      days: k.daily.filter((d) => d.date >= from && d.date <= k.today).map((d) => ({ revenue: d.revenue, storeRevenue: d.storeRevenue, campaignRecipients: d.recipients, flowRecipients: 0 })),
      campaigns: k.campaigns.filter((c) => c.sendTime && ny(c.sendTime) >= from && ny(c.sendTime) <= k.today).map((c) => ({ channel: c.channel, recipients: c.recipients, delivered: c.delivered, bounced: c.bounced, spam: c.spamComplaints, unsubscribes: c.unsubscribes, opens: c.opensUnique, openRate: c.openRate, clickRate: c.clickRate })),
      flows: k.flows.map((f) => ({ status: f.status, recipients30: f.recipients30, openRate30: f.openRate30, clickRate30: f.clickRate30 })),
      ...(k.revenueMeasured === false ? { noRevenue: true } : {}),
      pace,
    },
    { from, to: k.today },
  );
}
