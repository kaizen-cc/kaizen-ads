import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { emailMetrics, isEngagement, keyLines } from "@/lib/channel-reports/core";
import { emailEngagement, emailTemplateFor, headlineSentence, homeHost, linkLabel, linkView, usualCount, usualRate, usualText, usualWord } from "@/lib/channel-reports/email-engagement";
import { whatHappenedBullets } from "@/lib/channel-reports/email-message";
import { channelMetricsText } from "@/lib/channel-reports/text";
import { newContactsByDay, parseBrevoClickTotals, parseBrevoLinkStats } from "@/lib/brevo/core";
import type { CampaignLite, DailyRow } from "@/lib/klaviyo/insights";
import type { Sections } from "@/lib/reports/write";

// The engagement email report: a client whose revenue can't be read (Brevo with no store, Customer.io with no revenue
// event, Klaviyo with no conversion metric) gets a report built on reach, clicks, what people clicked and the list,
// each against the period before and the account's own usual. Never a revenue number, never a Kaizen grade or bar.

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 – Nov 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – Nov 8" };
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const camp = (id: string, day: string, delivered: number, opens: number, clicks: number, extra: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: `Email ${id}`, subject: `Subject ${id}`, channel: "email", sendTime: `${day}T22:00:00Z`, recipients: delivered + 10, delivered, opensUnique: opens, clicksUnique: clicks, unsubscribes: 3, bounced: 10, spamComplaints: 0, revenue: 0, conversions: 0, openRate: opens / delivered, clickRate: clicks / delivered, ...extra });
// One email a week for the eight weeks before, at 1,000 clicks each; two emails in the report's week
const history = days("2026-09-14", "2026-11-08").filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 3).map((d, i) => camp(`h${i}`, d, 7000, 5000, 1000));
const week = [camp("a", "2026-11-11", 7600, 5600, 600), camp("b", "2026-11-13", 7700, 5700, 560)];
const rows: DailyRow[] = days("2026-09-01", "2026-11-17").map((date) => ({ date, revenue: 0, campaignRevenue: 0, flowRevenue: 0, smsRevenue: 0, sends: 0, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: null, unsubscribed: null, conversions: 0 }));
const links = {
  a: { "https://goldrushcabaret.com/events-calendar/8-year-anniversary-celebration/?utm_source=brevo": 300, "https://www.instagram.com/goldrushcabaret/": 80, "https://goldrushcabaret.com/unsubscribe": 9 },
  b: { "https://speakeasygo.com/event/EVE-Z8K7KE?t=Newsletter": 400, "http://google.com/maps/place/Gold+Rush+Cabaret": 120 },
};
const input = (over: Partial<Parameters<typeof emailMetrics>[0]> = {}) =>
  emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days: rows, campaigns: [...history, ...week], flows: [], keyFlows: [], profiles: 7940, currency: null, account: "Gold Rush", source: "Brevo", revenueMeasured: false, sizes: [{ date: "2026-11-16", profiles: 7940 }], listName: "Engaged", since: "2026-09-01", extras: { a: { clicksTotal: 820, links: links.a }, b: { clicksTotal: 700, links: links.b } }, ...over });

