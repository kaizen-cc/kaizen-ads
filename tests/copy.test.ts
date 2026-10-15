import { describe, expect, it } from "vitest";
import { blockers, headsUp, meters, type Ad } from "@/lib/copy";

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

describe("Kaizen's copy standard", () => {
  it("short-form: over 125 is a heads-up, empty is the only red", () => {
    expect(meters(short("a".repeat(100))).primary.tone).toBe("ok");
    expect(meters(short("a".repeat(200))).primary.tone).toBe("warn");
    expect(meters(short("a".repeat(301))).primary.tone).toBe("warn");
    expect(meters(short("")).primary.tone).toBe("bad");
  });

  it("long-form outside 300-800 words is a heads-up, not a block", () => {
    expect(meters(long(281)).primary.tone).toBe("warn");
    expect(meters(long(450)).primary.tone).toBe("ok");
    expect(meters(long(801)).primary.tone).toBe("warn");
  });

  it("headline and link description over the limit are heads-ups", () => {
    expect(meters(short("ok", "x".repeat(41))).headline.tone).toBe("warn");
    expect(meters(short("ok", "")).headline.tone).toBe("bad");
    expect(meters(short("ok", "Fine", "x".repeat(31))).description.tone).toBe("warn");
  });

  it("only missing copy blocks; being off the standard is a heads-up", () => {
    const set = [short("One."), short("Two."), short("Three."), long(320), long(500)];
    expect(blockers(set)).toEqual([]);
    expect(headsUp(set)).toEqual([]);
    const slightlyShort = [...set.slice(0, 3), long(281), long(500)];
    expect(blockers(slightlyShort)).toEqual([]);
    expect(headsUp(slightlyShort)[0]).toMatch(/281 words/);
    expect(blockers([short(""), ...set.slice(1)])[0]).toMatch(/primary text is empty/);
    expect(headsUp(set.slice(0, 4))[0]).toMatch(/5 ads/);
    expect(headsUp([{ ...set[0], cta: "Click Here" }, ...set.slice(1)])[0]).toMatch(/CTA/);
    expect(headsUp([short("Visit www.site.com"), ...set.slice(1)])[0]).toMatch(/link/);
  });
});
