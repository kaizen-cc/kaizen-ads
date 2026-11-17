import { describe, expect, it } from "vitest";
import { attributionQuery, brevoErrorText, brevoRange, parseAttribution, parseBrevoAccount, parseBrevoAudiences, parseBrevoCampaignContent, parseBrevoCampaigns } from "@/lib/brevo/core";
import { channelOfType, dailyStats, eventDays, eventValue, flowStatus, isoOfUnix, parseAutomations, parseBroadcasts, parseEventActivities, parseNewsletters, parseSegmentCount, parseSegments, parseSeries, parseWorkspaces, sendId, statsOfSeries } from "@/lib/customerio/core";
import { brevoKeyProblem, chunk, cioBase, customerioKeyProblem, emailClientState, forProvider, plainEmailError, providerHasFlows, providerName, redactSecret, revenueMeasured } from "@/lib/email-providers/core";
import { emailContextLine } from "@/lib/klaviyo/core";

// Brevo and Customer.io as sources for the shared email tables: keys, answers in the shapes their docs show, mapping to
// the shared stats, and what stays unmeasured.

const BREVO_KEY = "xkeysib-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd-AbCdEfGhIjKlMnOp";

describe("provider names and rules", () => {
  it("names the three providers and knows what each can do", () => {
    expect(providerName("brevo")).toBe("Brevo");
    expect(providerName("customerio")).toBe("Customer.io");
    expect(providerName(null)).toBe("Klaviyo");
    expect(providerHasFlows("brevo")).toBe(false);
    expect(providerHasFlows("customerio")).toBe(true);
    expect(forProvider("the Klaviyo account", "Brevo")).toBe("the Brevo account");
    expect(forProvider("the Klaviyo account", "Klaviyo")).toBe("the Klaviyo account");
  });
  it("measures revenue only where a source reports it", () => {
    expect(revenueMeasured("klaviyo", null)).toBe(true);
    expect(revenueMeasured("brevo", { revenue_read: null })).toBe(false);
    expect(revenueMeasured("brevo", { revenue_read: true })).toBe(true);
    expect(revenueMeasured("customerio", { revenue_read: false })).toBe(false);
  });
  it("picks the host by region", () => {
    expect(cioBase("us")).toBe("https://api.customer.io");
    expect(cioBase("eu")).toBe("https://api-eu.customer.io");
  });
});

describe("the keys", () => {
  it("takes a Brevo API key and refuses the SMTP key and fragments", () => {
    expect(brevoKeyProblem(BREVO_KEY)).toBeNull();
    expect(brevoKeyProblem(`api-key: ${BREVO_KEY}`)).toBeNull();
    expect(brevoKeyProblem("")).toMatch(/Paste/);
    expect(brevoKeyProblem("xsmtpsib-0123456789abcdef0123456789")).toMatch(/SMTP/);
    expect(brevoKeyProblem("xkeysib-123")).toMatch(/whole/);
    expect(brevoKeyProblem("0123456789abcdef0123456789abcdef")).toMatch(/starts with xkeysib-/);
  });
  it("takes a Customer.io key and refuses blanks and fragments", () => {
    expect(customerioKeyProblem("0123456789abcdef0123456789abcdef")).toBeNull();
    expect(customerioKeyProblem("Bearer 0123456789abcdef0123456789abcdef")).toBeNull();
    expect(customerioKeyProblem("")).toMatch(/Paste/);
    expect(customerioKeyProblem("short")).toMatch(/whole/);
  });
  it("never lets a key through in a message", () => {
    expect(redactSecret(`failed with ${BREVO_KEY} here`)).not.toContain(BREVO_KEY);
    expect(redactSecret("Authorization: Bearer abcdefghijklmnop1234")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecret("bad key abcdefghijklmnopqrst", "abcdefghijklmnopqrst")).toBe("bad key [redacted]");
  });
});

