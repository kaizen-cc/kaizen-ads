import { describe, expect, it } from "vitest";
import { completedSearch, completedSince, filterCompleted, isCompleted, liveAds, parseCompletedFilters, shouldAutoComplete, type CompletedRow } from "@/lib/ticket-completion";

describe("auto-complete: the ticket completes when Meta shows its ad live", () => {
  const ads = [
    { adId: "1", name: "Kaizen | Calzone V1" },
    { adId: "2", name: "Kaizen | Calzone V2" },
    { adId: null, name: "Failed one" },
  ];
  it("reads which launched ads are turned on", () => {
    expect(liveAds(ads, { "1": { status: "PAUSED" }, "2": { status: "ACTIVE", effective_status: "IN_PROCESS" } }).map((a) => a.adId)).toEqual(["2"]);
    expect(liveAds(ads, { "1": { status: "PAUSED" } })).toEqual([]);
    expect(liveAds(ads, null)).toEqual([]);
  });
  it("a sandbox test never completes a ticket", () => {
    expect(liveAds(ads, { "1": { status: "ACTIVE" } }, true)).toEqual([]);
  });
  it("only a launched, not-yet-live ticket waiting in Ready to launch completes", () => {
    const t = { stage: "ready_for_launch", launchStatus: "launched", sandbox: false, liveAt: null };
    expect(shouldAutoComplete(t, 1)).toBe(true);
    expect(shouldAutoComplete(t, 0)).toBe(false);
    expect(shouldAutoComplete({ ...t, sandbox: true }, 1)).toBe(false);
    expect(shouldAutoComplete({ ...t, liveAt: "2026-11-10T00:00:00Z" }, 1)).toBe(false);
    expect(shouldAutoComplete({ ...t, stage: "launched" }, 1)).toBe(false);
    expect(shouldAutoComplete({ ...t, launchStatus: "ready" }, 1)).toBe(false);
  });
  it("launched (or stamped) reads as completed", () => {
    expect(isCompleted({ stage: "launched" })).toBe(true);
    expect(isCompleted({ stage: "ready_for_launch", completedAt: "2026-11-10T00:00:00Z" })).toBe(true);
    expect(isCompleted({ stage: "ready_for_launch" })).toBe(false);
  });
});

describe("the Completed tasks log", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const rows: CompletedRow[] = [
    { number: 1201, title: "Calzone Mondays", clientName: "Tony's Pizza", clientSlug: "tonys", format: "image", completedAt: "2026-11-10T10:00:00Z" },
    { number: 1188, title: "Spring menu reel", clientName: "Tony's Pizza", clientSlug: "tonys", format: "video", completedAt: "2026-10-20T10:00:00Z" },
    { number: 1102, title: "Live classes carousel", clientName: "Habla", clientSlug: "habla", format: "carousel", completedAt: "2026-07-01T10:00:00Z" },
  ];
  it("reads its filters from the address, 30 days by default", () => {
    const q = new URLSearchParams("cq=%23120&cclient=tonys&cformat=video&crange=bogus");
    expect(parseCompletedFilters((k) => q.get(k))).toEqual({ q: "#120", client: "tonys", format: "video", range: "30" });
    expect(parseCompletedFilters(() => null)).toEqual({ q: "", client: null, format: null, range: "30" });
  });
  it("filters by date, client, format and search, newest first", () => {
    const f = { q: "", client: null, format: null, range: "30" as const };
    expect(filterCompleted(rows, f, now).map((r) => r.number)).toEqual([1201, 1188]);
    expect(filterCompleted(rows, { ...f, range: "all" }, now).map((r) => r.number)).toEqual([1201, 1188, 1102]);
    expect(filterCompleted(rows, { ...f, range: "all", client: "habla" }, now).map((r) => r.number)).toEqual([1102]);
    expect(filterCompleted(rows, { ...f, format: "video" }, now).map((r) => r.number)).toEqual([1188]);
    expect(filterCompleted(rows, { ...f, q: "#120" }, now).map((r) => r.number)).toEqual([1201]);
    expect(filterCompleted(rows, { ...f, q: "reel" }, now).map((r) => r.number)).toEqual([1188]);
    expect(filterCompleted(rows, { ...f, range: "7" }, now).map((r) => r.number)).toEqual([1201]);
  });
  it("turns the search into a database filter, safely", () => {
    expect(completedSearch("#1201")).toEqual({ title: null, number: 1201 });
    expect(completedSearch("calzone, (x)")).toEqual({ title: "calzone   x", number: null });
    expect(completedSearch("  ")).toEqual({ title: null, number: null });
    expect(completedSince("all", now)).toBeNull();
    expect(completedSince("7", now)).toBe("2026-11-04T12:00:00.000Z");
  });
});