describe("which email report a client gets", () => {
  it("picks the engagement report when revenue can't be read", () => {
    expect(emailTemplateFor({ source: "Brevo", revenueMeasured: false, revenue: 0, orders: 0, sends: 4 })).toBe("engagement");
    expect(emailTemplateFor({ source: "Customer.io", revenueMeasured: false, revenue: 0, orders: 0, sends: 4 })).toBe("engagement");
    expect(emailTemplateFor({ source: "Klaviyo", revenueMeasured: true, hasConversionMetric: false, revenue: 0, orders: 0, sends: 4 })).toBe("engagement");
    // Brevo says it reads revenue, but eight weeks of sends carried none: its store isn't connected
    expect(emailTemplateFor({ source: "Brevo", revenueMeasured: true, revenue: 0, orders: 0, sends: 6 })).toBe("engagement");
  });
  it("keeps the revenue report whenever revenue is readable", () => {
    expect(emailTemplateFor({ source: "Klaviyo", revenueMeasured: true, hasConversionMetric: true, revenue: 0, orders: 0, sends: 4 })).toBe("revenue");
    expect(emailTemplateFor({ source: null, revenueMeasured: true, revenue: 1200, orders: 9, sends: 4 })).toBe("revenue");
    expect(emailTemplateFor({ source: "Brevo", revenueMeasured: true, revenue: 50, orders: 1, sends: 4 })).toBe("revenue");
    expect(emailTemplateFor({ source: "Brevo", revenueMeasured: true, revenue: 0, orders: 0, sends: 0 })).toBe("revenue");
  });
  it("the report's numbers carry the template and no revenue target", () => {
    const m = input();
    expect(m.template).toBe("engagement");
    expect(isEngagement(m)).toBe(true);
    expect(m.revenueMeasured).toBe(false);
    expect(m.target).toBeNull();
    const k = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days: rows, campaigns: week.map((c) => ({ ...c, revenue: 500, conversions: 5 })), flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });
    expect(k.template).toBeUndefined();
    expect(isEngagement(k)).toBe(false);
  });
});

describe("against your usual", () => {
  it("scales the trailing average to the period and words it with a 5% band", () => {
    expect(usualCount(8000, 56, 7)).toBe(1000);
    expect(usualCount(8000, 14, 7)).toBeNull();
    expect(usualRate(100, 1000, 56)).toBeCloseTo(0.1);
    expect(usualWord(1100, 1000)).toEqual({ diff: expect.closeTo(0.1), word: "above" });
    expect(usualWord(1040, 1000)?.word).toBe("in line");
    expect(usualWord(900, 1000)?.word).toBe("below");
    expect(usualWord(5, null)).toBeNull();
    expect(usualText({ word: "below", vsUsual: -0.257 })).toBe("26% below your usual");
    expect(usualText({ word: "in line", vsUsual: 0.01 })).toBe("in line with your usual");
    expect(usualText({ word: "below", vsUsual: -1 })).toBe("below your usual");
  });
  it("judges the week against the eight weeks before it", () => {
    const e = input().engagement!;
    expect(e.history).toEqual({ start: "2026-09-14", end: "2026-11-08", days: 56 });
    // Eight sends of 1,000 people clicking over 56 days: 1,000 a week is the usual; 1,160 clicked this week
    expect(e.clickers.now).toBe(1160);
    expect(e.clickers.usual).toBeCloseTo(1000);
    expect(e.clickers.word).toBe("above");
    expect(e.reached.usual).toBeCloseTo(7000);
    expect(e.reached.word).toBe("above");
    // Click to open is pooled over the history: 8,000 clickers of 40,000 openers
    expect(e.ctor.usual).toBeCloseTo(0.2);
    expect(e.ctor.word).toBe("below");
    expect(headlineSentence(e, "weekly")).toMatch(/2 emails reached 15,300 people/);
  });
  it("quotes no usual without three weeks of history", () => {
    const e = emailEngagement({ kind: "weekly", main, compare, campaigns: week, days: rows, sizes: [], profiles: null, since: "2026-10-30" });
    expect(e.history).toBeNull();
    expect(e.reached.usual).toBeNull();
    expect(usualText(e.reached)).toBeNull();
  });
  it("picks the best and the lowest by click to open, never a test send", () => {
    const e = emailEngagement({ kind: "weekly", main, compare, campaigns: [...week, camp("t", "2026-11-12", 1, 1, 1)], days: rows, sizes: [], profiles: null });
    expect(e.picks?.best.id).toBe("a");
    expect(e.picks?.lowest.id).toBe("b");
    expect(e.campaigns.find((c) => c.id === "t")?.small).toBe(true);
  });
});

