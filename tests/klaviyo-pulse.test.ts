import { describe, expect, it } from "vitest";
import { emailContextLine, metricIds, parseCampaignMessages, parseSeriesReport, partialSyncWarning, rollupDays, emptyStats } from "@/lib/klaviyo/core";
import { aggregateBody, audienceGrowth, bestSubjects, deliverabilityByWeek, deliverabilityOutliers, emailHealth, filterCampaigns, keyFlowCoverage, parseMetricAggregate, pulseStatus, pulseWindow, sanitizeEmailHtml, seriesChunks, shareOfRevenue, shiftDay, sortCampaigns, type CampaignLite, type DailyRow, type FlowLite } from "@/lib/klaviyo/insights";

// The Email tab's pulse: series timeframes inside Klaviyo's limits, the store's Placed Order total, the 30-day windows
// with their backstop, key flows, health rules, campaign sorting and filters, deliverability and the safe preview.

const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

// Shaped from a live account's synced tables (names made generic): campaigns with and without recipients, SMS with
// open rate 0, a welcome flow earning most of the flow revenue, no winback.
const TODAY = "2026-11-12";
const camp = (id: string, sendTime: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: `Campaign ${id}`, channel: "email", sendTime, subject: `Subject ${id}`, recipients: 6000, delivered: 5995, opensUnique: 2250, clicksUnique: 150, unsubscribes: 25, bounced: 5, spamComplaints: 2, revenue: 1500, conversions: 25, openRate: 0.375, clickRate: 0.025, ...o });
const CAMPAIGNS: CampaignLite[] = [
  camp("a", "2026-10-14T15:30:00Z", { revenue: 1587.23 }),
  camp("b", "2026-10-14T15:30:00Z", { channel: "sms", subject: null, recipients: 3653, delivered: 3549, opensUnique: 0, clicksUnique: 227, unsubscribes: 59, bounced: 0, spamComplaints: 0, revenue: 642.67, openRate: 0, clickRate: 0.064 }),
  camp("c", "2026-10-21T23:30:00Z", { revenue: 2030.03, openRate: 0.3953 }),
  camp("d", "2026-10-21T23:30:00Z", { channel: "sms", subject: null, recipients: 3536, opensUnique: 0, revenue: 511.62, openRate: 0 }),
  camp("e", "2026-10-28T23:00:00Z", { revenue: 886.38, openRate: 0.3762 }),
  camp("f", "2026-10-29T14:30:00Z", { revenue: 3191.66, openRate: 0.3749 }),
  camp("g", "2026-10-29T14:30:00Z", { channel: "sms", subject: null, recipients: 3909, opensUnique: 0, revenue: 1264.02, openRate: 0 }),
  camp("h", "2026-09-29T14:30:00Z", { revenue: 4106.85, openRate: 0.3689 }),
  camp("i", "2026-09-15T15:30:00Z", { recipients: 0, delivered: 0, opensUnique: 0, clicksUnique: 0, unsubscribes: 0, bounced: 0, spamComplaints: 0, revenue: 0, openRate: null, clickRate: null }),
];
const flow = (id: string, name: string, revenue30: number, status = "live"): FlowLite => ({ id, name, status, trigger: "Metric", revenue30, revenue90: revenue30 * 3, recipients30: 1000, recipients90: 3000, openRate30: 0.35, clickRate30: 0.05, openRate90: 0.35, clickRate90: 0.05 });
const FLOWS: FlowLite[] = [
  flow("1", "KZN | Abandoned Checkout", 992.47),
  flow("2", "KZN | Welcome Series", 6083.9),
  flow("3", "KZN | Abandoned Cart", 1286.37),
  flow("4", "KZN | Post Purchase Flow", 80.6),
  flow("5", "KZN | Review request", 389.62),
  flow("6", "KZN | Revamped Browse Abandonment", 343.68),
  flow("7", "New Subscriber Welcome - Standard", 0, "draft"),
];

