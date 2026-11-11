import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { accountOf } from "@/lib/account-sheet";

describe("the ad account on an Account Overview row", () => {
  it("reads Meta's and Google's Ad Account ID", () => {
    expect(accountOf({ "Client Name": "OceanBox", "Ad Account ID": "act_1234567890" })).toBe("1234567890");
    expect(accountOf({ "Client Name": "OceanBox", "Ad Account ID": "990-754-8733" })).toBe("9907548733");
  });
  it("reads TikTok's advertiser ID under whatever header the tab gives it", () => {
    expect(accountOf({ "Client Name": "Best Tickets", "Advertiser ID": "7301234567890123456" })).toBe("7301234567890123456");
    expect(accountOf({ "Client Name": "Best Tickets", "TikTok Ad Account ID": "7301234567890123456" })).toBe("7301234567890123456");
    expect(accountOf({ "Client Name": "Best Tickets", Budget: "$3,000" })).toBe("");
  });
});
