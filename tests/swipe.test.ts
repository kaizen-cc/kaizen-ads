import { describe, expect, it } from "vitest";
import { addressOf, CAPTCHA, cadenceText, groupFlows, isSilent, robotsAllows, slugFromRecipients, slugOf, triggerOf } from "@/lib/swipe/core";

describe("swipe file: one identity per brand", () => {
  it("each brand signs up with its own plus-address, and every email maps back to it", () => {
    expect(slugOf("The Farmer's Dog")).toBe("thefarmersdog");
    expect(addressOf("glossier")).toBe("swipe+glossier@kaizenmarketing.agency");
    expect(slugFromRecipients(null, "Kaizen <swipe+glossier@kaizenmarketing.agency>")).toBe("glossier");
    expect(slugFromRecipients("swipe+AG1@KaizenMarketing.agency")).toBe("ag1");
    expect(slugFromRecipients("someone@kaizenmarketing.agency")).toBeNull();
  });
});

describe("swipe file: flows", () => {
  const t = { signup: "2026-11-25T10:00:00Z", browse: "2026-11-27T10:00:00Z", cart: null, checkout: null };
  it("an email's trigger is the bot's last action before it, with the hours since", () => {
    expect(triggerOf("2026-11-25T10:05:00Z", t)).toEqual({ kind: "signup", hours: 0.08 });
    expect(triggerOf("2026-11-28T10:00:00Z", t)).toEqual({ kind: "browse", hours: 24 });
    expect(triggerOf("2026-11-24T10:00:00Z", t)).toEqual({ kind: null, hours: null });
  });
  it("groups emails into flows with steps and the time between them; campaigns stand alone", () => {
    const g = groupFlows([
      { id: "a", brand: "b1", type: "welcome", at: "2026-11-25T10:05:00Z", trigger: "signup" },
      { id: "b", brand: "b1", type: "welcome", at: "2026-11-26T10:05:00Z", trigger: "signup" },
      { id: "c", brand: "b1", type: "campaign", at: "2026-11-26T15:00:00Z", trigger: null },
      { id: "d", brand: "b1", type: "welcome", at: "2026-11-28T10:05:00Z", trigger: "signup" },
      { id: "e", brand: "b1", type: "campaign", at: "2026-11-27T15:00:00Z", trigger: null },
    ]);
    const w = g.find((x) => x.type === "welcome")!;
    expect(w.ids).toEqual(["a", "b", "d"]);
    expect(w.gapsHours).toEqual([24, 48]);
    expect(g.filter((x) => x.type === "campaign")).toHaveLength(2);
    expect(cadenceText(w.gapsHours, 0.08)).toBe("3 emails: right away, +24h, +3 days");
  });
  it("a brand silent 14 days after signing up is flagged", () => {
    const now = Date.parse("2026-12-20T00:00:00Z");
    expect(isSilent({ signed_up_at: "2026-12-01T00:00:00Z", emails: 0 }, now)).toBe(true);
    expect(isSilent({ signed_up_at: "2026-12-10T00:00:00Z", emails: 0 }, now)).toBe(false);
    expect(isSilent({ signed_up_at: "2026-12-01T00:00:00Z", emails: 2 }, now)).toBe(false);
  });
});

describe("swipe file: the runner's manners", () => {
  it("stops at a CAPTCHA or bot wall (never solves one)", () => {
    expect(CAPTCHA.test('<iframe src="https://www.google.com/recaptcha/api2/anchor">')).toBe(true);
    expect(CAPTCHA.test("https://challenges.cloudflare.com/cdn-cgi/challenge-platform")).toBe(true);
    expect(CAPTCHA.test("Press & Hold to confirm you are a human")).toBe(true);
    expect(CAPTCHA.test("<form><input type=email></form>")).toBe(false);
  });
  it("respects robots.txt (the * group, longest rule wins)", () => {
    const robots = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /checkout\nDisallow: /cart\nAllow: /cart/public\n";
    expect(robotsAllows(robots, "/")).toBe(true);
    expect(robotsAllows(robots, "/products/serum")).toBe(true);
    expect(robotsAllows(robots, "/checkout")).toBe(false);
    expect(robotsAllows(robots, "/cart")).toBe(false);
    expect(robotsAllows(robots, "/cart/public")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
});
