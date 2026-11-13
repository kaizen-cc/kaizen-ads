import { describe, expect, it } from "vitest";
import { metaFirst, recapIntro, riderReady, tiktokJoins, waitingParts } from "@/lib/reports/joint-core";
import { channelsPhrase } from "@/lib/reports/delivery-core";

// Meta + TikTok is one part of the monthly recap, as it's one weekly report: queued joined, never waited on alone,
// approved and sent with the Meta part, and read as one in the recap's message.

const targets = [
  { id: "tt", client_id: "c1", platform: "tiktok", owner_id: "tiktok-buyer" },
  { id: "g", client_id: "c1", platform: "google", owner_id: "google-buyer" },
  { id: "m", client_id: "c1", platform: "meta", owner_id: "meta-buyer" },
  { id: "tt2", client_id: "c2", platform: "tiktok", owner_id: "tiktok-buyer" },
];

describe("queueing a Meta + TikTok client's recap", () => {
  it("queues Meta (and Google) before TikTok, so the TikTok part has its Meta part to join", () => {
    expect(metaFirst(targets).map((t) => t.id)).toEqual(["g", "m", "tt", "tt2"]);
    const order = metaFirst(targets).map((t) => t.platform);
    expect(order.indexOf("tiktok")).toBeGreaterThan(order.lastIndexOf("meta"));
    expect(order.slice(-2)).toEqual(["tiktok", "tiktok"]);
  });

  it("joins the TikTok part to the Meta part, owned by the Meta buyer, unless the client sends them apart", () => {
    const joins = tiktokJoins(targets, new Set());
    expect(joins.get("tt")).toEqual({ metaTargetId: "m", owner: "meta-buyer" });
    // No Meta account: TikTok stays its own part
    expect(joins.has("tt2")).toBe(false);
    expect(tiktokJoins(targets, new Set(["c1"])).has("tt")).toBe(false);
  });
});

describe("waiting on the other buyers", () => {
  it("never waits on a TikTok part riding on the Meta part", () => {
    const parts = [
      { id: "m", status: "submitted", joined_to: null },
      { id: "tt", status: "draft", joined_to: "m" },
      { id: "g", status: "draft", joined_to: null },
    ];
    expect(waitingParts(parts).map((p) => p.id)).toEqual(["g"]);
    expect(waitingParts(parts.filter((p) => p.id !== "g"))).toEqual([]);
  });

  it("doesn't wait on skipped, approved or sent parts", () => {
    expect(waitingParts([{ status: "skipped" }, { status: "posted" }, { status: "submitted" }, { status: "failed" }]).map((p) => p.status)).toEqual(["failed"]);
  });

  it("holds the Meta part until its TikTok part is written", () => {
    expect(riderReady({ sections: null, metrics: {} })).toBe(false);
    expect(riderReady({ sections: {}, metrics: null })).toBe(false);
    expect(riderReady({ sections: {}, metrics: {} })).toBe(true);
  });
});

describe("the recap's message", () => {
  it("reads TikTok under its own name right after the Meta message, then Google", () => {
    const text = recapIntro([
      { id: "m", platform: "meta", message: "Meta had a strong month." },
      { id: "tt", platform: "tiktok", message: "TikTok found a new winner.", joinedTo: "m" },
      { id: "g", platform: "google", message: "Google held steady." },
    ]);
    expect(text).toBe("Meta had a strong month.\n\n*TikTok Ads*\nTikTok found a new winner.\n\nGoogle held steady.");
  });

  it("keeps a TikTok part that goes separately as its own message", () => {
    expect(recapIntro([{ id: "m", platform: "meta", message: "Meta." }, { id: "tt", platform: "tiktok", message: "TikTok." }])).toBe("Meta.\n\nTikTok.");
  });

  it("drops empty messages", () => {
    expect(recapIntro([{ id: "m", platform: "meta", message: "  " }, { id: "g", platform: "google", message: "Google." }])).toBe("Google.");
  });

  it("says where it went in a sentence", () => {
    expect(channelsPhrase(["slack"])).toBe("in Slack");
    expect(channelsPhrase(["email"])).toBe("by email");
    expect(channelsPhrase(["slack", "email"])).toBe("in Slack and by email");
  });
});
