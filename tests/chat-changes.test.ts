import { describe, expect, it } from "vitest";
import { editOp, edited, findLinks, googleDeepLink, lineOf, metaDeepLink, replaceLinks, verifyLink, type ObjRef } from "@/lib/chat-change-core";

describe("deep links", () => {
  it("opens the exact Meta object in its own tab", () => {
    expect(metaDeepLink("act_123", "campaign", "999")).toBe("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=999");
    expect(metaDeepLink("123", "adset", "55")).toBe("https://adsmanager.facebook.com/adsmanager/manage/adsets?act=123&selected_adset_ids=55");
    expect(metaDeepLink("123", "ad", "7")).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=7");
    expect(metaDeepLink("123", "account")).toBe("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123");
  });

  it("opens the Google Ads page for the account, narrowed to the campaign and ad group", () => {
    expect(googleDeepLink("123-456-7890", "campaign", { campaignId: "11" })).toBe("https://ads.google.com/aw/campaigns?__e=1234567890&campaignId=11");
    expect(googleDeepLink("1234567890", "keyword", { campaignId: "11", adGroupId: "22" })).toBe("https://ads.google.com/aw/keywords?__e=1234567890&campaignId=11&adGroupId=22");
    expect(googleDeepLink("1234567890", "ad_group", { campaignId: "11", adGroupId: "22" })).toBe("https://ads.google.com/aw/adgroups?__e=1234567890&campaignId=11&adGroupId=22");
  });

  it("links a copied ad to the new copy, not the original", () => {
    const ref: ObjRef = { platform: "meta", level: "ad", id: "7", name: "Winner", path: [], status: "ACTIVE", account: "123" };
    expect(verifyLink(ref)).toContain("selected_ad_ids=7");
    expect(verifyLink(ref, "8")).toContain("selected_ad_ids=8");
    expect(verifyLink({ ...ref, platform: "team", level: "person" })).toBeNull();
  });
});

describe("swapping a Meta creative's link", () => {
  const spec = {
    page_id: "1",
    link_data: {
      link: "https://shop.com/old",
      message: "Hi https://shop.com/old",
      call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.com/old" } },
      child_attachments: [
        { link: "https://shop.com/old", name: "A" },
        { link: "https://shop.com/other", name: "B" },
      ],
    },
  };

  it("finds every destination link once", () => {
    expect(findLinks(spec).sort()).toEqual(["https://shop.com/old", "https://shop.com/other"]);
  });

  it("replaces every link but leaves the text alone", () => {
    const r = replaceLinks(spec, "https://shop.com/new");
    expect(r.changed).toBe(4);
    expect(r.spec.link_data.message).toBe("Hi https://shop.com/old");
    expect(findLinks(r.spec)).toEqual(["https://shop.com/new"]);
  });

  it("replaces only the matching link when told which", () => {
    const r = replaceLinks(spec, "https://shop.com/new", "https://shop.com/old/");
    expect(r.changed).toBe(3);
    expect(r.spec.link_data.child_attachments[1].link).toBe("https://shop.com/other");
  });
});

describe("the buyer's edits", () => {
  const budget = { kind: "meta_budget", to: 50, from: 40, name: "X" };

  it("changes only what a change allows", () => {
    expect(editOp(budget, { to: 75.555 }).to).toBe(75.56);
    expect(editOp(budget, { name: "nope" })).toEqual(budget);
    expect(editOp(budget, { to: -5 }).to).toBe(50);
    expect(editOp({ kind: "meta_link", to: "https://a.com" }, { url: "https://b.com" }).to).toBe("https://b.com");
    expect(editOp({ kind: "meta_link", to: "https://a.com" }, { url: "not a url" }).to).toBe("https://a.com");
    expect(editOp({ kind: "meta_rename", to: "Old" }, { name: "  New name " }).to).toBe("New name");
    expect(editOp(budget, undefined)).toBe(budget);
  });

  it("knows an edited change needs checking again", () => {
    expect(edited(editOp(budget, { to: 60 }), budget)).toBe(true);
    expect(edited(editOp(budget, { to: 50 }), budget)).toBe(false);
  });
});

describe("describing a change", () => {
  it("says what, from and to for the chat's kinds", () => {
    expect(lineOf({ kind: "meta_copy_ad", name: "Winner", parent: "Engagement", targetAdset: "Purchases · Conversions", status: "PAUSED" } as never)).toEqual(['Copy ad "Winner"', "Engagement", "Purchases · Conversions (paused)"]);
    expect(lineOf({ kind: "google_keyword_status", name: "roofing", campaign: "Search", from: "ENABLED", to: "PAUSED" } as never)).toEqual(['Keyword "roofing" · Search', "on", "paused"]);
    expect(lineOf({ kind: "assign_buyer", slot: "meta_buyer", from: null, to: "Sam" } as never)).toEqual(["Meta buyer", "nobody", "Sam"]);
    expect(lineOf({ kind: "meta_budget", level: "adset", name: "A", from: 40, to: 60 } as never)).toEqual(['Daily budget · ad set "A"', "$40.00", "$60.00"]);
  });
});

describe("an ad's Ads Manager link selects its campaign and ad set too", () => {
  it("narrows Ads Manager to the one ad instead of ticking it among every ad", () => {
    expect(metaDeepLink("act_123", "ad", "9", { campaignId: "7", adsetId: "8" })).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_campaign_ids=7&selected_adset_ids=8&selected_ad_ids=9");
    expect(metaDeepLink("123", "adset", "8", { campaignId: "7" })).toBe("https://adsmanager.facebook.com/adsmanager/manage/adsets?act=123&selected_campaign_ids=7&selected_adset_ids=8");
    expect(metaDeepLink("123", "ad", "9")).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=9");
  });
});
