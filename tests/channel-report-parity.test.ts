import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { emailMetrics, socialMetrics } from "@/lib/channel-reports/core";
import { channelTitle, emailMessageFlags, socialHappenedBullets } from "@/lib/channel-reports/email-message";
import { columnKeys, defaultTiles, swapChannelTile, tidyChannelLayout, tileKeys, tileOptions, tileView, tileViews } from "@/lib/channel-reports/layout";
import { applyStated, mergeStated, statedFrom } from "@/lib/channel-reports/stated";
import type { Sections } from "@/lib/reports/write";

// Email and social reports at parity with the ads reports: their tiles and table columns are picked like an ads
// report's, the owner's own numbers set in the chat change the PDF, the social message keeps the email team's
// structure, and the document carries the studio's click targets and the Drive copy's notes page.

const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };
const sections: Sections = { headline: "Email earned more", summary: "A good month.", did: ["Sent 8 campaigns"], doing: ["Testing subject lines"], next: ["Black Friday on Nov 27"], highlights: ["Fall sale: $900"], takeaways: [{ title: "Revenue is up", text: "Up 12% on September." }] };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

const email = emailMetrics({
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
const socialDays = range("2026-08-01", "2026-10-31").map((date, i) => ({ platform: "instagram" as const, date, followers: 1000 + i, gained: 5, lost: null, reach: 200, views: 400, profileViews: 10, engaged: 20, interactions: 10 }));
const social = socialMetrics({ kind: "monthly", main, compare, days: socialDays, posts: [], names: { instagram: "@acme" } });

describe("the tiles and columns picked on an email or social report", () => {
  it("starts on what the team's report leads with", () => {
    expect(defaultTiles(email)).toEqual(["revenue", "orders", "rpr", "split", "score"]);
    expect(tileOptions(email)).toContain("aov");
    expect(defaultTiles(social)).toEqual(["followers", "reach", "views", "rate"]);
  });
  it("keeps the picked tiles this report can show, and falls back to the defaults", () => {
    expect(tileKeys(social, { tiles: ["reach", "posts", "nonsense"] })).toEqual(["reach", "posts"]);
    expect(tileKeys(social, { tiles: ["nonsense"] })).toEqual(defaultTiles(social));
    expect(tileKeys(social, null)).toEqual(defaultTiles(social));
  });
  it("swaps a tile, trading places with one already on the page", () => {
    expect(swapChannelTile(["a", "b", "c"], 0, "d")).toEqual(["d", "b", "c"]);
    expect(swapChannelTile(["a", "b", "c"], 0, "c")).toEqual(["c", "b", "a"]);
  });
  it("keeps the table columns in the catalog's order", () => {
    expect(columnKeys("klaviyo", null)).toContain("revenue");
    expect(columnKeys("klaviyo", { columns: ["revenue", "open"] })).toEqual(["open", "revenue"]);
    expect(columnKeys("social", { columns: ["posts", "reach"] })).toEqual(["reach", "posts"]);
  });
  it("tidies a layout to what the line knows", () => {
    expect(tidyChannelLayout("social", { tiles: ["reach", "reach", "revenue"], columns: ["open", "views"] })).toEqual({ tiles: ["reach"], columns: ["views"] });
    expect(tidyChannelLayout("klaviyo", {})).toEqual({});
  });
  it("draws each tile from the report's own numbers", () => {
    expect(tileView(email, "revenue")?.value).toBe("$3,100");
    expect(tileView(email, "orders")?.label).toBe("Orders");
    expect(tileView(social, "reach")?.value).toBe((200 * 31).toLocaleString("en-US"));
    expect(tileView(social, "nonsense")).toBeNull();
    expect(tileViews(social, { tiles: ["posts", "reach"] }).map((t) => t.key)).toEqual(["posts", "reach"]);
  });
});

describe("numbers the owner states in the chat", () => {
  it("takes only the numbers the line knows", () => {
    expect(statedFrom("klaviyo", { revenue: "$12,400", orders: 310, reach: 5, nonsense: 1 })).toEqual({ revenue: 12400, orders: 310 });
    expect(statedFrom("social", { engagement_rate: "4.2%", revenue: 10 })).toEqual({ engagement_rate: 4.2 });
  });
  it("puts them over the synced numbers, and nothing else", () => {
    const at = "2026-11-02T10:00:00Z";
    const e = applyStated(email, { values: { revenue: 12400, orders: 310 }, source: "Klaviyo", by: null, byName: null, at });
    expect(e.now.revenue).toBe(12400);
    expect(e.detail?.orders.now).toBe(310);
    expect(e.now.flowRevenue).toBe(email.now.flowRevenue);
    expect(e.stated?.source).toBe("Klaviyo");
    expect(email.now.revenue).not.toBe(12400);
    const s = applyStated(social, { values: { engagement_rate: 4.2 }, source: "Instagram", by: null, byName: null, at });
    expect(s.now.rate).toBeCloseTo(0.042, 5);
    expect(applyStated(social, null)).toBe(social);
  });
  it("adds up the parts when only the parts were given", () => {
    const e = applyStated(email, { values: { campaign_revenue: 100, flow_revenue: 50 }, source: "Klaviyo", by: null, byName: null, at: "" });
    expect(e.now.revenue).toBe(150);
  });
  it("keeps what was stated before, a later figure winning", () => {
    const a = { values: { revenue: 1, orders: 2 }, source: "Klaviyo", by: null, byName: null, at: "1" };
    const b = { values: { revenue: 5 }, source: "Shopify", by: null, byName: null, at: "2" };
    expect(mergeStated(a, b).values).toEqual({ revenue: 5, orders: 2 });
  });
});

describe("the social report's message", () => {
  it("has its own title and the four bullets", () => {
    expect(channelTitle("Acme", "weekly", { platform: "social", main: { start: "2026-11-09", end: "2026-11-15" } })).toBe("Acme Weekly Social Media Report | November 9 to November 15, 2026");
    expect(channelTitle("Acme", "weekly", { platform: "klaviyo", main: { start: "2026-11-09", end: "2026-11-15" } })).toBe("Acme Weekly Report | November 9 to November 15, 2026");
    expect(socialHappenedBullets(social)).toHaveLength(4);
    expect(socialHappenedBullets(social)[0]).toMatch(/^Followers: /);
  });
  it("is checked for the team's structure, like the email one", () => {
    const title = channelTitle("Acme", "monthly", social);
    const good = `${title}\n\nHi Team,\nHere's how organic social performed.\n*What happened*\nx\n*Highlights*\nx\n*What we learned*\nx\n*Coming up*\nx`;
    expect(emailMessageFlags(good, social, "Acme", "monthly")).toEqual([]);
    expect(emailMessageFlags("Hi Team, the flows did well", social, "Acme", "monthly").some((f) => f.issue.includes("title"))).toBe(true);
    // "flows" is only the email team's word to avoid
    expect(emailMessageFlags(`${good}\nflows`, social, "Acme", "monthly")).toEqual([]);
  });
});

describe("the channel document in the studio and in Drive", () => {
  const draw = (input: Parameters<typeof ChannelDocument>[0]["input"]) => renderToBuffer(createElement(ChannelDocument, { input, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
  it("carries a click target over each tile, column and line in the preview only", async () => {
    const edit = (await draw({ client: "Acme", metrics: social, sections, edit: true, withNotes: true })).toString("latin1");
    expect(edit).toContain("edit.kaizen.invalid/social/tile/0");
    expect(edit).toContain("edit.kaizen.invalid/social/col/0");
    expect(edit).toContain("edit.kaizen.invalid/social/text/did/0");
    const sent = (await draw({ client: "Acme", metrics: social, sections })).toString("latin1");
    expect(sent).not.toContain("edit.kaizen.invalid");
  });
  it("draws the picked tiles and columns, and the notes page on the Drive copy", async () => {
    const plain = await draw({ client: "Acme", metrics: email, sections, layout: { tiles: ["revenue", "aov", "openRate"], columns: ["revenue"] } });
    const notes = await draw({ client: "Acme", metrics: email, sections, layout: { tiles: ["revenue", "aov", "openRate"], columns: ["revenue"] }, withNotes: true, extras: "Shopify shows 40 more orders" });
    expect(plain.subarray(0, 4).toString()).toBe("%PDF");
    expect(notes.length).toBeGreaterThan(plain.length);
  });
});
