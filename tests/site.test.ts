import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/site";
import { initials } from "@/components/brand-switcher";

describe("safeNext (where a magic link or sign-in may send someone)", () => {
  it("keeps paths inside the app", () => {
    expect(safeNext("/c/crust-pizza-co")).toBe("/c/crust-pizza-co");
    expect(safeNext("/c/crust-pizza-co?item=123")).toBe("/c/crust-pizza-co?item=123");
  });
  it("refuses other sites and odd paths", () => {
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
  });
  it("falls back when missing", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined, "/c")).toBe("/c");
  });
});

describe("brand initials", () => {
  it("uses the first two words", () => {
    expect(initials("Crust Pizza Co.")).toBe("CP");
    expect(initials("Gumby's Pizza")).toBe("GS");
    expect(initials("OceanBox")).toBe("O");
  });
});
