import { describe, expect, it } from "vitest";
import type { Guide, GuideHas } from "@/lib/onboarding-guide-types";
import { accountStatus, cellNumber, cleanMoments, disableReason, groupWork, memoryChunks, metaFindings, monthWindow, onboardingItems, rowsText, sheetLink, statusEmail, summarizeSheet, weekOf, type MetaFacts, type WorkItem } from "@/lib/ai-tools/team-ops-core";

describe("monthWindow", () => {
  it("reads the common ways to name a month", () => {
    expect(monthWindow("2027-02", "2026-11-17")).toMatchObject({ start: "2027-02-01", end: "2027-02-28", label: "February 2027" });
    expect(monthWindow("feb 2028", "2026-11-17")).toMatchObject({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthWindow("December 2026", "2026-11-17")).toMatchObject({ end: "2026-12-31", startsInDays: 14 });
  });
  it("defaults to next month, across the year end", () => {
    expect(monthWindow("", "2026-11-17")).toMatchObject({ month: "2026-12" });
    expect(monthWindow(undefined, "2026-12-20")).toMatchObject({ month: "2027-01", end: "2027-01-31" });
  });
  it("says when it can't read it", () => {
    expect("error" in monthWindow("soon", "2026-11-17")).toBe(true);
    expect("error" in monthWindow("2027-13", "2026-11-17")).toBe(true);
  });
});

describe("cleanMoments", () => {
  const ctx = { clientId: "c1", verticalId: null, model: "ecommerce" };
  it("keeps future dated moments and says what it left out", () => {
    const r = cleanMoments(
      [
        { name: "Mother's Day", on_date: "2027-05-09", lead_days: 5, angle: "Gift", match_terms: ["Mothers", "ab", "mothers"] },
        { name: "Old", on_date: "2026-01-01" },
        { name: "No date" },
        { name: "Mother's Day", on_date: "2027-05-09" },
        { on_date: "2027-06-01" },
      ],
      "2026-11-17",
      ctx,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ client_id: "c1", lead_days: 14, match_terms: ["mothers"], business_model: "ecommerce" });
    expect(r.skipped).toHaveLength(3);
  });
});

