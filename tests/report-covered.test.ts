import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { coveredBy } from "@/lib/reports/builder";

describe("a built report covers the automatic one", () => {
  it("covers the same week", () => expect(coveredBy({ kind: "weekly", period_start: "2026-11-02", period_end: "2026-11-08" }, { period_start: "2026-11-02", period_end: "2026-11-08" })).toBe(true));
  it("covers a week it mostly overlaps", () => expect(coveredBy({ kind: "weekly", period_start: "2026-11-02", period_end: "2026-11-08" }, { period_start: "2026-11-05", period_end: "2026-11-11" })).toBe(true));
  it("not a week it barely touches", () => expect(coveredBy({ kind: "weekly", period_start: "2026-11-02", period_end: "2026-11-08" }, { period_start: "2026-11-07", period_end: "2026-11-13" })).toBe(false));
  it("a monthly only when the whole month is in it", () => {
    expect(coveredBy({ kind: "monthly", period_start: "2026-10-01", period_end: "2026-10-31" }, { period_start: "2026-10-27", period_end: "2026-11-02" })).toBe(false);
    expect(coveredBy({ kind: "monthly", period_start: "2026-10-01", period_end: "2026-10-31" }, { period_start: "2026-10-01", period_end: "2026-10-31" })).toBe(true);
  });
});