describe("plain errors and state", () => {
  it("says what a refusal means for each provider", () => {
    expect(plainEmailError("brevo", "Brevo refused this key. Check it", null)?.severity).toBe("bad");
    expect(plainEmailError("customerio", "anything", "invalid")?.message).toMatch(/Customer\.io refused/);
    expect(plainEmailError("brevo", "No ecommerce revenue can be read for this Brevo account yet.")?.severity).toBe("warn");
    expect(plainEmailError("brevo", null)).toBeNull();
  });
  it("is failing, pending, connected or behind from the connection", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(emailClientState("brevo", null).state).toBe("missing");
    expect(emailClientState("brevo", { status: "invalid", lastSyncedAt: null, error: null }, now).state).toBe("failing");
    expect(emailClientState("customerio", { status: "active", lastSyncedAt: null, error: null }, now).state).toBe("pending");
    expect(emailClientState("customerio", { status: "active", lastSyncedAt: "2026-11-17T10:00:00Z", error: null }, now).state).toBe("connected");
    expect(emailClientState("brevo", { status: "active", lastSyncedAt: "2026-11-15T10:00:00Z", error: null }, now).state).toBe("behind");
  });
  it("chunks lists", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("Brevo answers", () => {
  it("reads the account", () => {
    expect(parseBrevoAccount({ organization_id: "5f9a", user_id: 7, companyName: "Gold Rush Cabaret", firstName: "A", lastName: "B", email: "x@y.z" })).toEqual({ id: "5f9a", name: "Gold Rush Cabaret", email: "x@y.z" });
    expect(parseBrevoAccount({})).toBeNull();
  });
  it("maps email campaigns with their global stats to the shared stats", () => {
    const json = {
      count: 2,
      campaigns: [
        { id: 12, name: "Friday show", subject: "Tonight at 9", status: "sent", sentDate: "2026-11-13T20:00:00.000Z", recipients: { lists: [3], segments: [9], exclusionLists: [] }, statistics: { globalStats: { sent: 1000, delivered: 980, hardBounces: 5, softBounces: 15, uniqueViews: 400, viewed: 700, uniqueClicks: 50, clickers: 90, complaints: 2, unsubscriptions: 4 } } },
        { id: 13, name: "Draft", status: "draft", recipients: { lists: [] }, statistics: {} },
      ],
    };
    const [a, b] = parseBrevoCampaigns(json, "email");
    expect(a).toMatchObject({ id: "12", name: "Friday show", subject: "Tonight at 9", status: "Sent", sendTime: "2026-11-13T20:00:00.000Z", audienceIds: ["list-3", "segment-9"] });
    expect(a.stats).toMatchObject({ recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, bounced: 20, spamComplaints: 2, unsubscribes: 4 });
    expect(b.sendTime).toBeNull();
    expect(b.stats).toBeNull();
  });
  it("reads an A/B test's first subject and an SMS campaign without opens", () => {
    const [ab] = parseBrevoCampaigns({ campaigns: [{ id: 1, name: "AB", subjectA: "A one", status: "sent", sentDate: "2026-11-01T10:00:00Z", recipients: { lists: [1] } }] }, "email");
    expect(ab.subject).toBe("A one");
    const [sms] = parseBrevoCampaigns({ campaigns: [{ id: 5, name: "Text", content: "Doors open", status: "sent", sentDate: "2026-11-02T10:00:00Z", recipients: { lists: [1] }, statistics: { sent: 300, delivered: 290, hardBounces: 1, softBounces: 2, unsubscriptions: 3, answered: 4, processing: 0 } }] }, "sms");
    expect(sms.channel).toBe("sms");
    expect(sms.stats).toMatchObject({ recipients: 300, delivered: 290, opensUnique: 0, clicksUnique: 0, bounced: 3, unsubscribes: 3 });
  });
  it("reads lists with their subscriber counts and segments without one", () => {
    const lists = parseBrevoAudiences({ count: 1, lists: [{ id: 3, name: "Newsletter", totalSubscribers: 0, uniqueSubscribers: 5400 }] }, "list");
    expect(lists).toEqual([{ id: "list-3", kind: "list", name: "Newsletter", profileCount: 5400, updated: null }]);
    const segs = parseBrevoAudiences({ segments: [{ id: 9, segmentName: "VIP", categoryName: "c", updatedAt: "2026-11-01T00:00:00Z" }] }, "segment");
    expect(segs[0]).toMatchObject({ id: "segment-9", name: "VIP", profileCount: null });
  });
  it("reads attribution per source and builds the array query", () => {
    const m = parseAttribution({ results: [{ conversionSource: "email_campaign", id: 12, ordersCount: 8, revenue: 640.456, averageBasket: 80 }, { conversionSource: "sms_campaign", id: 12, ordersCount: 1, revenue: 20, averageBasket: 20 }], totals: { ordersCount: 9, revenue: 660.456, averageBasket: 73 } });
    expect(m.get("email_campaign:12")).toEqual({ orders: 8, revenue: 640.46 });
    expect(m.get("sms_campaign:12")).toEqual({ orders: 1, revenue: 20 });
    expect(decodeURIComponent(attributionQuery(["1", "2"], ["7"]))).toBe("emailCampaignId[]=1&emailCampaignId[]=2&smsCampaignId[]=7");
  });
  it("asks for a past range with both dates, never in the future", () => {
    const r = brevoRange("2026-07-01T00:00:00Z", new Date("2026-11-17T12:00:00Z"));
    expect(r.startDate).toBe("2026-07-01T00:00:00.000Z");
    expect(Date.parse(r.endDate)).toBeLessThan(Date.parse("2026-11-17T12:00:00Z"));
  });
  it("reads a campaign's content and error texts", () => {
    expect(parseBrevoCampaignContent({ subject: "S", previewText: "P", htmlContent: "<p>x</p>" })).toEqual({ subject: "S", previewText: "P", html: "<p>x</p>" });
    expect(brevoErrorText(401, {})).toMatch(/refused/);
    expect(brevoErrorText(400, { code: "invalid_parameter", message: "bad dates" })).toMatch(/bad dates/);
  });
});

describe("Customer.io answers", () => {
  it("reads the workspace and the lists of automations, broadcasts and one-time sends", () => {
    expect(parseWorkspaces({ workspaces: [{ id: "13001", name: "Fig", people: 25666 }] })).toEqual({ id: "13001", name: "Fig" });
    const autos = parseAutomations({ campaigns: [{ id: 4, name: "Welcome", active: true, state: "running", first_started: 1760000000 }, { id: 5, name: "Old", active: false, state: "draft" }] });
    expect(autos.map((a) => [a.id, flowStatus(a)])).toEqual([["4", "live"], ["5", "draft"]]);
    expect(autos[0].firstStarted).toBe(isoOfUnix(1760000000));
    expect(parseBroadcasts({ broadcasts: [{ id: 2, name: "Sale", state: "sent", first_started: 1760000000 }] })[0]).toMatchObject({ id: "2", kind: "broadcast" });
    const n = parseNewsletters({ newsletters: [{ id: 8, name: "Nov letter", sent_at: 1761000000, send_state: "sent" }], next: "abc" });
    expect(n.next).toBe("abc");
    expect(sendId(n.rows[0])).toBe("newsletter-8");
    expect(n.rows[0].sentAt).toBe("2025-10-20T22:40:00.000Z");
  });
  it("maps a metrics answer to the shared stats, opens capped at delivered", () => {
    const { series, type } = parseSeries({ metric: { series: { sent: [100, 50], delivered: [90, 50], opened: [60, 60], clicked: [10, 5], converted: [2, 1], bounced: [5, 0], spammed: [1, 0], unsubscribed: [1, 1] }, type: "email" } });
    expect(type).toBe("email");
    expect(statsOfSeries(series)).toMatchObject({ recipients: 150, delivered: 140, opensUnique: 120, clicksUnique: 15, conversions: 3, bounced: 5, spamComplaints: 1, unsubscribes: 2, revenue: 0 });
    expect(statsOfSeries({ sent: [10], delivered: [10], opened: [30] }).opensUnique).toBe(10);
    expect(channelOfType("twilio")).toBe("sms");
    expect(channelOfType(null)).toBe("email");
  });
  it("lays a daily series onto calendar days and sums from a day on", () => {
    const days = dailyStats({ sent: [10, 20, 30], delivered: [10, 20, 30], opened: [1, 2, 3], clicked: [0, 1, 1], converted: [0, 0, 1] }, "2026-11-01");
    expect(days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(days[2].stats.conversions).toBe(1);
  });
  it("reads segments and their counts", () => {
    expect(parseSegments({ segments: [{ id: 1, name: "All" }, { id: 2, name: "VIP" }] })).toEqual([{ id: "1", name: "All" }, { id: "2", name: "VIP" }]);
    expect(parseSegmentCount({ count: 321, segment_id: 1 })).toBe(321);
    expect(parseSegmentCount({})).toBeNull();
  });
  it("reads a purchase event's value and adds it up per day, leaving a possibly cut day out", () => {
    expect(eventValue({ revenue: "42.5" })).toBe(42.5);
    expect(eventValue({ data: { total: 10 } })).toBe(10);
    expect(eventValue({ sku: "x" })).toBeNull();
    const page = parseEventActivities({ activities: [{ id: "a", type: "event", name: "order_completed", timestamp: 1763373600, data: { total: 30 } }, { id: "b", type: "event", name: "order_completed", timestamp: 1763287200, data: { total: 20 } }, { id: "c", type: "event", name: "order_completed", timestamp: 1763287300, data: { total: 5 } }], next: "n" });
    expect(page.events).toHaveLength(3);
    const dayOf = (iso: string) => iso.slice(0, 10);
    const partial = eventDays(page.events, dayOf, false);
    // The oldest day seen may be cut short when more pages exist
    expect(partial.map((d) => d.date)).toEqual(["2025-11-17"]);
    const whole = eventDays(page.events, dayOf, true);
    expect(whole).toEqual([{ date: "2025-11-16", revenue: 25, orders: 2 }, { date: "2025-11-17", revenue: 30, orders: 1 }]);
  });
});

describe("what agents read", () => {
  const w = { revenue: 0, campaignRevenue: 0, flowRevenue: 0, sends: 1200, campaignsSent: 3, openRate: 0.4, clickRate: 0.03 };
  it("names the provider and says revenue is not measured instead of $0", () => {
    const line = emailContextLine({ provider: "Customer.io", revenueMeasured: false, account: "Fig", currency: "USD", now: w, before: null, recent: [{ name: "Nov", channel: "email", sendTime: "2026-11-10T10:00:00Z", subject: "Hi", recipients: 400, openRate: 0.4, clickRate: 0.03, revenue: 0, conversions: 0 }] });
    expect(line).toContain("Customer.io, Fig");
    expect(line).toContain("revenue is not measured");
    expect(line).not.toContain("$0");
  });
});

describe("the score without revenue", () => {
  it("leaves the money checks unmeasured for a source that reports none", async () => {
    const { scoreFromRows } = await import("@/lib/email-score-calc");
    const rows = {
      days: [{ revenue: 0, storeRevenue: null, campaignRecipients: 1000, flowRecipients: 0 }],
      campaigns: [{ channel: "email", recipients: 1000, delivered: 990, bounced: 5, spam: 0, unsubscribes: 2, opens: 400, openRate: 0.4, clickRate: 0.03 }],
      flows: [],
    };
    const withRevenue = scoreFromRows(rows, { from: "2026-10-19", to: "2026-11-17" });
    const without = scoreFromRows({ ...rows, noRevenue: true }, { from: "2026-10-19", to: "2026-11-17" });
    expect(withRevenue.inputs.rpr).toBe(0);
    expect(without.inputs.rpr).toBeNull();
    expect(without.inputs.attributed).toBeNull();
  });
});
