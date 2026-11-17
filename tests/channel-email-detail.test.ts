import { describe, expect, it } from "vitest";
import { emailMetrics, fitFont, shortMoney } from "@/lib/channel-reports/core";
import { emailDetail, grade, RATE_BARS, upcomingItems, type FlowDay } from "@/lib/channel-reports/email-detail";
import { emailMessageFlags, periodWords, reportTitle, wholeMoney, whatHappenedBullets, withTitle } from "@/lib/channel-reports/email-message";
import type { CampaignLite } from "@/lib/klaviyo/insights";

// The email report's detail (what the PDF draws and the writer reads) and the message helpers.

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 – 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – 8" };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const camp = (id: string, at: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: id, channel: "email", sendTime: at, subject: null, recipients: 1000, delivered: 1000, opensUnique: 600, clicksUnique: 5, unsubscribes: 3, bounced: 2, spamComplaints: 0, revenue: 500, conversions: 20, openRate: 0.6, clickRate: 0.005, ...o });
const days = range("2026-11-02", "2026-11-15").map((date) => ({ date, revenue: 300, campaignRevenue: 100, flowRevenue: 200, smsRevenue: 0, sends: 100, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2, conversions: 12 }));
// 12 flows sending every day, flow f0 earning most
const flowDays: FlowDay[] = range("2026-11-02", "2026-11-15").flatMap((date) => Array.from({ length: 12 }, (_, i) => ({ flowId: `f${i}`, date, recipients: 100, delivered: 100, opensUnique: 40, clicksUnique: 2, conversions: 3, revenue: 120 - i * 10 })));
const flows = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `Flow ${i}`, status: "live" }));

describe("the email detail", () => {
  const d = emailDetail({ main, compare, days, campaigns: [camp("a", "2026-11-10T15:00:00Z"), camp("b", "2026-11-11T15:00:00Z", { channel: "sms", opensUnique: 0 }), camp("old", "2026-11-04T15:00:00Z")], flowDays, flows, sizes: [{ date: "2026-11-08", profiles: 5000 }, { date: "2026-11-15", profiles: 5100 }] });

  it("counts orders from the daily rows, against the period before", () => {
    expect(d.orders).toEqual({ now: 84, before: 84 });
  });
  it("has each day of the period split into campaigns and automated emails", () => {
    expect(d.daily).toHaveLength(7);
    expect(d.daily[0]).toEqual({ date: "2026-11-09", campaign: 100, flow: 200 });
  });
  it("lists every campaign sent in the period by date, with orders and order rate", () => {
    expect(d.campaigns.map((c) => c.id)).toEqual(["a", "b"]);
    expect(d.campaigns[0]).toMatchObject({ orders: 20, orderRate: 0.02, openRate: 0.6 });
    expect(d.campaigns[1]).toMatchObject({ channel: "sms", openRate: null });
    expect(d.campaign.sent).toEqual({ now: 2, before: 1 });
    // Opens are email's only; order rate is across both
    expect(d.campaign.open.now).toBeCloseTo(0.6);
    expect(d.campaign.orderRate.now).toBeCloseTo(0.02);
  });
  it("reads flows for the period's own days, best first, the rest added up", () => {
    expect(d.flows).toHaveLength(8);
    expect(d.flows[0]).toMatchObject({ id: "f0", recipients: 700, orders: 21, revenue: 840 });
    expect(d.flowsOther).toMatchObject({ name: "Other flows (4)", count: 4, recipients: 2800 });
    expect(d.flow?.sent.now).toBe(12);
    expect(d.flow?.open.now).toBeCloseTo(0.4);
  });
  it("leaves flows out when their days aren't stored", () => {
    expect(emailDetail({ main, compare, days, campaigns: [], flowDays: null, flows, sizes: [] }).flow).toBeNull();
  });
  it("reads deliverability from campaign email and the list's size at each period's end", () => {
    expect(d.deliverability?.bounce.now).toBeCloseTo(0.002);
    expect(d.deliverability?.score.now).not.toBeNull();
    expect(d.subscribers?.total).toEqual({ now: 5100, before: 5000 });
    expect(d.subscribers?.joined).toEqual({ now: 70, before: 70 });
  });
  it("has no deliverability block and no campaigns in a week with none sent", () => {
    const q = emailDetail({ main, compare, days, campaigns: [camp("old", "2026-11-04T15:00:00Z")], flowDays, flows, sizes: [] });
    expect(q.campaigns).toEqual([]);
    expect(q.deliverability).toBeNull();
    expect(q.campaign.revenue.before).toBe(500);
  });
  it("grades rates against Kaizen's bars", () => {
    expect(RATE_BARS.campaign).toEqual({ open: 0.3, click: 0.01 });
    expect(grade(0.31, 0.3)).toBe("good");
    expect(grade(0.25, 0.3)).toBe("fair");
    expect(grade(0.1, 0.3)).toBe("poor");
    expect(grade(null, 0.3)).toBeNull();
  });
});