describe("what people clicked", () => {
  it("labels links by destination for the owner", () => {
    const home = "goldrushcabaret.com";
    expect(linkLabel("https://speakeasygo.com/event/EVE-Z8K7KE?t=Newsletter", home)).toEqual({ kind: "booking", label: "Guest list & tickets (SpeakEasyGo)" });
    expect(linkLabel("https://goldrushcabaret.com/guest-list", home)).toEqual({ kind: "booking", label: "Guest list" });
    expect(linkLabel("https://goldrushcabaret.com/bottle-service/", home)).toEqual({ kind: "booking", label: "Bottle service" });
    expect(linkLabel("https://goldrushcabaret.com/events-calendar/ufc-334-watch-party-in-miami/", home)).toEqual({ kind: "events", label: "UFC 334 watch party in Miami" });
    expect(linkLabel("https://goldrushcabaret.com/menu", home)?.kind).toBe("menu");
    expect(linkLabel("https://www.instagram.com/goldrushcabaret/", home)).toEqual({ kind: "social", label: "Instagram" });
    expect(linkLabel("http://google.com/maps/place/Gold+Rush", home)).toEqual({ kind: "directions", label: "Directions" });
    expect(linkLabel("https://www.eventbrite.com/e/123", home)?.kind).toBe("tickets");
    expect(linkLabel("https://goldrushcabaret.com/careers", home)?.kind).toBe("jobs");
    expect(linkLabel("tel:+13055551234", home)).toEqual({ kind: "contact", label: "Call" });
    expect(linkLabel("https://goldrushcabaret.com/", home)).toEqual({ kind: "website", label: "Website home page" });
    expect(linkLabel("https://goldrushcabaret.com/#elementor-action%3Aaction%3Dpopup", home)).toEqual({ kind: "website", label: "Website pop-up" });
    expect(linkLabel("https://www.miaminewtimes.com/best-of-miami/2026", home)?.kind).toBe("press");
  });
  it("never counts unsubscribe, preference, web version or placeholder links", () => {
    for (const u of ["https://goldrushcabaret.com/unsubscribe", "https://x.r.sendibt3.com/manage-preferences", "{{ mirror }}", "https://www.example.com", "https://my.brevo.com/view-online"]) expect(linkLabel(u, "goldrushcabaret.com")).toBeNull();
  });
  it("adds up each link across the emails, without its tracking", () => {
    expect(homeHost(Object.keys({ ...links.a, ...links.b }))).toBe("goldrushcabaret.com");
    const v = linkView([{ id: "a", links: { ...links.a, "https://goldrushcabaret.com/events-calendar/8-year-anniversary-celebration/": 20 } }, { id: "b", links: links.b }])!;
    expect(v.total).toBe(920);
    expect(v.rows[0]).toMatchObject({ label: "Guest list & tickets (SpeakEasyGo)", clicks: 400 });
    expect(v.rows.find((r) => r.kind === "events")).toMatchObject({ clicks: 320, campaigns: 1 });
    expect(v.byKind.map((k) => k.kind)).toEqual(["booking", "events", "directions", "social"]);
  });
  it("reads Brevo's link stats, total clicks and new contacts", () => {
    const json = { count: 1, campaigns: [{ id: 22, statistics: { linksStats: { "https://a.com/x": 5, "{{ unsubscribe }}": 3 }, globalStats: { clickers: 831, uniqueClicks: 613 } } }, { id: 23, statistics: { linksStats: { "7": { "https://b.com": 4 } } } }] };
    expect(parseBrevoLinkStats(json).get("22")).toEqual({ "https://a.com/x": 5 });
    expect(parseBrevoLinkStats(json).get("23")).toEqual({ "https://b.com": 4 });
    expect(parseBrevoClickTotals(json).get("22")).toBe(831);
    expect([...newContactsByDay([{ date: "2026-11-16", since: 30 }, { date: "2026-11-17", since: 12 }, { date: "2026-11-18", since: 0 }])]).toEqual([["2026-11-16", 18], ["2026-11-17", 12]]);
  });
});

