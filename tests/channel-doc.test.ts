import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { emailMetrics, socialMetrics } from "@/lib/channel-reports/core";
import type { Sections } from "@/lib/reports/write";

// The channel report's PDF draws, for email and for social, with and without pictures and with a white label client.

const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };
const sections: Sections = { headline: "Email earned more", summary: "A good month.", did: ["Sent 8 campaigns"], doing: [], next: [], highlights: [], takeaways: [{ title: "Revenue is up", text: "Up 12% on September." }] };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

describe("the channel PDF", () => {
  it("draws an email report", async () => {
    const m = emailMetrics({
      kind: "monthly",
      main,
      compare,
      today: "2026-11-02",
      days: range("2026-08-01", "2026-10-31").map((date) => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2 })),
      campaigns: [{ id: "a", name: "Fall sale", channel: "email", sendTime: "2026-10-10T15:00:00Z", subject: "Last chance", recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, unsubscribes: 2, bounced: 5, spamComplaints: 0, revenue: 900, conversions: 10, openRate: 0.4, clickRate: 0.05 }],
      flows: [{ id: "f", name: "Welcome", status: "live", trigger: null, revenue30: 3000, revenue90: 8000, recipients30: 900, recipients90: 2500, openRate30: 0.5, clickRate30: 0.08, openRate90: null, clickRate90: null }],
      keyFlows: [],
      profiles: 5000,
      currency: "USD",
      account: "Acme",
    });
    const buf = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    const wl = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections, whiteLabel: true }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(wl.length).toBeGreaterThan(1000);
  });

  it("draws an email report with two revenue sources, several campaigns and SMS", async () => {
    const camp = (id: string, day: string, recipients: number, revenue: number, channel = "email") => ({ id, name: `${id} campaign`, channel, sendTime: `${day}T15:00:00Z`, subject: null, recipients, delivered: recipients, opensUnique: channel === "sms" ? 0 : recipients * 0.4, clicksUnique: recipients * 0.02, unsubscribes: 1, bounced: 1, spamComplaints: 0, revenue, conversions: revenue / 30, openRate: 0.4, clickRate: 0.02 });
    const m = emailMetrics({
      kind: "monthly",
      main,
      compare,
      today: "2026-11-02",
      days: range("2026-08-01", "2026-10-31").map((date) => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: date.endsWith("5") ? 30 : 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2 })),
      campaigns: [camp("a", "2026-10-05", 1000, 900), camp("b", "2026-10-12", 3000, 300), camp("c", "2026-10-15", 400, 120, "sms"), camp("d", "2026-10-20", 2000, 0)],
      flows: [],
      keyFlows: [],
      profiles: 5000,
      currency: "USD",
      account: null,
    });
    m.sources = {
      version: 1,
      sources: [
        { id: "T", name: "Placed Order", primary: true, revenue: { now: 3100, before: 2800 }, orders: { now: 120, before: 110 }, campaignRevenue: 1860, flowRevenue: 1240, store: 40000, attributedShare: 0.0775, share: 0.7, locations: [{ location: "Crust Pizza Co. - Heights", revenue: 900, conversions: 30 }], locationCount: 12 },
        { id: "P", name: "Custom POS Order", primary: false, revenue: { now: 1300, before: 900 }, orders: { now: 50, before: 30 }, campaignRevenue: 800, flowRevenue: 500, store: null, attributedShare: null, share: 0.3, locations: [], locationCount: 0 },
      ],
      combined: { revenue: { now: 4340, before: 3700 }, orders: { now: 168, before: 140 }, campaignRevenue: 2660, flowRevenue: 1740, overlap: { revenue: 60, orders: 2 } },
      note: "Combined = Placed Order + Custom POS Order. Each order is counted once.",
    };
    const buf = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(buf.length).toBeGreaterThan(5000);
    if (process.env.REPORT_SAMPLE_OUT) (await import("node:fs")).writeFileSync(process.env.REPORT_SAMPLE_OUT, buf);
  });

  it("draws a social report", async () => {
    const days = range("2026-08-01", "2026-10-31").map((date, i) => ({ platform: "instagram" as const, date, followers: 1000 + i, gained: 5, lost: null, reach: 200, views: 400, profileViews: 10, engaged: 20, interactions: 10 }));
    const posts = [{ id: "1", platform: "instagram" as const, format: "reel" as const, caption: "A reel", permalink: "https://ig/1", thumbnail: null, postedAt: "2026-10-04T14:00:00Z", likes: 50, comments: 5, shares: 3, saves: 8, reach: 1000, views: 3000, interactions: 100, insightsOk: true }];
    const m = socialMetrics({ kind: "monthly", main, compare, days, posts, names: { instagram: "@acme" } });
    const buf = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
