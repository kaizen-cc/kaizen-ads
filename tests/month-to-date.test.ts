import path from "node:path";
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { ReportDocument } from "@/lib/reports/report-doc";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { adsMtd, adsMtdText, monthPace, monthProgress, paceMatters, paceStatus, projectMonthEnd } from "@/lib/reports/mtd-core";
import { metricsText, periodsFor, type Period, type ReportMetrics } from "@/lib/reports/metrics";
import { monthSoFar } from "@/lib/reports/period";
import { emailMetrics, socialMetrics, dataFlags } from "@/lib/channel-reports/core";
import { channelMtdText, emailMtdView, socialMtdView } from "@/lib/channel-reports/mtd";
import { emailText, socialText } from "@/lib/channel-reports/text";
import type { CampaignLite, DailyRow as EmailDay } from "@/lib/klaviyo/insights";
import type { DailyRow as SocialDay } from "@/lib/social/insights";

const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

describe("month progress and projection", () => {
  it("counts the report's last day whole", () => {
    const p = monthProgress("2026-11-15");
    expect(p).toMatchObject({ elapsed: 15, daysInMonth: 30 });
    expect(p.pctElapsed).toBe(50);
    expect(p.early).toBe(false);
  });
  it("knows a short and a leap month", () => {
    expect(monthProgress("2026-02-10").daysInMonth).toBe(28);
    expect(monthProgress("2028-02-10").daysInMonth).toBe(29);
  });
  it("projects at the daily rate so far", () => {
    expect(projectMonthEnd(1500, "2026-11-15")).toBe(3000);
    expect(projectMonthEnd(0, "2026-11-15")).toBe(0);
  });
  it("the first days are early", () => {
    expect(monthProgress("2026-11-02").early).toBe(true);
    expect(monthProgress("2026-11-03").early).toBe(true);
    expect(monthProgress("2026-11-04").early).toBe(false);
  });
});

describe("pace status", () => {
  it("is on pace within 10% of the monthly amount", () => {
    expect(paceStatus(3000, 3000, "2026-11-15")).toBe("on");
    expect(paceStatus(3250, 3000, "2026-11-15")).toBe("on");
    expect(paceStatus(2750, 3000, "2026-11-15")).toBe("on");
  });
  it("calls over and under past the tolerance", () => {
    expect(paceStatus(3400, 3000, "2026-11-15")).toBe("over");
    expect(paceStatus(2500, 3000, "2026-11-15")).toBe("under");
  });
  it("never calls it in the first days, and has no status without a budget", () => {
    expect(paceStatus(9000, 3000, "2026-11-02")).toBe("early");
    expect(paceStatus(9000, null, "2026-11-15")).toBe("none");
    expect(paceStatus(9000, 0, "2026-11-15")).toBe("none");
  });
});

describe("monthPace (ad spend against the monthly budget)", () => {
  it("reads percent used, percent of month, projection and status", () => {
    const p = monthPace({ spend: 1800, budget: 3000, end: "2026-11-15" });
    expect(p.pctUsed).toBe(60);
    expect(p.pctElapsed).toBe(50);
    expect(p.projected).toBe(3600);
    expect(p.projectedPct).toBe(120);
    expect(p.status).toBe("over");
    expect(p.label).toBe("Over pace");
    expect(p.note).toContain("20% over budget");
    expect(paceMatters(p)).toBe(true);
    expect(p.dailyLeft).toBe(80);
  });
  it("under pace", () => {
    const p = monthPace({ spend: 1000, budget: 3000, end: "2026-11-15" });
    expect(p.status).toBe("under");
    expect(p.note).toContain("under budget");
    expect(paceMatters(p)).toBe(true);
  });
  it("on pace is not worth a sentence", () => {
    const p = monthPace({ spend: 1500, budget: 3000, end: "2026-11-15" });
    expect(p.status).toBe("on");
    expect(paceMatters(p)).toBe(false);
  });
  it("with no budget it still shows spend and a projection, and says so", () => {
    const p = monthPace({ spend: 1500, budget: null, end: "2026-11-15" });
    expect(p.status).toBe("none");
    expect(p.pctUsed).toBeNull();
    expect(p.projected).toBe(3000);
    expect(p.label).toBe("No monthly budget set");
    expect(p.note).toContain("No monthly budget set");
    expect(paceMatters(p)).toBe(false);
  });
  it("early in the month it shows the numbers with a note and calls nothing", () => {
    const p = monthPace({ spend: 400, budget: 3000, end: "2026-11-02" });
    expect(p.early).toBe(true);
    expect(p.status).toBe("early");
    expect(p.projected).toBe(6000);
    expect(p.note).toContain("Early in the month (day 2 of 30)");
    expect(paceMatters(p)).toBe(false);
  });
});

