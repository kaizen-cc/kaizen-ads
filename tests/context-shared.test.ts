import { describe, expect, it } from "vitest";
import { pgSafe, trimBody } from "@/lib/context/shared";

describe("text saved to context", () => {
  it("does not cut an emoji in half when trimming", () => {
    const body = trimBody(`${"a".repeat(2999)}😀 rest`, 3000)!;
    expect(body).toBe(`${"a".repeat(2999)}…`);
    expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
    expect(body.isWellFormed()).toBe(true);
  });

  it("drops lone surrogates and NULs but keeps whole emoji", () => {
    expect(pgSafe("hi \ud83d there\u0000 😀 \ude00")).toBe("hi  there 😀 ");
  });
});