describe("memoryChunks", () => {
  it("makes dated background notes that each fit a memory row", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(60)}`).join("\n\n");
    const chunks = memoryChunks("Onboarding research", text, "2026-11-17");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks[0]).toMatch(/^Onboarding research \(background, 2026-11-17\) 1\/\d+: /);
  });
  it("keeps a short note as one", () => {
    expect(memoryChunks("Notes", "Short.", "2026-11-17")).toEqual(["Notes (background, 2026-11-17): Short."]);
  });
  it("splits one long paragraph", () => {
    const chunks = memoryChunks("X", "a sentence here. ".repeat(300), "2026-11-17");
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });
});

const guide = (over: Partial<Guide> = {}): Guide => ({ meta: {}, google: {}, assets: {}, style: {}, business: {}, ga4: {}, gtm: {}, gbp: {}, merchant: {}, website: {}, email: {}, tracking: {}, ...over });
const has: GuideHas = { meta: true, google: true, looks: true, website: true, email: false, ecommerce: false, tracking: null };

describe("onboardingItems and statusEmail", () => {
  const facts = { guide: guide({ meta: { status: "verified", accountName: "Acme Ads", pageName: "Acme" }, assets: { files: 3, links: 1 } }), has, welcomed: true, intake: { submitted: false, started: true }, call: { booked: false, checked: false }, bible: false };
  const items = onboardingItems(facts);
  it("says what's done and what's missing", () => {
    const by = Object.fromEntries(items.map((i) => [i.key, i.state]));
    expect(by.meta).toBe("done");
    expect(by.assets).toBe("done");
    expect(by.google).toBe("missing");
    expect(by.ga4).toBe("missing");
    expect(by.website).toBe("missing");
    expect(by.intake).toBe("waiting");
    expect(by.call).toBe("missing");
    expect(by.email).toBeUndefined();
  });
  it("counts a step saved for the call as waiting, not missing", () => {
    const i = onboardingItems({ ...facts, guide: guide({ meta: { status: "on_call" } }) });
    expect(i.find((x) => x.key === "meta")?.state).toBe("waiting");
  });
  it("drafts a plain email asking only for what's open", () => {
    const e = statusEmail({ brand: "Acme", first: "Sam", items, portal: "https://portal.example/c/acme/start" })!;
    expect(e.subject).toMatch(/^Acme: \d+ quick things/);
    expect(e.text).toContain("Hi Sam,");
    expect(e.text).toContain("Google Ads account");
    expect(e.text).not.toContain("Meta access");
    expect(e.text).toContain("https://portal.example/c/acme/start");
    expect(e.text).not.toContain("—");
    expect(e.text.trim().endsWith("The Kaizen team")).toBe(true);
  });
  it("has no email when nothing is missing", () => {
    const done = onboardingItems({ ...facts, has: { ...has, google: false, website: false, looks: false }, guide: guide({ meta: { status: "verified" }, assets: { files: 1 } }), intake: { submitted: true, started: true }, call: { booked: true, checked: true } });
    expect(statusEmail({ brand: "Acme", first: null, items: done, portal: "x" })).toBeNull();
  });
});

describe("the week's work", () => {
  const today = "2026-11-18"; // a Wednesday
  it("finds Monday to Sunday", () => {
    expect(weekOf(today)).toMatchObject({ start: "2026-11-16", end: "2026-11-22" });
    expect(weekOf("2026-11-22").start).toBe("2026-11-16");
    expect(weekOf("2026-11-16").start).toBe("2026-11-16");
  });
  it("groups by late, day, later and no date, each by client", () => {
    const w = (title: string, client: string | null, due: string | null): WorkItem => ({ kind: "ticket", title, client, due, status: "x", href: null });
    const g = groupWork([w("a", "Zed", "2026-11-18"), w("b", "Acme", "2026-11-18"), w("c", "Acme", "2026-11-10"), w("d", "Acme", "2026-12-01"), w("e", null, null), w("f", "Acme", "2026-11-17")], today);
    expect(g.overdue.map((i) => i.title)).toEqual(["c", "f"]);
    expect(g.days.find((d) => d.day === "2026-11-18")?.items.map((i) => i.title)).toEqual(["b", "a"]);
    expect(g.days.find((d) => d.day === "2026-11-18")?.name).toBe("Wednesday");
    expect(g.later.map((i) => i.title)).toEqual(["d"]);
    expect(g.noDate.map((i) => i.title)).toEqual(["e"]);
    expect(g.counts).toEqual({ total: 6, overdue: 2, thisWeek: 2 });
  });
});

describe("sheets", () => {
  it("finds the id in a link", () => {
    expect(sheetLink("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit#gid=123")).toEqual({ id: "1AbCdEfGhIjKlMnOpQrStUv", gid: "123" });
    expect(sheetLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view")?.id).toBe("1AbCdEfGhIjKlMnOpQrStUv");
    expect(sheetLink("https://example.com/x")).toBeNull();
  });
  it("reads numbers the way sheets show them", () => {
    expect(cellNumber("$1,234.50")).toBe(1234.5);
    expect(cellNumber("12%")).toBe(12);
    expect(cellNumber("(45)")).toBe(-45);
    expect(cellNumber("-3")).toBe(-3);
    expect(cellNumber("abc")).toBeNull();
    expect(cellNumber("")).toBeNull();
  });
  const rows = [["Weekly report"], ["Post", "Format", "Reach", "Likes"], ["a", "Reel", "1,000", "50"], ["b", "Reel", "2,000", "70"], ["c", "Image", "500", "x"], [], ["d", "Reel", "$500", "10"]];
  it("summarises the columns", () => {
    const s = summarizeSheet(rows);
    expect(s.headerRow).toBe(2);
    expect(s.dataRows).toBe(4);
    const reach = s.columns.find((c) => c.header === "Reach")!;
    expect(reach).toMatchObject({ kind: "number", sum: 4000, min: 500, max: 2000, average: 1000 });
    const format = s.columns.find((c) => c.header === "Format")!;
    expect(format.kind).toBe("text");
    expect(format.top?.[0]).toEqual({ value: "Reel", count: 3 });
  });
  it("gives rows as text with their numbers and pages through them", () => {
    const a = rowsText(rows, 1, 3, 10_000);
    expect(a.text.split("\n")[0]).toBe("1 | Weekly report");
    expect(a.more).toBe(true);
    const b = rowsText(rows, a.last + 1, 10, 10_000);
    expect(a.text).toContain("3 | a | Reel | 1,000 | 50");
    expect(b.text).toContain("4 | b | Reel | 2,000 | 70");
    expect(b.more).toBe(false);
  });
});

describe("Meta", () => {
  const base: MetaFacts = {
    configured: true,
    services: { meta: true },
    account: "123",
    kaizenBm: "999",
    live: { status: 1, disable: 0, name: "Acme", business: "Acme LLC", verification: "verified", pixels: [{ name: "px", lastFired: new Date().toISOString() }], partners: ["999"] },
    guide: {},
    social: { pageId: "p", igId: "i", state: "connected", error: null, missing: [] },
    bm: [],
    now: Date.now(),
  };
  it("finds nothing wrong with a healthy setup", () => {
    expect(metaFindings(base)).toEqual([]);
  });
  it("puts blockers first, each with steps", () => {
    const f = metaFindings({ ...base, live: { ...base.live, status: 2, disable: 1, partners: [], pixels: [] }, social: { pageId: null, igId: null, state: "missing", error: null, missing: [] } });
    expect(f[0].severity).toBe("blocker");
    expect(f.map((x) => x.problem).join("|")).toMatch(/disabled \(Ads integrity policy/);
    expect(f.some((x) => /isn't a partner/.test(x.problem))).toBe(true);
    expect(f.some((x) => /No pixel/.test(x.problem))).toBe(true);
    expect(f.some((x) => /No Facebook Page/.test(x.problem))).toBe(true);
    expect(f.every((x) => x.steps.length > 0)).toBe(true);
  });
  it("asks for the ad account when none is on file", () => {
    const f = metaFindings({ ...base, account: null, live: null });
    expect(f[0].problem).toMatch(/No Meta ad account/);
    expect(f[0].steps.join(" ")).toContain("999");
  });
  it("catches a stale or silent pixel and an unverified business", () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    expect(metaFindings({ ...base, live: { ...base.live, pixels: [{ name: "px", lastFired: old }] } }).some((x) => /hasn't fired in over a week/.test(x.problem))).toBe(true);
    expect(metaFindings({ ...base, live: { ...base.live, pixels: [{ name: "px", lastFired: null }] } }).some((x) => /never fired/.test(x.problem))).toBe(true);
    expect(metaFindings({ ...base, live: { ...base.live, verification: "not_verified" } }).some((x) => /isn't verified/.test(x.problem))).toBe(true);
    expect(metaFindings({ ...base, live: { ...base.live, verification: "pending" } })[0].severity).toBe("fix");
  });
  it("names a missing permission as Kaizen's side to fix", () => {
    const f = metaFindings({ ...base, social: { pageId: "p", igId: "i", state: "failing", error: { message: "missing instagram_manage_insights", fix: "Add it" }, missing: ["instagram_manage_insights"] } });
    expect(f[0].problem).toMatch(/instagram_manage_insights/);
    expect(f[0].steps[0]).toMatch(/Kaizen's side/);
  });
  it("explains status and disable codes", () => {
    expect(accountStatus(1)).toEqual({ label: "Active", bad: false });
    expect(accountStatus(3).bad).toBe(true);
    expect(disableReason(0)).toBeNull();
    expect(disableReason(3)).toMatch(/Payment risk/);
  });
});