describe("series timeframes", () => {
  it("splits 90 days into pieces Klaviyo accepts (a daily series can't be longer than 60 days)", () => {
    const from = shiftDay(TODAY, -89);
    const parts = seriesChunks(from, TODAY, { maxDays: 45, endIso: "2026-11-12T19:00:00+00:00" });
    expect(parts).toEqual([
      { start: `${from}T00:00:00+00:00`, end: `${shiftDay(from, 45)}T00:00:00+00:00` },
      { start: `${shiftDay(from, 45)}T00:00:00+00:00`, end: "2026-11-12T19:00:00+00:00" },
    ]);
    for (const p of parts) expect((Date.parse(p.end) - Date.parse(p.start)) / 86_400_000).toBeLessThanOrEqual(60);
  });
  it("never asks for more than 60 days in one piece, even when told to", () => {
    const parts = seriesChunks("2026-01-01", "2026-04-30", { maxDays: 90 });
    expect(parts.length).toBe(2);
    expect(parts[0].end).toBe("2026-03-02T00:00:00+00:00");
  });
  it("reads a series answer's days and SMS revenue per flow message channel", () => {
    const json = { data: { type: "flow-series-report", attributes: { date_times: ["2026-11-10T00:00:00-06:00", "2026-11-11T00:00:00-06:00"], results: [
      { groupings: { flow_id: "F1", send_channel: "email", flow_message_id: "m1" }, statistics: { recipients: [100, 50], delivered: [99, 50], opens_unique: [30, 10], clicks_unique: [3, 1], conversions: [2, 1], conversion_value: [80, 40] } },
      { groupings: { flow_id: "F1", send_channel: "sms", flow_message_id: "m2" }, statistics: { recipients: [20, 0], conversions: [1, 0], conversion_value: [25, 0] } },
    ] } } };
    const [row] = parseSeriesReport(json);
    expect(row.days.map((d) => [d.date, d.stats.revenue, d.sms])).toEqual([["2026-11-10", 105, 25], ["2026-11-11", 40, 0]]);
    const days = rollupDays({ campaigns: [{ sendTime: "2026-11-11T15:00:00Z", channel: "sms", stats: { ...emptyStats(), revenue: 10, recipients: 5 } }], flows: [row], tz: "US/Central", from: "2026-11-10", to: "2026-11-11" });
    expect(days.map((d) => [d.date, d.revenue, d.smsRevenue])).toEqual([["2026-11-10", 105, 25], ["2026-11-11", 50, 10]]);
  });
});

describe("the store's revenue (Placed Order) and share of revenue", () => {
  it("reads a metric aggregate's daily sum and count", () => {
    const json = { data: { type: "metric-aggregate", id: "x", attributes: { dates: ["2026-11-10T00:00:00+00:00", "2026-11-11T00:00:00+00:00"], data: [{ dimensions: [], measurements: { sum_value: [1200.5, 980], count: [20, 15] } }] } } };
    expect(parseMetricAggregate(json)).toEqual([{ date: "2026-11-10", value: 1200.5, count: 20 }, { date: "2026-11-11", value: 980, count: 15 }]);
    expect(parseMetricAggregate({})).toEqual([]);
  });
  it("asks for whole calendar days in the account's time zone", () => {
    const b = aggregateBody("PO1", "2026-08-15", "2026-11-12", "US/Central");
    expect(b.data.attributes.filter).toEqual(["greater-or-equal(datetime,2026-08-15T00:00:00)", "less-than(datetime,2026-11-13T00:00:00)"]);
    expect(b.data.attributes).toMatchObject({ metric_id: "PO1", interval: "day", timezone: "US/Central", measurements: ["sum_value", "count"] });
  });
  it("is email's attributed revenue over the store's total, n/a without a total", () => {
    expect(shareOfRevenue(19611, 80000)).toBeCloseTo(0.2451, 3);
    expect(shareOfRevenue(100, 0)).toBeNull();
    expect(shareOfRevenue(100, null)).toBeNull();
  });
  it("finds Placed Order and the list metrics by name", () => {
    const json = { data: [
      { id: "A", attributes: { name: "Placed Order", integration: { name: "API" } } },
      { id: "B", attributes: { name: "Placed Order", integration: { name: "Shopify" } } },
      { id: "C", attributes: { name: "Subscribed to List" } },
      { id: "D", attributes: { name: "Unsubscribed from List" } },
    ] };
    expect(metricIds(json)).toEqual({ placedOrder: "B", subscribed: "C", unsubscribed: "D" });
  });
});

