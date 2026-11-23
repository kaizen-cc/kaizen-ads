import { describe, expect, it } from "vitest";
import { nextPageParams, untilBefore } from "@/lib/social/core";

describe("the next page of a list Meta answered", () => {
  it("follows a cursor", () => {
    expect(nextPageParams({ cursors: { after: "QVFI" }, next: "https://graph.facebook.com/v23.0/123/media?limit=50&after=QVFI" })).toEqual({ after: "QVFI" });
  });
  it("follows a Page's time paging, which has no cursor (McIntyre's North Star stopped at its first page)", () => {
    expect(nextPageParams({ next: "https://graph.facebook.com/v23.0/103284555610345/published_posts?limit=40&until=1762300800&__paging_token=enc_AdBx" })).toEqual({ until: "1762300800", __paging_token: "enc_AdBx" });
  });
  it("takes the cursor when the next link carries none", () => {
    expect(nextPageParams({ cursors: { after: "abc" }, next: "not a url" })).toEqual({ after: "abc" });
  });
  it("says there's no next page", () => {
    expect(nextPageParams({ cursors: { after: "abc" } })).toBeNull();
    expect(nextPageParams(undefined)).toBeNull();
  });
  it("steps back from the oldest post when Meta gives no next page", () => {
    expect(untilBefore("2026-11-05T15:00:00+0000")).toEqual({ until: String(Date.parse("2026-11-05T15:00:00Z") / 1000 - 1) });
    expect(untilBefore(null)).toBeNull();
  });
});