describe("coming up", () => {
  it("keeps the next three weeks, by date, each once", () => {
    const got = upcomingItems(
      [
        { date: "2026-11-27", title: "Black Friday", source: "planned" },
        { date: "2026-11-17", title: "Two-Sip Tuesday", source: "klaviyo" },
        { date: "2026-11-27", title: "Black friday", source: "klaviyo" },
        { date: "2026-11-14", title: "Past", source: "klaviyo" },
        { date: "2027-01-10", title: "Far", source: "planned" },
      ],
      "2026-11-15",
    );
    expect(got.map((x) => `${x.date} ${x.source}`)).toEqual(["2026-11-17 klaviyo", "2026-11-27 klaviyo"]);
  });
});

describe("the message", () => {
  const m = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-16", days, campaigns: [camp("a", "2026-11-10T15:00:00Z")], flows: [], keyFlows: [], profiles: null, currency: "USD", account: null, flowDays, sizes: [] });

  it("titles the report the way the team does", () => {
    expect(reportTitle("Candy Cloud", "weekly", main)).toBe("Candy Cloud Weekly Report | November 9 to November 15, 2026");
    expect(reportTitle("Acme", "monthly", { start: "2026-10-01", end: "2026-10-31" })).toBe("Acme Monthly Report | October 1 to October 31, 2026");
    // Dates picked in the report builder: no cadence word
    expect(reportTitle("Acme", "custom", { start: "2026-11-01", end: "2026-11-14" })).toBe("Acme Report | November 1 to November 14, 2026");
    expect(reportTitle("Acme", "custom", { start: "2026-11-01", end: "2026-11-14" }, "Social Media")).toBe("Acme Social Media Report | November 1 to November 14, 2026");
    expect(periodWords({ start: "2026-12-28", end: "2027-01-03" })).toBe("December 28, 2026 to January 3, 2027");
  });
  it("has the four What happened bullets in order", () => {
    expect(whatHappenedBullets(m)).toEqual(["Revenue from email and SMS: $2,100", "Orders: 84", "From automated emails: $1,400", "From campaigns: $700"]);
    expect(wholeMoney(4.5)).toBe("$4.50");
    expect(wholeMoney(28300, "AUD")).toBe("AUD 28,300");
  });
  it("puts the right title first, replacing one the draft wrote", () => {
    const t = reportTitle("Candy Cloud", "weekly", main);
    expect(withTitle("*Candy Cloud Weekly Report | Nov 9*\nHi Team,", t)).toBe(`${t}\n\nHi Team,`);
    expect(withTitle("Hi Team,\nHere's how", t).split("\n")[0]).toBe(t);
  });
  it("flags a message that leaves the structure or uses the team's words", () => {
    const t = reportTitle("Candy Cloud", "weekly", main);
    const good = `<!here> ${t}\n\nHi Team,\nHere's how email performed.\n*What happened*\nx\n*Highlights*\nx\n*What we learned*\nx\n*Coming up*\nx`;
    expect(emailMessageFlags(good, m, "Candy Cloud", "weekly")).toEqual([]);
    const bad = emailMessageFlags(`Hello\n*Highlights*\nOur flows did well — great.\n*What happened*`, m, "Candy Cloud", "weekly").map((f) => f.issue).join(" ");
    expect(bad).toContain("title line");
    expect(bad).toContain("Hi Team");
    expect(bad).toContain('"What we learned" section is missing');
    expect(bad).toContain("out of order");
    expect(bad).toContain('"flows"');
    expect(bad).toContain("em dash");
  });
});

describe("fitting numbers in the PDF", () => {
  it("shrinks long values and keeps short ones at full size", () => {
    expect(fitFont("$1,302", 106, 20)).toBe(20);
    expect(fitFont("AUD 1,234,567", 106, 20)).toBeLessThan(14);
    expect(fitFont("x".repeat(80), 50, 20)).toBe(8);
  });
  it("writes chart money short", () => {
    expect(shortMoney(1900)).toBe("$1.9k");
    expect(shortMoney(28300, "AUD")).toBe("AUD 28k");
    expect(shortMoney(640)).toBe("$640");
    expect(shortMoney(3000)).toBe("$3k");
  });
});
