import { describe, expect, it } from "vitest";
import { emailMetrics, keyLines, type EmailMetrics } from "@/lib/channel-reports/core";
import { channelBars, emailDetail, rprOf } from "@/lib/channel-reports/email-detail";
import { campaignPicks, shotCampaigns } from "@/lib/channel-reports/email-cards";
import { countsAsRevenue, mirroredOverlap, revenueSources, sourcesText, type SourceSide } from "@/lib/channel-reports/email-sources";
import { tileView } from "@/lib/channel-reports/layout";
import { conversionMetricsOf } from "@/lib/email-metrics";
import type { CampaignLite } from "@/lib/klaviyo/insights";
import type { LocationBreakdown, LocationRow } from "@/lib/klaviyo/locations";
import { firstSource, parseAttributedTotal, sourceCandidates } from "@/lib/klaviyo/sources";

// The head of email's asks for the email report: a section per revenue source for two-order-system clients (Toast and
// a custom POS) with a combined total that never counts an order twice, SMS on the chart, the best and the lowest
// campaign, and revenue per recipient everywhere.

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 – 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – 8" };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const camp = (id: string, at: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: id, channel: "email", sendTime: at, subject: null, recipients: 1000, delivered: 1000, opensUnique: 400, clicksUnique: 10, unsubscribes: 1, bounced: 1, spamComplaints: 0, revenue: 200, conversions: 8, openRate: 0.4, clickRate: 0.01, ...o });

// ─── Revenue sources ───────────────────────────────────────────────────────

const toast = { id: "TOAST", name: "Placed Order", integration: "Toast" };
const pos = { id: "POS", name: "Custom POS Order", integration: "API" };
const side = (id: string, name: string, now: number, before: number, o: Partial<SourceSide> = {}): SourceSide => ({ id, name, revenue: { now, before }, conversions: { now: now / 25, before: before / 25 }, store: { now: now * 5, before: before * 5 }, campaignRevenue: { now: now * 0.6, before: null }, flowRevenue: { now: now * 0.4, before: null }, ...o });
const row = (metricId: string, location: string, messageId: string, conversions: number, revenue: number, date = "2026-11-10"): LocationRow => ({ metricId, date, location, messageId, campaignId: messageId, flowId: null, conversions, revenue });