describe("monthSoFar", () => {
  it("is the 1st through the end against the same days last month", () => {
    const m = monthSoFar("2026-11-15");
    expect(m.mtd).toMatchObject({ start: "2026-11-01", end: "2026-11-15", label: "November 1 – Nov 15" });
    expect(m.mtdCompare).toMatchObject({ start: "2026-10-01", end: "2026-10-15" });
  });
  it("caps the comparison at the shorter month", () => {
    expect(monthSoFar("2026-03-31").mtdCompare).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
  });
  it("a report ending on the 2nd still has one", () => {
    expect(monthSoFar("2026-11-02").mtd).toMatchObject({ start: "2026-11-01", end: "2026-11-02" });
  });
  it("is what an ad weekly carries", () => {
    const p = periodsFor("weekly", "2026-11-17", { start: "2026-11-09", end: "2026-11-15" });
    expect(p.mtd).toMatchObject({ start: "2026-11-01", end: "2026-11-15" });
    expect(periodsFor("monthly", "2026-11-17").mtd).toBeNull();
  });
});

const period = (o: Partial<Period>): Period => ({ label: "Nov 1 – Nov 15", start: "2026-11-01", end: "2026-11-15", days: 15, spend: 1800, impressions: 90000, clicks: 1200, ctr: 1.3, cpc: 1.5, cpm: 20, results: 30, costPerResult: 60, revenue: 0, roas: null, ...o });
const ads = (o: Partial<ReportMetrics> = {}): ReportMetrics => ({
  platform: "meta",
  kind: "weekly",
  conversion: "Leads",
  roasKpi: false,
  target: 70,
  monthlyBudget: 3000,
  main: period({ label: "Nov 9 – Nov 15", start: "2026-11-09", end: "2026-11-15", spend: 700, results: 12, costPerResult: 58.33 }),
  compare: period({ label: "Nov 2 – Nov 8", start: "2026-11-02", end: "2026-11-08", spend: 650 }),
  mtd: period({}),
  mtdCompare: period({ label: "October 1 – Oct 15", start: "2026-10-01", end: "2026-10-15", spend: 1400, results: 20, costPerResult: 70 }),
  campaigns: [],
  topAds: [],
  dataThrough: "2026-11-15",
  gaps: [],
  ...o,
});

describe("ad month to date", () => {
  it("judges cost per result against the KPI target", () => {
    expect(adsMtd(ads())?.vsTarget).toBe("on"); // $60 against a $70 target
    expect(adsMtd(ads({ target: 50 }))?.vsTarget).toBe("off"); // 60 is 17% over 50
    expect(adsMtd(ads({ target: 55 }))?.vsTarget).toBe("close");
    expect(adsMtd(ads({ target: null }))?.vsTarget).toBeNull();
  });
  it("judges a ROAS KPI on ROAS", () => {
    const x = adsMtd(ads({ roasKpi: true, target: 3, mtd: period({ revenue: 7200, roas: 4 }), mtdCompare: period({ revenue: 4200, roas: 3, spend: 1400 }) }));
    expect(x?.basis).toBe("roas");
    expect(x?.roas).toBe(4);
    expect(x?.vsTarget).toBe("on");
  });
  it("shows Google ROAS only when the conversion value is real", () => {
    const real = adsMtd(ads({ platform: "google", mtd: period({ results: 30, revenue: 9000 }) }));
    expect(real?.roas).toBe(5);
    const fake = adsMtd(ads({ platform: "google", mtd: period({ results: 30, revenue: 30 }) }));
    expect(fake?.roas).toBeNull();
  });
  it("a monthly or custom report has none", () => {
    expect(adsMtd(ads({ mtd: null, mtdCompare: null }))).toBeNull();
    expect(adsMtdText(ads({ mtd: null, mtdCompare: null }))).toEqual([]);
  });
  it("the weekly's text carries the month to date, the pace and the same days last month", () => {
    const text = metricsText(ads());
    expect(text).toContain("Month to date (Nov 1 – Nov 15)");
    expect(text).toContain("$1,800 of the $3,000 monthly budget (60%) with 50% of the month gone");
    expect(text).toContain("On track for $3,600, about 20% over budget");
    expect(text).toContain("Month to date results: 30 leads at $60.00 each ($70.00 target: on target)");
    expect(text).toContain("Same days last month (October 1 – Oct 15): $1,400.00 spent, 20 leads at $70.00 each");
    expect(text).toContain("Pacing is over pace");
  });
  it("with no budget the text says so and asks for one", () => {
    const text = metricsText(ads({ monthlyBudget: null }));
    expect(text).toContain("No monthly budget set. $1,800 spent so far, $3,600 by month end");
    expect(text).toContain("suggest setting one");
  });
  it("early in the month the text carries the note", () => {
    const text = metricsText(ads({ mtd: period({ end: "2026-11-02", label: "November 1 – Nov 2", spend: 400 }) }));
    expect(text).toContain("Early in the month (day 2 of 30)");
    expect(text).not.toContain("Pacing is");
  });
  it("a monthly report's text has no month to date", () => {
    expect(metricsText(ads({ kind: "monthly", mtd: null, mtdCompare: null }))).not.toContain("Month to date");
  });
});

