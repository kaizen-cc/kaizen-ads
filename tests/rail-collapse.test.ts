import { describe, expect, it } from "vitest";
import { RAIL_KEY, readCollapsed, writeCollapsed } from "@/lib/rail-collapse";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe("Kaizen AI chat rail collapse", () => {
  it("starts open and remembers hiding and showing", () => {
    const s = mem();
    expect(readCollapsed(s)).toBe(false);
    writeCollapsed(s, true);
    expect(s.m.get(RAIL_KEY)).toBe("1");
    expect(readCollapsed(s)).toBe(true);
    writeCollapsed(s, false);
    expect(s.m.has(RAIL_KEY)).toBe(false);
    expect(readCollapsed(s)).toBe(false);
  });

  it("works with no or blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readCollapsed(blocked)).toBe(false);
    expect(() => writeCollapsed(blocked, true)).not.toThrow();
    expect(readCollapsed(null)).toBe(false);
  });
});
