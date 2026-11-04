import { describe, expect, it } from "vitest";
import { DECIDE, SLOP, gestureOf, pressStart, verdictOf } from "@/lib/swipe-gesture";

// A fake element: closest() answers for the selectors its ancestors would match
const el = (matches: string[]) => ({ closest: (s: string) => (matches.some((m) => s.includes(m)) ? {} : null) });

describe("gestureOf", () => {
  it("a press that hasn't moved is still a tap", () => {
    expect(gestureOf("card", 0, 0)).toBe("pending");
    expect(gestureOf("card", SLOP - 1, -(SLOP - 1))).toBe("pending");
  });
  it("a sideways drag on the card swipes it", () => {
    expect(gestureOf("card", 40, 5)).toBe("swipe");
    expect(gestureOf("card", -40, -12)).toBe("swipe");
  });
  it("a mostly vertical drag is the page scrolling", () => {
    expect(gestureOf("card", 10, 60)).toBe("none");
  });
  it("a drag that starts inside a carousel stays with the carousel, however sideways", () => {
    expect(gestureOf("carousel", 200, 0)).toBe("none");
    expect(gestureOf("carousel", -200, 0)).toBe("none");
  });
  it("a press on a control is the control's", () => {
    expect(gestureOf("control", 200, 0)).toBe("none");
  });
});

describe("verdictOf", () => {
  it("decides only past the line", () => {
    expect(verdictOf(DECIDE + 1)).toBe("approve");
    expect(verdictOf(-(DECIDE + 1))).toBe("changes");
    expect(verdictOf(DECIDE)).toBe("cancel");
    expect(verdictOf(-30)).toBe("cancel");
  });
});

describe("pressStart", () => {
  it("knows a carousel before a control inside it", () => {
    expect(pressStart(el(["[data-carousel]", "button"]) as never)).toBe("carousel");
  });
  it("buttons, links, fields and videos are controls", () => {
    expect(pressStart(el(["button"]) as never)).toBe("control");
    expect(pressStart(el(["video"]) as never)).toBe("control");
  });
  it("anything else is the card", () => {
    expect(pressStart(el([]) as never)).toBe("card");
    expect(pressStart(null)).toBe("card");
  });
});