describe("the 30-day windows and the backstop", () => {
  const flowTotal = FLOWS.reduce((s, f) => s + f.revenue30, 0);
  it("never reads $0 when the daily rows are missing: campaigns sent in the window plus the flows' 30 days", () => {
    const w = pulseWindow({ days: [], campaigns: CAMPAIGNS, start: shiftDay(TODAY, -29), end: TODAY, flowTotal, flowRecipients: 6000 });
    expect(w.estimated).toBe(true);
    expect(Math.round(w.campaignRevenue)).toBe(10114);
    expect(Math.round(w.revenue)).toBe(Math.round(10113.61 + flowTotal));
    expect(w.campaignsSent).toBe(7);
    expect(w.storeRevenue).toBeNull();
    expect(w.share).toBeNull();
  });
  it("uses the daily rows when they're there, with the store's total and share", () => {
    const days: DailyRow[] = Array.from({ length: 30 }, (_, i) => ({ date: shiftDay(TODAY, -i), revenue: 650, campaignRevenue: 330, flowRevenue: 320, smsRevenue: 80, sends: 900, campaignsSent: 0, storeRevenue: 2600, storeOrders: 40, subscribed: 12, unsubscribed: 5 }));
    const w = pulseWindow({ days, campaigns: CAMPAIGNS, start: shiftDay(TODAY, -29), end: TODAY, flowTotal, flowRecipients: 6000 });
    expect(w.estimated).toBe(false);
    expect(w.revenue).toBe(19500);
    expect(w.storeRevenue).toBe(78000);
    expect(w.share).toBeCloseTo(0.25, 5);
    expect(w.listGrowth).toBe(210);
    expect(w.revenuePerRecipient).toBeCloseTo(19500 / 27000, 5);
  });
  it("keeps open and click rates to email: an SMS's zero opens don't drag them down", () => {
    const w = pulseWindow({ days: [], campaigns: CAMPAIGNS, start: shiftDay(TODAY, -29), end: TODAY, flowTotal: 0, flowRecipients: 0 });
    expect(w.openRate).toBeCloseTo(2250 / 5995, 4);
    expect(w.cadence).toBeCloseTo(1.6, 1);
  });
});

describe("key flows", () => {
  it("finds each key flow by name, live, built or missing", () => {
    const k = Object.fromEntries(keyFlowCoverage(FLOWS).map((f) => [f.id, f.state]));
    expect(k).toEqual({ welcome: "live", abandoned: "live", browse: "live", post_purchase: "live", winback: "missing" });
    const browse = keyFlowCoverage(FLOWS).find((f) => f.id === "abandoned")!;
    expect(browse.flows.map((f) => f.name)).not.toContain("KZN | Revamped Browse Abandonment");
  });
  it("calls a drafted flow present but not live", () => {
    const k = keyFlowCoverage([flow("9", "Winback - 90 days", 0, "draft")]);
    expect(k.find((f) => f.id === "winback")!.state).toBe("present");
    expect(k.find((f) => f.id === "welcome")!.state).toBe("missing");
  });
});

