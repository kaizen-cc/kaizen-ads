import { describe, expect, it } from "vitest";
import { doneTitle, progressOf, reviewTitle, reviewed, searchHref, STAGES, STAGE_LABEL, SEARCH_EXPECTED_MS, type SearchResult } from "@/lib/prospect-search-core";
import { mayOpen } from "@/lib/ai-access-core";

const r = (id: string | null, already = false): SearchResult => ({ id, name: "Glow", website: "https://glow.com", location: "Tampa", industry: "med spa", signals: "no ads", fit_score: 80, fit_reason: "high ticket", already });

describe("prospect search jobs", () => {
  it("has the owner's four stages in order", () => {
    expect(STAGES.map((s) => STAGE_LABEL[s])).toEqual(["Searching sources", "Checking sites", "Scoring fit", "Saving"]);
  });
  it("moves the bar by time while searching, by items after, never to 100 until done and never backwards", () => {
    const t0 = Date.parse("2026-11-24T23:00:00Z");
    const at = new Date(t0).toISOString();
    expect(progressOf({ status: "queued", stage: null })).toBe(2);
    const early = progressOf({ status: "running", stage: "searching", stageAt: at }, t0 + 5_000);
    const late = progressOf({ status: "running", stage: "searching", stageAt: at }, t0 + SEARCH_EXPECTED_MS);
    const veryLate = progressOf({ status: "running", stage: "searching", stageAt: at }, t0 + 20 * 60_000);
    expect(early).toBeGreaterThan(2);
    expect(late).toBeGreaterThan(early);
    expect(veryLate).toBeLessThan(56);
    expect(progressOf({ status: "running", stage: "checking", done: 5, total: 10 })).toBe(65);
    expect(progressOf({ status: "running", stage: "saving", done: 10, total: 10 })).toBe(99);
    expect(progressOf({ status: "running", stage: "searching", stageAt: at, saved: 70 }, t0)).toBe(70);
    expect(progressOf({ status: "done", stage: "saving" })).toBe(100);
  });
  it("reads like the owner asked", () => {
    expect(doneTitle(24, "med spas in Tampa")).toBe("Prospect search done: 24 businesses found for 'med spas in Tampa'");
    expect(doneTitle(1, "roofers")).toBe("Prospect search done: 1 business found for 'roofers'");
    expect(doneTitle(0, "roofers")).toBe("Prospect search done: nothing found for 'roofers'");
    expect(reviewTitle(24, "med spas in Tampa")).toBe("Review the 24 prospects found for 'med spas in Tampa'");
  });
  it("the Overview item clears once they've opened the results or acted on every new one", () => {
    const s = { reviewed_at: null, results: [r("a"), r("b"), r("c", true)] };
    const stages: Record<string, { status: string; archived: boolean }> = { a: { status: "new", archived: false }, b: { status: "researched", archived: false } };
    expect(reviewed(s, (id) => stages[id] ?? null)).toBe(false);
    stages.a = { status: "new", archived: true };
    expect(reviewed(s, (id) => stages[id] ?? null)).toBe(true);
    expect(reviewed({ ...s, reviewed_at: "2026-11-24" }, () => ({ status: "new", archived: false }))).toBe(true);
    // Nothing new added (all already in the pipeline): only opening it clears it
    expect(reviewed({ reviewed_at: null, results: [r("c", true)] }, () => null)).toBe(false);
  });
  it("opens on the Sales page for an exec, in the item's own sheet for anyone else", () => {
    expect(searchHref("s1", true)).toBe("/sales?search=s1");
    expect(searchHref("s1", false)).toBe("/pipeline?block=needs&item=prospectsearch%3As1");
    expect(mayOpen(searchHref("s1", false), { role: "head_of_meta", isExec: false, isLead: true }).ok).toBe(true);
  });
});
