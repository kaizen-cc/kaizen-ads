import { describe, expect, it } from "vitest";
import { applyManual, manualCaption, manualText, withChatNumbers } from "@/lib/reports/manual";
import { blockedMessage, canRefresh, changesBetween, mergeChanges, noteText, sameNumbers, stableJson, textBehind, type RefreshNote } from "@/lib/reports/refresh-core";
import type { Period, ReportMetrics } from "@/lib/reports/metrics";

const period = (o: Partial<Period>): Period => ({ label: "Nov 9 to 15", start: "2026-11-09", end: "2026-11-15", days: 7, spend: 1000, impressions: 50000, clicks: 900, ctr: 1.8, cpc: 1.11, cpm: 20, results: 62, costPerResult: 16.13, revenue: 0, roas: null, ...o });
const metrics = (main: Partial<Period> = {}, compare: Partial<Period> = {}): ReportMetrics => ({
  platform: "google",
  kind: "weekly",
  conversion: "Conversions",
  roasKpi: false,
  target: null,
  monthlyBudget: null,
  main: period(main),
  compare: period({ label: "Nov 2 to 8", results: 50, costPerResult: 20, ...compare }),
  mtd: null,
  mtdCompare: null,
  campaigns: [],
  topAds: [],
  dataThrough: "2026-11-15",
  gaps: [],
});

describe("canRefresh", () => {
  it("refreshes a written report that has not gone out", () => {
    expect(canRefresh({ status: "draft", hasMetrics: true, hasSections: true })).toBe(true);
    expect(canRefresh({ status: "submitted", hasMetrics: true, hasSections: true, bundleStatus: "collecting" })).toBe(true);
  });
  it("never touches a sent report, one being written or one never written", () => {
    expect(canRefresh({ status: "posted", hasMetrics: true, hasSections: true })).toBe(false);
    expect(canRefresh({ status: "submitted", hasMetrics: true, hasSections: true, bundleStatus: "sent" })).toBe(false);
    for (const status of ["drafting", "queued", "failed", "skipped"]) expect(canRefresh({ status, hasMetrics: true, hasSections: true })).toBe(false);
    expect(canRefresh({ status: "draft", hasMetrics: true, hasSections: false })).toBe(false);
    expect(canRefresh({ status: "draft", hasMetrics: false, hasSections: true })).toBe(false);
  });
});

describe("sameNumbers", () => {
  it("ignores key order (the database reorders keys) and the refresh note", () => {
    const a = metrics();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))) as ReportMetrics;
    const note: RefreshNote = { at: "x", changes: [], text: "updated" };
    expect(sameNumbers(a, { ...reordered, refreshNote: note })).toBe(true);
    expect(stableJson({ b: 1, a: undefined, c: [{ z: 1, y: 2 }] })).toBe('{"b":1,"c":[{"y":2,"z":1}]}');
  });
  it("sees a moved number", () => {
    expect(sameNumbers(metrics(), metrics({ results: 67 }))).toBe(false);
  });
});

describe("changesBetween", () => {
  it("names the number the text quotes that moved, as it was and as it is", () => {
    const c = changesBetween(metrics(), metrics({ results: 67, costPerResult: 14.93 }));
    expect(c).toEqual([
      { label: "Conversions", was: "62", now: "67" },
      { label: "Cost per result", was: "$16.13", now: "$14.93" },
    ]);
  });
  it("ignores rounding and pennies", () => {
    expect(changesBetween(metrics(), metrics({ spend: 1000.4, costPerResult: 16.134, ctr: 1.9, impressions: 50100 }))).toEqual([]);
  });
  it("sees spend and revenue that really moved, but not a ROAS that held", () => {
    const c = changesBetween(metrics({ revenue: 3000, roas: 3 }), metrics({ spend: 1100, revenue: 3300, roas: 3.0 }));
    expect(c.map((x) => x.label)).toEqual(["Spend", "Revenue"]);
    expect(c[0]).toEqual({ label: "Spend", was: "$1,000", now: "$1,100" });
  });
  it("sees the comparison move too (the text quotes the change against it)", () => {
    expect(changesBetween(metrics(), metrics({}, { results: 55 }))).toEqual([{ label: "Conversions in the period before", was: "50", now: "55" }]);
  });
  it("reads a built report's other ranges by their own label", () => {
    const wasX = [metrics({ label: "Last 30 days" })];
    const nowX = [metrics({ label: "Last 30 days", results: 70 })];
    expect(changesBetween(metrics(), metrics(), wasX, nowX)).toEqual([{ label: "Last 30 days: Conversions", was: "62", now: "70" }]);
  });
  it("says n/a for a number that was missing", () => {
    expect(changesBetween(metrics({ costPerResult: null }), metrics({ costPerResult: 10 }))).toEqual([{ label: "Cost per result", was: "n/a", now: "$10" }]);
  });
});

describe("mergeChanges", () => {
  it("keeps the first figure the text was written with and the latest one", () => {
    const m = mergeChanges([{ label: "Conversions", was: "62", now: "67" }], [{ label: "Conversions", was: "67", now: "70" }, { label: "Spend", was: "$1,000", now: "$1,100" }]);
    expect(m).toEqual([
      { label: "Conversions", was: "62", now: "70" },
      { label: "Spend", was: "$1,000", now: "$1,100" },
    ]);
  });
  it("drops a number that came back to where it was", () => {
    expect(mergeChanges([{ label: "Conversions", was: "62", now: "67" }], [{ label: "Conversions", was: "67", now: "62" }])).toEqual([]);
  });
});

