import { describe, expect, it } from "vitest";
import { emailDetail, rprOf, type FlowDay } from "@/lib/channel-reports/email-detail";
import { flowCardViews } from "@/lib/channel-reports/email-cards";
import { emptySplit, hasSmsRevenue, splitDay, splitLegend, splitOfDays, splitTotal, SPLIT_HEX, sumSplits } from "@/lib/channel-reports/email-split";
import { audienceLines, audienceSets, parseAudienceIds, parseAudiencesJson, type AudienceLookup } from "@/lib/klaviyo/audiences";
import { parseCampaigns } from "@/lib/klaviyo/core";
import type { CampaignLite } from "@/lib/klaviyo/insights";

// The email report's conversion split (four shades), who each campaign went to, and each flow's revenue per recipient.

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 - 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 - 8" };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const camp = (id: string, at: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: id, channel: "email", sendTime: at, subject: null, recipients: 1000, delivered: 1000, opensUnique: 400, clicksUnique: 10, unsubscribes: 1, bounced: 1, spamComplaints: 0, revenue: 200, conversions: 8, openRate: 0.4, clickRate: 0.01, ...o });
const day = (date: string, o: Record<string, number> = {}) => ({ date, revenue: 300, campaignRevenue: 100, flowRevenue: 200, smsRevenue: 0, sends: 1000, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: null, unsubscribed: null, ...o });

describe("the attribution split", () => {
  it("splits a day four ways and adds up to the day", () => {
    const s = splitDay({ campaign: 100, flow: 200, sms: 120, smsCampaign: 80 });
    expect(s).toEqual({ emailCampaign: 20, emailFlow: 160, smsCampaign: 80, smsFlow: 40 });
    expect(splitTotal(s)).toBe(300);
  });

  it("keeps two parts when no texts went out, and never goes negative or past the day", () => {
    expect(splitDay({ campaign: 100, flow: 200 })).toEqual({ emailCampaign: 100, emailFlow: 200, smsCampaign: 0, smsFlow: 0 });
    // More text revenue than the day earned is held to the day
    const over = splitDay({ campaign: 10, flow: 5, sms: 999, smsCampaign: 50 });
    expect(Object.values(over).every((x) => x >= 0)).toBe(true);
    expect(splitTotal(over)).toBe(15);
    expect(over.smsCampaign).toBe(10);
  });

  it("adds a period up from its days", () => {
    const days = [splitDay({ campaign: 100, flow: 200, sms: 120, smsCampaign: 80 }), splitDay({ campaign: 50, flow: 50 })];
    expect(sumSplits(days)).toEqual({ emailCampaign: 70, emailFlow: 210, smsCampaign: 80, smsFlow: 40 });
    expect(splitOfDays([])).toBeNull();
    expect(sumSplits([])).toEqual(emptySplit());
  });

  it("shows the SMS shades only when texts earned revenue, with shares adding up to the whole", () => {
    const email = splitLegend(splitDay({ campaign: 100, flow: 300 }), null);
    expect(email.sms).toBe(false);
    expect(email.rows.map((r) => r.key)).toEqual(["emailCampaign", "emailFlow"]);
    expect(email.rows.reduce((t, r) => t + (r.share ?? 0), 0)).toBeCloseTo(1, 6);
    const both = splitLegend(splitDay({ campaign: 100, flow: 300, sms: 100, smsCampaign: 60 }), splitDay({ campaign: 50, flow: 50 }));
    expect(both.sms).toBe(true);
    expect(both.rows.map((r) => r.key)).toEqual(["emailCampaign", "emailFlow", "smsCampaign", "smsFlow"]);
    expect(both.total).toBe(400);
    expect(both.totalBefore).toBe(100);
    expect(both.rows.reduce((t, r) => t + (r.share ?? 0), 0)).toBeCloseTo(1, 6);
    expect(hasSmsRevenue(splitDay({ campaign: 5, flow: 5 }))).toBe(false);
  });

  it("uses darker blue for email campaigns, lighter blue for automations, and the same for the oranges", () => {
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    const hue = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return { r: (n >> 16) & 255, b: n & 255 };
    };
    expect(lum(SPLIT_HEX.emailCampaign)).toBeLessThan(lum(SPLIT_HEX.emailFlow));
    expect(lum(SPLIT_HEX.smsCampaign)).toBeLessThan(lum(SPLIT_HEX.smsFlow));
    expect(hue(SPLIT_HEX.emailCampaign).b).toBeGreaterThan(hue(SPLIT_HEX.emailCampaign).r);
    expect(hue(SPLIT_HEX.emailFlow).b).toBeGreaterThan(hue(SPLIT_HEX.emailFlow).r);
    expect(hue(SPLIT_HEX.smsCampaign).r).toBeGreaterThan(hue(SPLIT_HEX.smsCampaign).b);
    expect(hue(SPLIT_HEX.smsFlow).r).toBeGreaterThan(hue(SPLIT_HEX.smsFlow).b);
  });

  it("is on the detail for the period and the one before, matching the daily bars", () => {
    const days = range("2026-11-02", "2026-11-15").map((date) => day(date, { smsRevenue: date === "2026-11-11" ? 120 : 0 }));
    const d = emailDetail({ main, compare, days, campaigns: [camp("e1", "2026-11-10T15:00:00Z"), camp("s1", "2026-11-11T15:00:00Z", { channel: "sms", recipients: 400, delivered: 400, revenue: 80 })], flowDays: null, flows: [], sizes: [] });
    expect(d.split!.now).toEqual({ emailCampaign: 620, emailFlow: 1360, smsCampaign: 80, smsFlow: 40 });
    expect(splitTotal(d.split!.now)).toBe(d.daily.reduce((t, p) => t + p.campaign + p.flow, 0));
    expect(d.split!.before).toEqual({ emailCampaign: 700, emailFlow: 1400, smsCampaign: 0, smsFlow: 0 });
  });
});

