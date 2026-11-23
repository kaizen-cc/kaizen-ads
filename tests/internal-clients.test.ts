import { describe, expect, it } from "vitest";
import { isInternalClient } from "@/lib/internal-clients";

describe("internal and sandbox clients stay off leads' and execs' lists", () => {
  it("by name or slug", () => {
    expect(isInternalClient("Kaizen (sandbox)")).toBe(true);
    expect(isInternalClient("Anything", "kaizen-sandbox")).toBe(true);
    expect(isInternalClient("Acme Pizza", "acme-pizza")).toBe(false);
    expect(isInternalClient("Sandbar Grill")).toBe(false);
  });
});