describe("health rules", () => {
  const flowTotal = FLOWS.reduce((s, f) => s + f.revenue30, 0);
  const now = pulseWindow({ days: [], campaigns: CAMPAIGNS, start: shiftDay(TODAY, -29), end: TODAY, flowTotal, flowRecipients: 6000 });
  const before = pulseWindow({ days: [], campaigns: CAMPAIGNS, start: shiftDay(TODAY, -59), end: shiftDay(TODAY, -30), flowTotal: flowTotal * 0.9, flowRecipients: 5000 });
  const health = emailHealth({ now, before, campaigns: CAMPAIGNS, flows: FLOWS, keyFlows: keyFlowCoverage(FLOWS), today: TODAY, money });
  const byId = Object.fromEntries(health.map((h) => [h.id, h]));
  it("flags two weeks without a campaign as red, worst first", () => {
    expect(byId.cadence).toMatchObject({ tone: "bad", title: "No campaign sent in 14 days" });
    expect(health[0].tone).toBe("bad");
  });
  it("flags a missing winback, revenue leaning on one flow, and credits the SMS", () => {
    expect(byId.flow_winback.tone).toBe("warn");
    expect(byId.concentration).toMatchObject({ tone: "warn" });
    expect(byId.concentration.title).toMatch(/^6\d% of flow revenue from one flow$/);
    expect(byId.sms.tone).toBe("good");
  });
  it("holds unsubscribes and spam against healthy lines", () => {
    const bad = { ...now, unsubscribeRate: 0.006, spamRate: 0.0012, bounceRate: 0.005 };
    const h = Object.fromEntries(emailHealth({ now: bad, before: null, campaigns: CAMPAIGNS, flows: FLOWS, keyFlows: keyFlowCoverage(FLOWS), today: TODAY, money }).map((x) => [x.id, x]));
    expect(h.unsub.tone).toBe("bad");
    expect(h.spam.tone).toBe("bad");
    expect(h.deliverability).toBeUndefined();
  });
  it("calls an open-rate drop of a fifth red", () => {
    const h = emailHealth({ now: { ...now, openRate: 0.28 }, before: { ...before, openRate: 0.37 }, campaigns: CAMPAIGNS, flows: FLOWS, keyFlows: keyFlowCoverage(FLOWS), today: TODAY, money });
    expect(h.find((x) => x.id === "open")).toMatchObject({ tone: "bad", title: "Open rate down 24%" });
  });
  it("flags missing critical flows red and reads the overall status", () => {
    const h = emailHealth({ now, before, campaigns: CAMPAIGNS, flows: [], keyFlows: keyFlowCoverage([]), today: TODAY, money });
    expect(h.find((x) => x.id === "flow_welcome")!.tone).toBe("bad");
    expect(h.find((x) => x.id === "flow_browse")!.tone).toBe("warn");
    expect(pulseStatus(h)).toEqual({ tone: "bad", label: "Needs attention" });
    expect(pulseStatus([{ tone: "good" }, { tone: "warn" }])).toEqual({ tone: "good", label: "Healthy" });
  });
});

describe("campaigns: sorting and filters", () => {
  it("filters by channel and window", () => {
    expect(filterCampaigns(CAMPAIGNS, { channel: "sms", days: 30 }, TODAY).map((c) => c.id)).toEqual(["b", "d", "g"]);
    expect(filterCampaigns(CAMPAIGNS, { channel: "email", days: 30 }, TODAY).map((c) => c.id)).toEqual(["a", "c", "e", "f"]);
    expect(filterCampaigns(CAMPAIGNS, { channel: "all", days: 90 }, TODAY)).toHaveLength(9);
  });
  it("sorts by revenue, revenue per recipient and open rate (SMS and unsent last)", () => {
    expect(sortCampaigns(CAMPAIGNS, "revenue")[0].id).toBe("h");
    expect(sortCampaigns(CAMPAIGNS, "date", "asc")[0].id).toBe("i");
    const byOpen = sortCampaigns(CAMPAIGNS, "open");
    expect(byOpen[0].id).toBe("c");
    expect(byOpen.slice(-4).map((c) => c.id).sort()).toEqual(["b", "d", "g", "i"]);
    expect(sortCampaigns(CAMPAIGNS, "open", "asc").slice(-4).map((c) => c.id).sort()).toEqual(["b", "d", "g", "i"]);
    const rpr = sortCampaigns(CAMPAIGNS, "rpr");
    expect(rpr[0].id).toBe("h");
    expect(rpr.at(-1)!.id).toBe("i");
  });
  it("picks the best subject lines from real sends", () => {
    expect(bestSubjects(CAMPAIGNS, 3).map((c) => c.id)).toEqual(["c", "e", "a"]);
  });
});

