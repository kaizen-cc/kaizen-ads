import { describe, expect, it } from "vitest";
import { businessItemPlatform, canRebut, platformOf, rebutRights, rightFor, whoCanTeach } from "@/lib/rebut-permission";

// Who may push back on an AI audit item (rebut, teach the agent, rule on a contradiction): the permission, or the head
// of the item's platform.

const ruler = { can_rebut_audits: true, role: "exec" };
const googleHead = { can_rebut_audits: false, role: "head_of_google" };
const metaHead = { can_rebut_audits: false, role: "head_of_meta" };
const buyer = { can_rebut_audits: false, role: "media_buyer" };

describe("canRebut", () => {
  it("lets the people given the permission rebut anything", () => {
    for (const p of ["meta", "google", "both", null] as const) expect(canRebut(ruler, p)).toBe(true);
  });

  it("lets the Head of Google rebut Google items, not Meta ones", () => {
    expect(canRebut(googleHead, "google")).toBe(true);
    expect(canRebut(googleHead, "meta")).toBe(false);
    expect(canRebut(googleHead, "both")).toBe(true);
    expect(canRebut(googleHead, null)).toBe(false);
  });

  it("lets the Head of Meta rebut Meta items, not Google ones", () => {
    expect(canRebut(metaHead, "meta")).toBe(true);
    expect(canRebut(metaHead, "google")).toBe(false);
    expect(canRebut(metaHead, "both")).toBe(true);
  });

  it("keeps everyone else out", () => {
    for (const p of ["meta", "google", "both", null] as const) {
      expect(canRebut(buyer, p)).toBe(false);
      expect(canRebut(null, p)).toBe(false);
    }
  });

  it("gives rights per platform", () => {
    const r = rebutRights(googleHead);
    expect(r).toEqual({ meta: false, google: true, both: true, none: false });
    expect(rightFor(r, "google")).toBe(true);
    expect(rightFor(r, null)).toBe(false);
  });
});

describe("the platform of an item", () => {
  it("reads stored platforms", () => {
    expect(platformOf("google")).toBe("google");
    expect(platformOf("meta")).toBe("meta");
    expect(platformOf("both")).toBe("both");
    expect(platformOf("none")).toBe(null);
    expect(platformOf(undefined)).toBe(null);
  });

  it("takes a business audit item's channel, and both for the whole business", () => {
    const r = { causes: [{ channel: "google" }, { channel: "creative" }], actions: [{ channel: "meta" }] };
    expect(businessItemPlatform(r, "cause:0")).toBe("google");
    expect(businessItemPlatform(r, "cause:1")).toBe("both");
    expect(businessItemPlatform(r, "action:0")).toBe("meta");
    expect(businessItemPlatform(r, "channel:google")).toBe("google");
    expect(businessItemPlatform(r, "verdict")).toBe("both");
    expect(businessItemPlatform(null, "watchout:0")).toBe("both");
  });

  it("says who can teach, by role", () => {
    expect(whoCanTeach("google")).toContain("Head of Google");
    expect(whoCanTeach("meta")).not.toContain("Google");
  });
});