// ─── Channels ──────────────────────────────────────────────────────────────

const eday = (date: string, o: Partial<EmailDay> = {}): EmailDay => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2, ...o });
const camp = (id: string, sendTime: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: `Campaign ${id}`, channel: "email", sendTime, subject: `Subject ${id}`, recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, unsubscribes: 2, bounced: 5, spamComplaints: 0, revenue: 500, conversions: 10, openRate: 0.4, clickRate: 0.05, ...o });

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 – Nov 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – Nov 8" };
const emailDays = range("2026-09-01", "2026-11-16").map((d) => eday(d, { revenue: d >= "2026-11-01" ? 200 : 100 }));
const email = (kind: "weekly" | "monthly" = "weekly") => emailMetrics({ kind, main, compare, today: "2026-11-16", days: emailDays, campaigns: [camp("a", "2026-11-10T15:00:00Z")], flows: [], keyFlows: [], profiles: 5000, currency: "USD", account: "Acme" });

describe("email month to date", () => {
  it("a weekly has it, a monthly does not", () => {
    expect(email("weekly").mtd).toBeTruthy();
    expect(email("monthly").mtd).toBeUndefined();
  });
  it("counts the 1st through the report's last day against the same days last month", () => {
    const x = email().mtd!;
    expect(x.window).toMatchObject({ start: "2026-11-01", end: "2026-11-15" });
    expect(x.compare).toMatchObject({ start: "2026-10-01", end: "2026-10-15" });
    expect(x.now.revenue).toBe(200 * 15);
    expect(x.before.revenue).toBe(100 * 15);
    expect(x.projectedRevenue).toBe(6000);
  });
  it("paces against the monthly target and flags a shortfall", () => {
    const m = email();
    m.mtd!.target = { metric: "revenue", label: "Attributed revenue", unit: "money", target: 8000, actual: 3000, progress: 0.375, basis: "monthly target" };
    const v = emailMtdView(m)!;
    expect(v.status).toBe("under");
    expect(v.pace?.pctDone).toBe(37.5);
    expect(v.rows.map((r) => r.label)).toContain("Open rate");
    expect(dataFlags(m).some((f) => /pacing behind/.test(f.issue))).toBe(true);
  });
  it("with no target it shows revenue and a projection and asks for one", () => {
    const m = email();
    const v = emailMtdView(m)!;
    expect(v.status).toBe("none");
    expect(v.pace).toBeNull();
    expect(v.projected?.value).toBe("$6,000");
    expect(v.note).toContain("No monthly target set");
    expect(dataFlags(m).some((f) => /No monthly revenue target/.test(f.issue))).toBe(true);
  });
  it("is early on the 2nd", () => {
    const m = emailMetrics({ kind: "weekly", main: { start: "2026-10-27", end: "2026-11-02", label: "Oct 27 – Nov 2" }, compare: { start: "2026-10-20", end: "2026-10-26", label: "Oct 20 – Oct 26" }, today: "2026-11-03", days: emailDays, campaigns: [], flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });
    expect(m.mtd?.early).toBe(true);
    expect(emailMtdView(m)?.note).toContain("Early in the month (day 2 of 30)");
  });
  it("the weekly's text includes it, the monthly's does not", () => {
    expect(emailText(email())).toContain("Month to date (November 1 – Nov 15, day 15 of 30): Attributed revenue $3,000");
    expect(emailText(email())).toContain("against the same days last month (October 1 – Oct 15)");
    expect(emailText(email("monthly"))).not.toContain("Month to date");
    expect(channelMtdText(email("monthly"))).toEqual([]);
  });
});