describe("revenue sources", () => {
  it("keeps the revenue source flag the team sets, and drops anything else", () => {
    const list = conversionMetricsOf([{ ...toast }, { ...pos, revenueSource: true }, { id: "RES", name: "Reservation", integration: null, revenueSource: "yes" }], { id: "TOAST", name: "Placed Order" });
    expect(list.map((m) => m.revenueSource)).toEqual([undefined, true, undefined]);
  });

  it("counts the primary always, a lower metric as set, else once it carries revenue", () => {
    expect(countsAsRevenue({ revenueSource: false }, 0, null)).toBe(true);
    expect(countsAsRevenue({}, 1, { revenue: { now: 0, before: 0 } })).toBe(false);
    expect(countsAsRevenue({}, 1, { revenue: { now: 10, before: null } })).toBe(true);
    expect(countsAsRevenue({ revenueSource: false }, 1, { revenue: { now: 10, before: 5 } })).toBe(false);
    expect(countsAsRevenue({ revenueSource: true }, 1, { revenue: { now: 0, before: 0 } })).toBe(true);
  });

  it("is left out for a single source (a reservations metric with no revenue doesn't make two)", () => {
    const res = { id: "RES", name: "Reservation", integration: null };
    expect(revenueSources({ metrics: [toast, res], sides: [side("TOAST", "Placed Order", 1000, 800), side("RES", "Reservation", 0, 0, { conversions: { now: 0, before: 0 } })] })).toBeNull();
    expect(revenueSources({ metrics: [toast, { ...pos, revenueSource: false }], sides: [side("TOAST", "Placed Order", 1000, 800), side("POS", "Custom POS Order", 500, 300)] })).toBeNull();
  });

  it("shows each source and a combined total that is the plain sum when the systems record different orders", () => {
    const s = revenueSources({ metrics: [toast, pos], sides: [side("TOAST", "Placed Order", 3000, 2500), side("POS", "Custom POS Order", 1000, 500)] })!;
    expect(s.sources.map((x) => [x.name, x.primary, x.revenue.now])).toEqual([
      ["Placed Order", true, 3000],
      ["Custom POS Order", false, 1000],
    ]);
    expect(s.combined.revenue).toEqual({ now: 4000, before: 3000 });
    expect(s.combined.orders).toEqual({ now: 160, before: 120 });
    expect(s.combined.campaignRevenue).toBe(2400);
    expect(s.combined.flowRevenue).toBe(1600);
    expect(s.sources[0].share).toBeCloseTo(0.75);
    expect(s.sources[1].share).toBeCloseTo(0.25);
    // Email's part of each system's own revenue
    expect(s.sources[1].attributedShare).toBeCloseTo(0.2);
    expect(s.note).toContain("Placed Order + Custom POS Order");
    expect(s.note).not.toContain("—");
  });

  it("never counts an order both systems recorded twice", () => {
    const rows = [
      // The same order through Toast and the custom POS (a restaurant mid-move): counted once
      row("TOAST", "Heights", "c1", 2, 60),
      row("POS", "Heights", "c1", 2, 60.3),
      // Different orders at the same place and email: both count
      row("TOAST", "Rayford", "c1", 3, 90),
      row("POS", "Rayford", "c1", 1, 25),
      // Another metric's rows and another period are left alone
      row("OTHER", "Heights", "c1", 2, 60),
      row("POS", "Heights", "c1", 2, 60, "2026-11-01"),
      row("TOAST", "Heights", "c1", 2, 60, "2026-11-01"),
    ];
    const now = mirroredOverlap(rows, ["TOAST", "POS"], main);
    expect(now).toEqual({ revenue: 60, orders: 2 });
    const s = revenueSources({ metrics: [toast, pos], sides: [side("TOAST", "Placed Order", 3000, 2500), side("POS", "Custom POS Order", 1000, 500)], overlap: { now, before: mirroredOverlap(rows, ["TOAST", "POS"], compare) } })!;
    expect(s.combined.revenue.now).toBe(3940);
    expect(s.combined.orders.now).toBe(158);
    expect(s.combined.overlap.revenue).toBe(60);
    // Every source's own number stays whole; only the combined drops the copy
    expect(s.sources.reduce((t, x) => t + (x.revenue.now ?? 0), 0)).toBe(4000);
    expect(s.note).toContain("counted once");
  });

  it("gives each source its own best locations", () => {
    const locations = { version: 1, metrics: [{ metricId: "POS", name: "Custom POS Order", conversions: 10, revenue: 300, columns: [], rows: [], ranked: [{ rank: 1, location: "Crust Pizza Co. - Heights", conversions: 6, revenue: 200 }, { rank: 2, location: "Crust Pizza Co. - Rayford", conversions: 4, revenue: 100 }], summary: "" }], combined: { conversions: 10, revenue: 300 }, campaigns: 1, locations: 2, note: "" } as LocationBreakdown;
    const s = revenueSources({ metrics: [toast, pos], sides: [side("TOAST", "Placed Order", 3000, 2500), side("POS", "Custom POS Order", 1000, 500)], locations })!;
    expect(s.sources[0].locations).toEqual([]);
    expect(s.sources[1].locations.map((l) => l.location)).toEqual(["Crust Pizza Co. - Heights", "Crust Pizza Co. - Rayford"]);
    expect(s.sources[1].locationCount).toBe(2);
    expect(sourcesText(s, (n) => `$${n}`, "week")).toContain("Custom POS Order: $1000 attributed");
  });

  it("finds an order system nobody ranked yet, and reads only the orders credited to email", () => {
    const all = [toast, pos, { id: "OP", name: "Ordered Product", integration: "Toast" }, { id: "CO", name: "Cancelled Order", integration: "Toast" }, { id: "VP", name: "Viewed Product", integration: null }, { id: "SALE", name: "Sale", integration: "Square" }];
    expect(sourceCandidates(all, ["TOAST"]).map((m) => m.id)).toEqual(["POS", "SALE"]);
    const page = { data: { attributes: { dates: ["2026-11-10", "2026-11-11"], data: [{ dimensions: ["msg1"], measurements: { sum_value: [100, 50.5], count: [3, 2] } }, { dimensions: [""], measurements: { sum_value: [9999], count: [99] } }, { dimensions: ["none"], measurements: { sum_value: [1], count: [1] } }] } } };
    expect(parseAttributedTotal([page])).toEqual({ revenue: 150.5, orders: 5 });
  });

  it("finds a club's booked appointments when the account has no Placed Order, and counts the one email earns on as the sale", () => {
    const all = [
      { id: "BOOK", name: "Booked Appointment", integration: "Zenoti" },
      { id: "CANC", name: "Appointment Cancelled", integration: "Zenoti" },
      { id: "REM", name: "Appointment Reminder", integration: "Zenoti" },
      { id: "OPEN", name: "Opened Email", integration: "Klaviyo" },
    ];
    expect(sourceCandidates(all, []).map((m) => m.id)).toEqual(["BOOK"]);
    expect(firstSource([{ id: "BOOK", name: "Booked Appointment", integration: "Zenoti", revenue: 26652.59, orders: 80 }, { id: "SALE", name: "Sale", integration: "Square", revenue: 120, orders: 2 }])).toEqual({ id: "BOOK", name: "Booked Appointment", integration: "Zenoti" });
    expect(firstSource([{ id: "X", name: "Sale", integration: null, revenue: 0, orders: 0 }])).toBeNull();
    expect(firstSource(undefined)).toBeNull();
  });
});

