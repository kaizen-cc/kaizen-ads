import { describe, expect, it } from "vitest";
import { aggregateEmailScore, scoreFromRows } from "@/lib/email-score-calc";

const camp = (o: Partial<Parameters<typeof aggregateEmailScore>[0]["campaigns"][number]> = {}) => ({ channel: "email", recipients: 1000, delivered: 1000, bounced: 0, spam: 0, unsubscribes: 0, opens: 400, openRate: 0.4, clickRate: 0.02, ...o });

describe("aggregateEmailScore", () => {
  it("attributed and rpr come from the daily rows", () => {
    const r = aggregateEmailScore({
      days: [
        { revenue: 300, storeRevenue: 1000, campaignRecipients: 1000, flowRecipients: 500 },
        { revenue: 300, storeRevenue: 1000, campaignRecipients: 500, flowRecipients: 0 },
      ],
      campaigns: [],
      flows: [],
    });
    expect(r.inputs.attributed).toBeCloseTo(0.3);
    expect(r.inputs.rpr).toBeCloseTo(0.3);
  });
  it("attributed is null without store revenue", () => {
    const r = aggregateEmailScore({ days: [{ revenue: 100, storeRevenue: null, campaignRecipients: 10, flowRecipients: 0 }, { revenue: 5, storeRevenue: 0, campaignRecipients: 0, flowRecipients: 0 }], campaigns: [], flows: [] });
    expect(r.inputs.attributed).toBeNull();
  });
  it("weights campaign rates by delivered and leaves SMS out", () => {
    const r = aggregateEmailScore({ days: [], campaigns: [camp({ delivered: 3000, openRate: 0.4 }), camp({ delivered: 1000, openRate: 0.2 }), camp({ channel: "sms", delivered: 9000, openRate: 0.9 })], flows: [] });
    expect(r.inputs.campaignOpen).toBeCloseTo(0.35);
    expect(r.totals.campaignsSent).toBe(2);
  });
  it("weights flow rates by 30 day recipients over live flows only", () => {
    const r = aggregateEmailScore({
      days: [],
      campaigns: [],
      flows: [
        { status: "live", recipients30: 100, openRate30: 0.5, clickRate30: 0.04 },
        { status: "Live", recipients30: 300, openRate30: 0.3, clickRate30: 0.02 },
        { status: "draft", recipients30: 9999, openRate30: 0.9, clickRate30: 0.9 },
      ],
    });
    expect(r.inputs.flowOpen).toBeCloseTo(0.35);
    expect(r.inputs.flowClick).toBeCloseTo(0.025);
    expect(r.totals.flowsLive).toBe(2);
  });
  it("deliverability is null with no email campaigns", () => {
    const r = aggregateEmailScore({ days: [], campaigns: [camp({ channel: "sms" })], flows: [] });
    expect(r.deliverability).toBeNull();
    expect(r.inputs.deliverability).toBeNull();
  });
  it("scores a healthy account green and carries the window", () => {
    const s = scoreFromRows(
      { days: [{ revenue: 400, storeRevenue: 1000, campaignRecipients: 1000, flowRecipients: 1000 }], campaigns: [camp()], flows: [{ status: "live", recipients30: 500, openRate30: 0.5, clickRate30: 0.03 }] },
      { from: "2026-10-18", to: "2026-11-16" },
    );
    expect(s.band).toBe("good");
    expect(s.window.to).toBe("2026-11-16");
    expect(s.deliverability?.score).toBeGreaterThan(65);
  });
});

import { checkText as ct } from "@/lib/email-score-calc";

describe("checkText near the bar", () => {
  it("never shows a miss as the bar itself", () => {
    expect(ct("pct", 0.3496, "USD", 0.35)).toBe("34.96%");
    expect(ct("pct", 0.62, "USD", 0.3)).toBe("62%");
    expect(ct("pct", 0.0002)).toBe("0.02%");
    expect(ct("pct", 0.0147, "USD", 0.01)).toBe("1.5%");
  });
});