describe("deliverability and audience growth", () => {
  it("adds email campaigns up by week and lists the ones over the line", () => {
    const weeks = deliverabilityByWeek(CAMPAIGNS);
    expect(weeks.map((w) => w.week)).toEqual(["2026-09-28", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(weeks[3].campaigns).toBe(2);
    const out = deliverabilityOutliers([...CAMPAIGNS, camp("z", "2026-10-30T14:00:00Z", { unsubscribes: 60, spamComplaints: 9 })]);
    expect(out[0].campaign.id).toBe("z");
    expect(out[0].issues.map((i) => i.kind)).toEqual(["spam", "unsubscribe"]);
  });
  it("reads a list's growth from its size snapshots", () => {
    expect(audienceGrowth([{ date: "2026-11-12", profiles: 9000 }])).toBeNull();
    expect(audienceGrowth([{ date: "2026-10-10", profiles: 8400 }, { date: "2026-10-14", profiles: 8500 }, { date: "2026-11-12", profiles: 9000 }])).toEqual({ change: 500, since: "2026-10-14" });
  });
});

describe("the preview, made safe", () => {
  it("takes out scripts, handlers, frames, forms and script links, and locks the frame down", () => {
    const raw = `<html><head><title>x</title><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil"></head><body onload="steal()"><a href="javascript:alert(1)">x</a><img src="https://cdn.example.com/a.png" onerror=alert(1)><iframe src="https://evil"></iframe><form action="https://evil"><input name=a></form><p>Hi {{ first_name|default:'friend' }}, {% if x %}bye{% endif %}</p><a href="{% unsubscribe %}">Unsubscribe</a></body></html>`;
    const h = sanitizeEmailHtml(raw);
    expect(h).not.toMatch(/<script|onload|onerror|javascript:|<iframe|<form|<input|http-equiv="refresh"|\{%|\{\{/i);
    expect(h).toContain('img-src https: http: data:');
    expect(h).toContain("default-src 'none'");
    expect(h).toContain('<img src="https://cdn.example.com/a.png">');
    expect(h).toContain("Hi there, bye");
    expect(h).toContain('<base target="_blank">');
  });
  it("wraps a fragment in a page", () => {
    expect(sanitizeEmailHtml("<p>Hello</p>")).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"[\s\S]*<body><p>Hello<\/p><\/body><\/html>$/);
  });
  it("reads a campaign's messages for the preview, SMS body included", () => {
    const json = { data: [{ type: "campaign-message", id: "M1", attributes: { definition: { channel: "sms", content: { body: "15% off today: aldeco.ac/x" } } } }] };
    expect(parseCampaignMessages(json)).toEqual([{ id: "M1", channel: "sms", subject: null, previewText: null, body: "15% off today: aldeco.ac/x" }]);
  });
});

describe("what the agents read", () => {
  it("adds key flows, health, share of revenue and the best and weakest campaigns", () => {
    const now = { revenue: 19611, campaignRevenue: 10114, flowRevenue: 9497, sends: 30000, campaignsSent: 7, openRate: 0.38, clickRate: 0.025 };
    const line = emailContextLine({
      account: "Coffee Co",
      currency: "USD",
      now,
      before: { ...now, revenue: 18000 },
      recent: [],
      pulse: { share: 0.245, storeRevenue: 80000, health: [{ tone: "bad", title: "No campaign sent in 14 days", action: "Get a campaign out this week." }, { tone: "good", title: "Deliverability healthy", action: null }], keyFlows: [{ label: "Winback", state: "missing" }, { label: "Welcome series", state: "live" }], top: [{ name: "National Coffee Day", channel: "email", sendTime: "2026-09-29", subject: "15% off", recipients: 5970, openRate: 0.37, clickRate: 0.04, revenue: 4107, conversions: 77 }], bottom: [] },
    });
    expect(line).toContain("25% of the store's revenue ($80,000 Placed Order)");
    expect(line).toContain("Key flows: Winback missing; Welcome series live");
    expect(line).toContain("[red] No campaign sent in 14 days (Get a campaign out this week.)");
    expect(line).toContain("Strengths: Deliverability healthy");
    expect(line).toContain('Best campaigns (90 days, by revenue): 2026-09-29 email "National Coffee Day"');
  });
  it("warns on Sync health when a part of the read failed", () => {
    expect(partialSyncWarning({ seriesError: "Klaviyo answered 400: timeframe too long" })).toMatchObject({ severity: "warn" });
    expect(partialSyncWarning({ storeError: "x" })!.message).toMatch(/Placed Order/);
    expect(partialSyncWarning({})).toBeNull();
  });
});
