import { describe, expect, it } from "vitest";
import { countdown, daysUntil, dueNotice, tokenExpiry } from "@/lib/atlassian-token";

describe("the Atlassian token's expiry", () => {
  it("prefers the date set on the card, then the env default, ignoring junk", () => {
    expect(tokenExpiry("2027-11-05", "2027-01-01")).toEqual({ date: "2027-11-05", from: "set" });
    expect(tokenExpiry(null, "2027-01-01")).toEqual({ date: "2027-01-01", from: "env" });
    expect(tokenExpiry(null, "next year")).toBeNull();
    expect(tokenExpiry(undefined, undefined)).toBeNull();
  });

  it("counts whole days", () => {
    expect(daysUntil("2026-12-05", "2026-11-05")).toBe(30);
    expect(daysUntil("2026-11-05", "2026-11-05")).toBe(0);
    expect(daysUntil("2026-11-04", "2026-11-05")).toBe(-1);
    expect(countdown(30)).toBe("Expires in 30 days");
    expect(countdown(1)).toBe("Expires tomorrow");
    expect(countdown(0)).toBe("Expires today");
    expect(countdown(-2)).toBe("Expired 2 days ago");
  });

  it("sends each threshold once, only the closest when several were crossed", () => {
    expect(dueNotice(45, [])).toBeNull();
    expect(dueNotice(30, [])).toEqual({ send: 30, mark: [30] });
    expect(dueNotice(29, [30])).toBeNull();
    expect(dueNotice(14, [30])).toEqual({ send: 14, mark: [14] });
    expect(dueNotice(12, [])).toEqual({ send: 14, mark: [30, 14] });
    expect(dueNotice(7, [30, 14])).toEqual({ send: 7, mark: [7] });
    expect(dueNotice(1, [30, 14, 7])).toEqual({ send: 1, mark: [1] });
    expect(dueNotice(0, [30, 14, 7, 1])).toBeNull();
    expect(dueNotice(-3, [])).toBeNull();
  });
});