const sections: Sections = { headline: "", summary: "", did: [], doing: [], next: [], highlights: [], takeaways: [{ title: "Clicks beat your usual", text: "1,520 clicks.", next: "Lead with the guest list." }] };
async function pdfText(m: ReturnType<typeof input>): Promise<{ text: string; pages: number }> {
  const pdf = new Uint8Array(await renderToBuffer(createElement(ChannelDocument, { input: { client: "Gold Rush", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fonts = `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").split(path.sep).join("/")}/`;
  const doc = await pdfjs.getDocument({ data: pdf.slice(), standardFontDataUrl: fonts }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) text += ` ${(await (await doc.getPage(i)).getTextContent()).items.map((x) => ("str" in x ? x.str : "")).join(" ")}`;
  return { text, pages: doc.numPages };
}

const GRADES = /\b(GOOD|FAIR|POOR)\b|\bBar \d|graded|Kaizen's bar|score/;

describe("the engagement report the client reads", () => {
  it("draws reach, clicks and the links, with no revenue, grade or empty section", async () => {
    const m = input();
    const { text, pages } = await pdfText(m);
    expect(pages).toBeLessThanOrEqual(2);
    expect(text).toMatch(/How email performed/);
    expect(text).toMatch(/What people clicked/);
    expect(text).toMatch(/Guest list & tickets \(SpeakEasyGo\)/);
    expect(text).toMatch(/above your usual|below your usual|in line with your usual/i);
    expect(text).toMatch(/What this report can measure/);
    expect(text).toMatch(/N\s?E\s?X\s?T/);
    expect(text).not.toMatch(/Conversion summary|Placed order|Revenue|\$0|Performance at a glance/);
    expect(text).not.toMatch(GRADES);
    expect(text).not.toContain("—");
  }, 60_000);
  it("leaves out what wasn't read (no links, no SMS) instead of drawing it empty", async () => {
    const m = input({ extras: undefined });
    const { text } = await pdfText(m);
    expect(text).not.toMatch(/What people clicked|SMS/);
    expect(text).toMatch(/People who clicked/);
  }, 60_000);
  it("the summary, the writer's numbers and the What happened bullets never quote revenue or a grade", () => {
    const m = input();
    const lines = [...keyLines(m), ...whatHappenedBullets(m)].join("\n");
    expect(lines).toMatch(/People reached: 15,300/);
    // The trailing weeks only stored people who clicked, so clicks are counted that way throughout (never mixed)
    expect(m.engagement!.clicks.basis).toBe("unique");
    expect(lines).toMatch(/Clicks to your (site|website): 1,160/);
    const all = input({ extras: Object.fromEntries([...history, ...week].map((c) => [c.id, { clicksTotal: c.clicksUnique + 100, links: null }])) });
    expect(all.engagement!.clicks).toMatchObject({ basis: "total", now: 1360 });
    expect(lines).not.toMatch(/revenue|orders|\$/i);
    const text = channelMetricsText(m);
    expect(text).toMatch(/usual/);
    expect(text).not.toMatch(/Attributed revenue|Kaizen's bar|graded|\bGOOD\b/);
  });
  it("the revenue report no longer grades opens and clicks against Kaizen's bars", async () => {
    const m = emailMetrics({ kind: "weekly", main, compare, today: "2026-11-17", days: rows.map((d) => ({ ...d, revenue: 50, campaignRevenue: 50, sends: 100 })), campaigns: [...history, ...week].map((c) => ({ ...c, revenue: 400, conversions: 4 })), flows: [], keyFlows: [], profiles: 5000, currency: "USD", account: "Acme" });
    expect(m.template).toBeUndefined();
    const { text } = await pdfText(m);
    expect(text).toMatch(/Campaign performance/);
    expect(text).not.toMatch(GRADES);
    expect(channelMetricsText(m)).not.toMatch(/Kaizen's|against \d+% bar|\bgood\b against|\bfair\b against|\bpoor\b against/i);
  }, 60_000);
});
