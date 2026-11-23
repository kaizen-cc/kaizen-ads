import { describe, expect, it } from "vitest";
import { backoffDelay, SlowError, withTimeout } from "../src/lib/fail-fast";
import { changedRows, readAllRows, sameRow, sameValue, stable } from "../src/lib/unchanged";

describe("skip unchanged rows", () => {
  it("reads jsonb the same whatever its key order", () => {
    expect(stable({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(stable({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("treats numeric strings, timestamps and nulls the way Postgres returns them", () => {
    expect(sameValue(12.5, "12.5")).toBe(true);
    expect(sameValue("2026-11-23T10:00:00.000Z", "2026-11-23T10:00:00+00:00")).toBe(true);
    expect(sameValue("2026-11-23T10:00:00Z", "2026-11-23T10:00:01Z")).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue("a", "b")).toBe(false);
  });

  it("ignores fields that move on every run, and fields the write leaves out", () => {
    const stored = { kind: "creative", key: "1", spend: 10, verdict: "winner", updated_at: "2026-11-22T00:00:00Z", extra: "kept" };
    expect(sameRow({ kind: "creative", key: "1", spend: 10, verdict: "winner", updated_at: "2026-11-23T00:00:00Z", verdict_at: undefined }, stored, ["updated_at", "verdict_at"])).toBe(true);
    expect(sameRow({ kind: "creative", key: "1", spend: 11, updated_at: "x" }, stored, ["updated_at"])).toBe(false);
    expect(sameRow({ key: "1" }, undefined)).toBe(false);
  });

  it("keeps only new and changed rows", () => {
    const stored = new Map<string, Record<string, unknown>>([
      ["a", { id: "a", spend: 1, detail: { x: 1, y: 2 } }],
      ["b", { id: "b", spend: 2, detail: {} }],
    ]);
    const rows = [
      { id: "a", spend: 1, detail: { y: 2, x: 1 }, updated_at: "now" },
      { id: "b", spend: 3, detail: {}, updated_at: "now" },
      { id: "c", spend: 1, detail: {}, updated_at: "now" },
    ];
    expect(changedRows(rows, stored, (r) => r.id, ["updated_at"]).map((r) => r.id)).toEqual(["b", "c"]);
    // a second run with nothing new writes nothing
    const again = new Map(rows.map((r) => [r.id, r as Record<string, unknown>]));
    expect(changedRows(rows, again, (r) => r.id, ["updated_at"])).toEqual([]);
  });

  it("pages through every row", async () => {
    const all = Array.from({ length: 2300 }, (_, i) => ({ i }));
    const got = await readAllRows(async (a, b) => ({ data: all.slice(a, b + 1) }));
    expect(got).toHaveLength(2300);
  });
});

describe("pollers fail fast and back off", () => {
  it("doubles the wait with each failure up to the cap", () => {
    expect(backoffDelay(15_000, 0)).toBe(15_000);
    expect(backoffDelay(15_000, 1)).toBe(30_000);
    expect(backoffDelay(15_000, 3)).toBe(120_000);
    expect(backoffDelay(15_000, 20)).toBe(300_000);
  });

  it("rejects work that takes too long", async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 20)).rejects.toBeInstanceOf(SlowError);
    await expect(withTimeout(Promise.resolve(5), 20)).resolves.toBe(5);
  });
});