describe("who a campaign was sent to", () => {
  const lookup: AudienceLookup = new Map([
    ["L1", { name: "Newsletter", type: "list" }],
    ["S1", { name: "VIP buyers", type: "segment" }],
    ["S2", { name: "Recent purchasers", type: "segment" }],
  ]);

  it("reads included and excluded ids from a Klaviyo campaign", () => {
    expect(parseAudienceIds({ included: ["L1", "S1", "L1"], excluded: ["S2"] })).toEqual({ included: ["L1", "S1"], excluded: ["S2"] });
    expect(parseAudienceIds(undefined)).toEqual({ included: [], excluded: [] });
    const json = { data: [{ id: "C1", attributes: { name: "Black Friday", audiences: { included: ["L1"], excluded: ["S2"] } } }] };
    expect(parseCampaigns(json, "email")[0]).toMatchObject({ audienceIds: ["L1"], excludedIds: ["S2"] });
  });

  it("stores exactly { included, excluded } of { id, name, type } and never guesses a name", () => {
    const a = audienceSets({ included: ["L1", "S1", "GONE"], excluded: ["S2"] }, lookup);
    expect(a).toEqual({ included: [{ id: "L1", name: "Newsletter", type: "list" }, { id: "S1", name: "VIP buyers", type: "segment" }], excluded: [{ id: "S2", name: "Recent purchasers", type: "segment" }] });
    expect(Object.keys(a).sort()).toEqual(["excluded", "included"]);
  });

  it("reads a stored value back, and nothing from a malformed or empty one", () => {
    const a = audienceSets({ included: ["L1"], excluded: [] }, lookup);
    expect(parseAudiencesJson(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseAudiencesJson(null)).toBeNull();
    expect(parseAudiencesJson({ included: [{ id: 5 }], excluded: "x" })).toBeNull();
    expect(parseAudiencesJson({ included: [], excluded: [] })).toBeNull();
  });

  it("writes short lines, a few names then a count", () => {
    const a = audienceSets({ included: ["L1", "S1", "S2"], excluded: ["S2"] }, lookup);
    expect(audienceLines(a)).toEqual({ sent: "Newsletter, VIP buyers, Recent purchasers", excluded: "Recent purchasers" });
    expect(audienceLines(a, 2).sent).toBe("Newsletter, VIP buyers +1 more");
    expect(audienceLines(null)).toEqual({ sent: null, excluded: null });
  });

  it("reaches each campaign row of the report, and an SMS row carries its text", () => {
    const days = range("2026-11-02", "2026-11-15").map((date) => day(date));
    const audiences = { e1: audienceSets({ included: ["L1"], excluded: ["S2"] }, lookup) };
    const d = emailDetail({ main, compare, days, campaigns: [camp("e1", "2026-11-10T15:00:00Z"), camp("s1", "2026-11-11T15:00:00Z", { channel: "sms" })], flowDays: null, flows: [], sizes: [], audiences, smsBodies: { s1: "Flash sale today", e1: "ignored on an email" } });
    const e1 = d.campaigns.find((c) => c.id === "e1")!;
    const s1 = d.campaigns.find((c) => c.id === "s1")!;
    expect(e1.audiences?.included[0].name).toBe("Newsletter");
    expect(e1.smsBody).toBeUndefined();
    expect(s1.smsBody).toBe("Flash sale today");
    expect(s1.audiences).toBeUndefined();
  });
});

describe("flow revenue per recipient", () => {
  const days = range("2026-11-02", "2026-11-15").map((date) => day(date));
  const flowDays: FlowDay[] = range("2026-11-02", "2026-11-15").flatMap((date) => [
    { flowId: "welcome", date, recipients: 100, delivered: 100, opensUnique: 50, clicksUnique: 5, conversions: 4, revenue: date >= "2026-11-09" ? 300 : 150 },
    { flowId: "cart", date, recipients: 50, delivered: 50, opensUnique: 20, clicksUnique: 2, conversions: 1, revenue: 25 },
    // Only sent this period: no number to compare with
    ...(date >= "2026-11-09" ? [{ flowId: "winback", date, recipients: 10, delivered: 10, opensUnique: 3, clicksUnique: 1, conversions: 0, revenue: 0 }] : []),
  ]);
  const flows = [{ id: "welcome", name: "Welcome", status: "live" }, { id: "cart", name: "Cart", status: "live" }, { id: "winback", name: "Winback", status: "live" }];
  const d = emailDetail({ main, compare, days, campaigns: [], flowDays, flows, sizes: [] });

  it("is revenue over recipients on each flow row, with the period before", () => {
    const welcome = d.flows.find((f) => f.id === "welcome")!;
    expect(welcome.rpr).toBeCloseTo(3, 6);
    expect(welcome.rpr).toBe(rprOf(welcome.revenue, welcome.recipients));
    expect(welcome.prevRevenue).toBe(1050);
    expect(welcome.prevRpr).toBeCloseTo(1.5, 6);
    const win = d.flows.find((f) => f.id === "winback")!;
    expect(win.rpr).toBe(0);
    expect(win.prevRevenue).toBeNull();
    expect(win.prevRpr).toBeNull();
  });

  it("has none when nobody received it", () => {
    expect(rprOf(100, 0)).toBeNull();
    expect(rprOf(null, 10)).toBeNull();
  });

  it("builds the cards best first with each one's share of the flow revenue, the top one marked", () => {
    const v = flowCardViews(d.flows, d.flowsOther);
    expect(v.cards.map((c) => c.row.id)).toEqual(["welcome", "cart", "winback"]);
    expect(v.cards[0].top).toBe(true);
    expect(v.cards.slice(1).some((c) => c.top)).toBe(false);
    expect(v.cards.reduce((t, c) => t + (c.share ?? 0), 0)).toBeCloseTo(1, 6);
    expect(v.cards[0].rpr).toBeCloseTo(3, 6);
    expect(v.other).toBeNull();
  });

  it("counts the rest added up in each share, and marks no top flow when none earned", () => {
    const rows = [1, 2, 3].map((i) => ({ id: `f${i}`, name: `F${i}`, date: null, channel: "email" as const, status: null, recipients: 10, delivered: 10, openRate: null, clickRate: null, orders: 0, orderRate: null, revenue: i === 1 ? 60 : 0 }));
    const other = { ...rows[2], id: "other", name: "Other flows (2)", revenue: 40 };
    const v = flowCardViews([rows[0]], other);
    expect(v.total).toBe(100);
    expect(v.cards[0].share).toBeCloseTo(0.6, 6);
    expect(v.other?.share).toBeCloseTo(0.4, 6);
    expect(flowCardViews([rows[1], rows[2]], null).cards.some((c) => c.top)).toBe(false);
  });
});