describe("the notice", () => {
  const note = (text: RefreshNote["text"]): RefreshNote => ({ at: "x", changes: [{ label: "Conversions", was: "62", now: "67" }], text });
  it("says what moved and what became of the text, calmly", () => {
    expect(noteText("google", note("updated"))).toBe("Numbers updated from Google since this was written: Conversions 62 → 67. The summary was updated to match.");
    expect(noteText("meta", note("needs_look"))).toContain("Update it before sending.");
    expect(noteText("tiktok", note("pending"))).toContain("TikTok");
    expect(noteText("google", note("updated"))).not.toContain("—");
  });
  it("holds a send only while the text is behind", () => {
    expect(textBehind({ refreshNote: note("pending") })).toBe(true);
    expect(textBehind({ refreshNote: note("needs_look") })).toBe(true);
    expect(textBehind({ refreshNote: note("updated") })).toBe(false);
    expect(textBehind({ refreshNote: note("kept") })).toBe(false);
    expect(textBehind({})).toBe(false);
    expect(blockedMessage("google", note("needs_look"))).toContain("Update the text");
  });
});

describe("withChatNumbers (numbers the buyer gives in the chat)", () => {
  const base = { period: { start: "2026-11-09", end: "2026-11-15" }, by: { id: "u1", name: "Sam" }, now: "2026-11-16T10:00:00Z" };
  it("replaces the main result with what the buyer said, labelled with the platform they cite", () => {
    const got = withChatNumbers({ results: 67, source: "Google Ads" }, { metrics: metrics(), existing: null, ...base });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.line).toMatchObject({ count: 67, main: true, fromPlatform: true, source: "Google Ads, entered by the buyer", label: "Conversions" });
    expect(got.entered).toMatchObject({ by: "u1", byName: "Sam", start: "2026-11-09", end: "2026-11-15" });
    const m = applyManual(metrics(), got.entered);
    expect(m.main.results).toBe(67);
    expect(m.main.costPerResult).toBe(14.93);
    expect(m.conversion).toBe("Conversions");
    // the platform's own comparison stays: the buyer gave no other
    expect(m.compare.results).toBe(50);
  });
  it("keeps the platform's revenue when the buyer gives none, and takes theirs when they do", () => {
    const m0 = metrics({ revenue: 3000, roas: 3 });
    const a = withChatNumbers({ results: 67 }, { metrics: m0, existing: null, ...base });
    const b = withChatNumbers({ results: 67, revenue: 4000, priorResults: 40 }, { metrics: m0, existing: null, ...base });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(applyManual(m0, a.entered).main.revenue).toBe(3000);
    expect(applyManual(m0, b.entered).main.revenue).toBe(4000);
    expect(applyManual(m0, b.entered).compare.results).toBe(40);
  });
  it("gives a different result no comparison it wasn't given (never made up)", () => {
    const got = withChatNumbers({ results: 9, label: "Bookings" }, { metrics: metrics({ revenue: 3000 }), existing: null, ...base });
    if (!got.ok) throw new Error("expected ok");
    expect(got.line).toMatchObject({ label: "Bookings", revenue: null, priorCount: null });
  });
  it("replaces its own earlier line and leaves the team's CRM lines, no longer the main one", () => {
    const crm = { id: "m1", label: "Bookings", count: 4, revenue: null, priorCount: null, priorRevenue: null, source: "CRM (GoHighLevel)", note: null, main: true };
    const first = withChatNumbers({ results: 67 }, { metrics: metrics(), existing: { lines: [crm], start: "2026-11-09", end: "2026-11-15", by: "u0", byName: "Kim", at: "x" }, ...base });
    if (!first.ok) throw new Error("expected ok");
    const second = withChatNumbers({ results: 70 }, { metrics: applyManual(metrics(), first.entered), existing: first.entered, ...base });
    if (!second.ok) throw new Error("expected ok");
    expect(second.entered.lines.map((l) => [l.id, l.count, l.main])).toEqual([
      ["m1", 4, false],
      ["chat-main", 70, true],
    ]);
    // the numbers underneath are the platform's, not the earlier manual ones
    expect(applyManual(applyManual(metrics(), first.entered), second.entered).main.results).toBe(70);
  });
  it("refuses with nothing to set", () => {
    expect(withChatNumbers({}, { metrics: metrics(), existing: null, ...base }).ok).toBe(false);
    expect(withChatNumbers({ results: -3 }, { metrics: metrics(), existing: null, ...base }).ok).toBe(false);
  });
  it("tells the writer and the PDF it is the platform's number, not the CRM's", () => {
    const got = withChatNumbers({ results: 67, source: "Google Ads" }, { metrics: metrics(), existing: null, ...base });
    if (!got.ok) throw new Error("expected ok");
    const m = applyManual(metrics(), got.entered);
    expect(manualCaption(m.manual)).toBe("Conversions: Google Ads, entered by the buyer.");
    expect(manualText(m)).toContain("report it as that platform's number");
  });
});