// ─── SMS on the chart ──────────────────────────────────────────────────────

describe("SMS beside email", () => {
  const days = range("2026-11-02", "2026-11-15").map((date) => ({ date, revenue: 300, campaignRevenue: 100, flowRevenue: 200, smsRevenue: date === "2026-11-11" ? 120 : 0, sends: 1000, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: null, unsubscribed: null }));
  const campaigns = [camp("e1", "2026-11-10T15:00:00Z"), camp("s1", "2026-11-11T15:00:00Z", { channel: "sms", recipients: 400, delivered: 400, opensUnique: 0, revenue: 80 })];
  const d = emailDetail({ main, compare, days, campaigns, flowDays: null, flows: [], sizes: [] });

  it("splits each day's bar into email campaigns, automated emails and SMS, adding up to the day", () => {
    const sms = d.daily.find((p) => p.date === "2026-11-11")!;
    expect(sms).toMatchObject({ sms: 120, smsCampaign: 80 });
    const b = channelBars(sms);
    expect(b).toEqual({ campaign: 20, flow: 160, sms: 120 });
    expect(b.campaign + b.flow + b.sms).toBe(sms.campaign + sms.flow);
    // An older report without SMS numbers keeps its two parts
    expect(channelBars({ campaign: 100, flow: 200 })).toEqual({ campaign: 100, flow: 200, sms: 0 });
  });

  it("gives email and SMS revenue and sends for the period and the one before", () => {
    expect(d.channels).toEqual({
      email: { revenue: { now: 1980, before: 2100 }, sends: { now: 6600, before: 7000 }, campaigns: { now: 1, before: 0 } },
      sms: { revenue: { now: 120, before: 0 }, sends: { now: 400, before: 0 }, campaigns: { now: 1, before: 0 } },
    });
  });

  it("has no SMS side for a client that sent no texts", () => {
    const quiet = emailDetail({ main, compare, days: days.map((x) => ({ ...x, smsRevenue: 0 })), campaigns: [campaigns[0]], flowDays: null, flows: [], sizes: [] });
    expect(quiet.channels).toBeNull();
  });

  it("names SMS in the summary when texts earned a real part of the revenue", () => {
    const m = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days: days.map((x) => (x.date === "2026-11-11" ? { ...x, smsRevenue: 900 } : x)), campaigns, flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });
    expect(keyLines(m).some((l) => l.startsWith("SMS: $900.00 from 400 texts"))).toBe(true);
    const small = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days, campaigns, flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });
    expect(keyLines(small).some((l) => l.startsWith("SMS"))).toBe(false);
  });
});

