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

  it("draws a social report", async () => {
    const days = range("2026-08-01", "2026-10-31").map((date, i) => ({ platform: "instagram" as const, date, followers: 1000 + i, gained: 5, lost: null, reach: 200, views: 400, profileViews: 10, engaged: 20, interactions: 10 }));
    const posts = [{ id: "1", platform: "instagram" as const, format: "reel" as const, caption: "A reel", permalink: "https://ig/1", thumbnail: null, postedAt: "2026-10-04T14:00:00Z", likes: 50, comments: 5, shares: 3, saves: 8, reach: 1000, views: 3000, interactions: 100, insightsOk: true }];
    const m = socialMetrics({ kind: "monthly", main, compare, days, posts, names: { instagram: "@acme" } });
    const buf = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
