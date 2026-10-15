import { describe, expect, it } from "vitest";
import { meters, problems, type Ad } from "@/lib/copy";

const short = (primaryText: string, headline = "Fresh fish, delivered", linkDescription = "Free shipping today"): Ad => ({
  kind: "short",
  formula: "PAS",
  angle: "Fresh, never frozen",
  primaryText,
  headline,
  linkDescription,
  cta: "Shop Now",
});
const long = (n: number): Ad => ({ ...short("x"), kind: "long", primaryText: Array.from({ length: n }, () => "word").join(" ") });

describe("Kyle's copy limits", () => {
  it("short-form: over 125 is a warning, over 300 blocks", () => {
    expect(meters(short("a".repeat(100))).primary.tone).toBe("ok");
    expect(meters(short("a".repeat(200))).primary.tone).toBe("warn");
    expect(meters(short("a".repeat(301))).primary.tone).toBe("bad");
  });

  it("long-form must be 300-800 words", () => {
    expect(meters(long(299)).primary.tone).toBe("bad");
    expect(meters(long(450)).primary.tone).toBe("ok");
    expect(meters(long(801)).primary.tone).toBe("bad");
  });

  it("headline 40 and link description 30 are hard limits", () => {
    expect(meters(short("ok", "x".repeat(41))).headline.tone).toBe("bad");
    expect(meters(short("ok", "x".repeat(35))).headline.tone).toBe("warn");
    expect(meters(short("ok", "Fine", "x".repeat(31))).description.tone).toBe("bad");
  });

  it("a full set is 5 ads within limits, with a real CTA and no links", () => {
    const set = [short("One."), short("Two."), short("Three."), long(320), long(500)];
    expect(problems(set)).toEqual([]);
    expect(problems(set.slice(0, 4))[0]).toMatch(/5 ads/);
    expect(problems([{ ...set[0], cta: "Click Here" }, ...set.slice(1)])[0]).toMatch(/CTA/);
    expect(problems([short("Visit www.site.com"), ...set.slice(1)])[0]).toMatch(/links/);
  });
});
