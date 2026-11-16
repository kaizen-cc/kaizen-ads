import { describe, expect, it } from "vitest";
import { connectState, parseGoogleCustomerId, parseMetaAccountId, parseTikTokAdvertiserId } from "@/lib/kpi/connect";

describe("connecting an ad account from a KPI card", () => {
  it("reads a Meta ad account ID however it is typed", () => {
    expect(parseMetaAccountId("act_1234567890")).toBe("1234567890");
    expect(parseMetaAccountId(" 1234567890 ")).toBe("1234567890");
    expect(parseMetaAccountId("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1234567890&nav=1")).toBe("1234567890");
    expect(parseMetaAccountId("act_abc")).toBeNull();
    expect(parseMetaAccountId("")).toBeNull();
    expect(parseMetaAccountId(null)).toBeNull();
  });
  it("keeps Google customer IDs as 123-456-7890, from dashes or digits", () => {
    expect(parseGoogleCustomerId("123-456-7890")).toBe("123-456-7890");
    expect(parseGoogleCustomerId("1234567890")).toBe("123-456-7890");
    expect(parseGoogleCustomerId(" 123 456 7890 ")).toBe("123-456-7890");
    expect(parseGoogleCustomerId("123-456-789")).toBeNull();
    expect(parseGoogleCustomerId("")).toBeNull();
  });
  it("reads a TikTok advertiser ID as plain digits", () => {
    expect(parseTikTokAdvertiserId("7012345678901234567")).toBe("7012345678901234567");
    expect(parseTikTokAdvertiserId("70123")).toBeNull();
    expect(parseTikTokAdvertiserId("abc")).toBeNull();
  });
  it("says connect when no account is set", () => {
    expect(connectState("meta", null, "setup", "Add the ad account ID")).toEqual({ kind: "missing" });
    expect(connectState("google", "  ", "setup", null)).toEqual({ kind: "missing" });
  });
  it("explains a Business Manager share that is missing", () => {
    const s = connectState("meta", "123456", "setup", "Meta can't see this ad account yet. Assign it to the CommandCenter system user.");
    expect(s.kind).toBe("blocked");
    if (s.kind === "blocked") expect(s.fix).toMatch(/ads_read/);
  });
  it("explains a Google account not linked to the manager account", () => {
    expect(connectState("google", "123-456-7890", "setup", "Google Ads can't see this account through our manager account.").kind).toBe("blocked");
  });
  it("leaves a healthy card, a no-data card and a server not set up alone", () => {
    expect(connectState("meta", "123456", "good", null).kind).toBe("ok");
    expect(connectState("meta", "123456", "setup", "No data from Meta yet").kind).toBe("ok");
    expect(connectState("google", "123-456-7890", "setup", "Google Ads isn't connected yet (missing a manager account permission)").kind).toBe("ok");
  });
});
