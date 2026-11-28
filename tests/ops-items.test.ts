import { describe, expect, it } from "vitest";
import { allotmentBucket, allotmentTitle, SUPPORT_SENDER, supportCase, supportNeedsReply } from "@/lib/ops-items-core";

// Nov 27 2026: hours over allotment and ad-platform support emails become items
describe("hours over allotment", () => {
  it("one item at ~80%, one at 100% and over", () => {
    expect(allotmentBucket(80)).toBe("80");
    expect(allotmentBucket(100)).toBe("100");
    expect(allotmentBucket(125)).toBe("100");
    expect(allotmentTitle({ client: "Kore Outdoor", team: "Meta Buyer", level: 100, month: "2026-11" })).toBe("Kore Outdoor: Meta Buyer hours past 100% of November's allotment: decide more hours or hold work");
    expect(allotmentTitle({ client: "Sierra Dreams", team: "Meta Buyer", level: 80, month: "2026-11" })).toBe("Sierra Dreams: Meta Buyer hours at 80% of November's allotment");
  });
});

describe("ad-platform support emails", () => {
  it("knows support senders", () => {
    expect(SUPPORT_SENDER.test("Meta Support <noreply@support.facebook.com>")).toBe(true);
    expect(SUPPORT_SENDER.test("Google Ads <ads-support@google.com>")).toBe(true);
    expect(SUPPORT_SENDER.test("Chris <chris@limelight.com>")).toBe(false);
  });
  it("only the ones asking for something back, with the case number", () => {
    const body = "Thanks for contacting Meta Support about case 2305650846952592. We need more information about the rejected ads for your hemp products. Please reply to this email with the details.";
    expect(supportNeedsReply("Your support case", body)).toBe(true);
    expect(supportCase(body)).toBe("2305650846952592");
    expect(supportNeedsReply("How did we do?", "Please rate your support case experience")).toBe(false);
    expect(supportNeedsReply("Your ad was approved", "Your ad is now running.")).toBe(false);
  });
});