// ─── Best and lowest campaign ──────────────────────────────────────────────

describe("the best and the lowest campaign", () => {
  const rows = [
    { id: "a", name: "Pizza Monday", channel: "email" as const, date: "2026-11-09", recipients: 1000, openRate: 0.4, clickRate: 0.01, orders: 10, revenue: 300 },
    { id: "b", name: "Wings Wednesday", channel: "email" as const, date: "2026-11-11", recipients: 4000, openRate: 0.35, clickRate: 0.02, orders: 12, revenue: 400 },
    { id: "c", name: "Weekend Text", channel: "sms" as const, date: "2026-11-13", recipients: 500, openRate: null, clickRate: 0.03, orders: 0, revenue: 0 },
  ];

  it("picks by revenue per recipient, with a why against the average", () => {
    const p = campaignPicks(rows, { currency: "USD" })!;
    expect(p.basis).toBe("rpr");
    expect(p.best.row.id).toBe("a");
    expect(p.lowest.row.id).toBe("c");
    // $700 over 5,500 recipients
    expect(p.best.why).toContain("$0.30 per recipient");
    expect(p.best.why).toContain("2.4x the $0.13 campaign average");
    expect(p.lowest.why).toContain("No orders from 500 recipients");
    expect(p.best.why + p.lowest.why).not.toContain("—");
  });

  it("falls back to click rate when revenue isn't tracked", () => {
    const p = campaignPicks(rows.map((r) => ({ ...r, revenue: 0, orders: 0 })), { currency: "USD" })!;
    expect(p.basis).toBe("click");
    expect([p.best.row.id, p.lowest.row.id]).toEqual(["c", "a"]);
    expect(campaignPicks(rows, { currency: "USD", revenueMeasured: false })!.basis).toBe("click");
  });

  it("never picks the same campaign twice, and leaves a single campaign as it is", () => {
    const same = [rows[0], { ...rows[0], id: "a2" }];
    const p = campaignPicks(same, { currency: "USD" })!;
    expect(p.best.row.id).not.toBe(p.lowest.row.id);
    expect(campaignPicks([rows[0]], { currency: "USD" })).toBeNull();
    expect(campaignPicks([rows[0], { ...rows[1], recipients: 0 }], { currency: "USD" })).toBeNull();
  });

  it("draws the best and the lowest emails first", () => {
    expect(shotCampaigns(rows, { currency: "USD" }).slice(0, 2).map((r) => r.id)).toEqual(["a", "c"]);
  });
});

// ─── Revenue per recipient ─────────────────────────────────────────────────

describe("revenue per recipient", () => {
  it("is revenue over everyone it went to, as the email score counts it", () => {
    expect(rprOf(150, 1000)).toBeCloseTo(0.15);
    expect(rprOf(10, 0)).toBeNull();
    expect(rprOf(null, 100)).toBeNull();
  });

  const days = range("2026-11-02", "2026-11-15").map((date) => ({ date, revenue: date >= "2026-11-09" ? 300 : 200, campaignRevenue: 100, flowRevenue: 200, smsRevenue: 0, sends: 1000, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: null, unsubscribed: null }));
  const m: EmailMetrics = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days, campaigns: [camp("a", "2026-11-10T15:00:00Z", { revenue: 300 }), camp("old", "2026-11-04T15:00:00Z", { revenue: 100 })], flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });

  it("leads the headline numbers against the period before, as a plain number with no internal bar or grade", () => {
    const t = tileView(m, "rpr")!;
    // $2,100 over 7,000 sends against $1,400 over 7,000
    expect(t.value).toBe("$0.30");
    expect(t.before).toBe("$0.20");
    expect(t.move).toMatchObject({ up: true, pct: "50.0%", tone: "good" });
    expect(t.badge ?? null).toBeNull();
    expect(t.sub ?? "").not.toMatch(/bar|0\.15/i);
  });

  it("is on the campaign and automated email blocks, with the period before", () => {
    expect(m.detail!.campaign.rpr!.now).toBeCloseTo(0.3);
    expect(m.detail!.campaign.rpr!.before).toBeCloseTo(0.1);
  });
});