const sday = (date: string, platform: "instagram" = "instagram", o: Partial<SocialDay> = {}): SocialDay => ({ platform, date, followers: 1000, gained: 3, lost: 1, reach: 100, views: 200, profileViews: 10, engaged: 5, interactions: 8, ...o });

describe("social month to date", () => {
  const days = range("2026-09-01", "2026-11-16").map((d) => sday(d, "instagram", { reach: d >= "2026-11-01" ? 200 : 100 }));
  const social = (kind: "weekly" | "monthly" = "weekly") => socialMetrics({ kind, main, compare, days, posts: [], names: { instagram: "@acme" } });
  it("counts reach and engagement for the month so far against the same days last month", () => {
    const x = social().mtd!;
    expect(x.now.reach).toBe(200 * 15);
    expect(x.before.reach).toBe(100 * 15);
    expect(x.projectedReach).toBe(6000);
    expect(social("monthly").mtd).toBeUndefined();
  });
  it("shows its rows and text", () => {
    const v = socialMtdView(social())!;
    expect(v.headline).toEqual({ label: "Reach", value: "3,000" });
    expect(v.rows.map((r) => r.label)).toEqual(expect.arrayContaining(["Posts published", "Reach", "Engagement rate", "Follower change"]));
    expect(socialText(social())).toContain("Month to date (November 1 – Nov 15, day 15 of 30): Reach 3,000");
  });
});

describe("the PDFs draw it", () => {
  const pdfText = async (el: Parameters<typeof renderToBuffer>[0]) => {
    const buf = new Uint8Array(await renderToBuffer(el));
    expect(Buffer.from(buf).subarray(0, 4).toString()).toBe("%PDF");
    return Buffer.from(buf).length;
  };
  const sections = { headline: "h", summary: "s", did: [], doing: [], next: [], highlights: [] };
  it("an ad weekly, with and without a budget, early in the month", async () => {
    const draw = (m: ReportMetrics) => pdfText(createElement(ReportDocument, { input: { client: "Acme", kind: "weekly", periodLabel: "Nov 9 – Nov 15", parts: [{ platform: "meta", buyer: null, metrics: m, sections, extras: null }] }, images: [[]] }) as Parameters<typeof renderToBuffer>[0]);
    const withMtd = await draw(ads());
    expect(withMtd).toBeGreaterThan(1000);
    await draw(ads({ monthlyBudget: null }));
    await draw(ads({ mtd: period({ end: "2026-11-02", spend: 400 }) }));
  });
  it("an ad weekly carries the Month to date section, a monthly does not", async () => {
    const text = async (m: ReportMetrics, kind: "weekly" | "monthly") => {
      const pdf = new Uint8Array(await renderToBuffer(createElement(ReportDocument, { input: { client: "Acme", kind, periodLabel: "x", parts: [{ platform: "meta", buyer: null, metrics: m, sections, extras: null }] }, images: [[]] }) as Parameters<typeof renderToBuffer>[0]));
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdfjs.getDocument({ data: pdf, standardFontDataUrl: `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").replace(/\\/g, "/")}/` }).promise;
      let all = "";
      for (let i = 1; i <= doc.numPages; i++) all += (await (await doc.getPage(i)).getTextContent()).items.map((x) => ("str" in x ? x.str : "")).join(" ");
      return all;
    };
    const weekly = await text(ads(), "weekly");
    expect(weekly).toContain("Month to date");
    expect(weekly).toContain("Over pace");
    expect(weekly).toContain("60% of budget used");
    expect(await text(ads({ monthlyBudget: null }), "weekly")).toContain("No monthly budget set");
    expect(await text(ads({ kind: "monthly", mtd: null, mtdCompare: null }), "monthly")).not.toContain("Month to date");
  });
  it("an email and a social weekly", async () => {
    const e = email();
    e.mtd!.target = { metric: "revenue", label: "Attributed revenue", unit: "money", target: 8000, actual: 3000, progress: 0.375, basis: "monthly target" };
    await pdfText(createElement(ChannelDocument, { input: { client: "Acme", metrics: e, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    const days = range("2026-09-01", "2026-11-16").map((d) => sday(d));
    await pdfText(createElement(ChannelDocument, { input: { client: "Acme", metrics: socialMetrics({ kind: "weekly", main, compare, days, posts: [], names: { instagram: "@acme" } }), sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
  });
});
