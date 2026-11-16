import { describe, expect, it } from "vitest";
import { dataFlags, emailMetrics, targetLine } from "@/lib/channel-reports/core";
import { locationBreakdown } from "@/lib/klaviyo/locations";
import { revenueTarget } from "@/lib/email-metrics";

// The email report paces against the board's monthly target (last month + 10%, a higher manual one wins), and its QA
// checks a multi-location client's location numbers.

const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };

describe("the email report's target", () => {
  it("names the automatic target and shares it out to a week", () => {
    const rt = revenueTarget(10000, null);
    const t = targetLine("email", { metric: "revenue", target: rt.target!, source: rt.source }, { kind: "monthly", main, revenue: 9900 })!;
    expect(t.target).toBe(11000);
    expect(t.basis).toBe("monthly target (last month +10%)");
    const week = targetLine("email", { metric: "revenue", target: 11000, source: "floor" }, { kind: "weekly", main: { start: "2026-10-05", end: "2026-10-11" }, revenue: 2000 })!;
    expect(week.basis).toBe("weekly share of the monthly target (last month +10%)");
    expect(week.target).toBeLessThan(11000);
    // A manual target above the floor is the one paced against
    const hi = revenueTarget(10000, 15000);
    expect(targetLine("email", { metric: "revenue", target: hi.target!, source: hi.source }, { kind: "monthly", main, revenue: 9900 })!.basis).toBe("monthly target");
  });
});

describe("the QA's location checks", () => {
  const m = emailMetrics({
    kind: "monthly",
    main,
    compare,
    today: "2026-11-02",
    days: [],
    campaigns: [{ id: "c1", name: "Two Large Tuesday", channel: "email", sendTime: "2026-10-06T16:00:00Z", subject: null, recipients: 1000, delivered: 990, opensUnique: 400, clicksUnique: 20, unsubscribes: 1, bounced: 0, spamComplaints: 0, revenue: 1000, conversions: 20, openRate: 0.4, clickRate: 0.02 }],
    flows: [],
    keyFlows: [],
    profiles: null,
    currency: "USD",
    account: null,
  });

  it("alerts when a flagged client has no location numbers", () => {
    expect(dataFlags({ ...m, locations: null }).some((f) => /by location/.test(f.issue))).toBe(true);
    expect(dataFlags({ ...m, locations: undefined }).some((f) => /by location/.test(f.issue))).toBe(false);
  });

  it("checks the locations add up to what Klaviyo attributes", () => {
    const locations = locationBreakdown({ metrics: [{ id: "toast", name: "Toast" }], rows: [{ metricId: "toast", date: "2026-10-06", location: "Fremont", messageId: "c1", campaignId: "c1", flowId: null, conversions: 10, revenue: 500 }], campaigns: [{ id: "c1", name: "Two Large Tuesday", sendDay: "2026-10-06" }] });
    const flags = dataFlags({ ...m, locations, locationAttributed: { toast: 1000 } });
    expect(flags.some((f) => /add up to \$500 against \$1,000/.test(f.issue))).toBe(true);
  });
});
