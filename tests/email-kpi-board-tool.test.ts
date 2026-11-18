import { describe, expect, it } from "vitest";
import { kpiBoardEmail } from "@/lib/kaizen-ai/email-insights";
import { deliverabilityScore, emailScore } from "@/lib/email-score";

// The email_marketing tool (Kaizen AI, the assistant and the agents on calls) carries the email KPI board's score,
// so the Email Strategist reads the deliverability score from the board instead of saying none is on file.
describe("the email KPI board in the email tool", () => {
  it("gives the deliverability score, its parts and every check", () => {
    const d = deliverabilityScore({ recipients: 11000, delivered: 10900, bounced: 100, spam: 2, unsubscribes: 33, opens: 6758, clicks: 120 })!;
    const s = { ...emailScore({ attributed: 0.25, rpr: 0.2, deliverability: d.score, campaignOpen: 0.62, campaignClick: 0.011, flowOpen: 0.4, flowClick: 0.02 }), deliverability: d, window: { from: "2026-10-20", to: "2026-11-18" } };
    const b = kpiBoardEmail(s)!;
    expect(b.deliverability_score).toBe(d.score);
    expect(b.deliverability_score).toBeGreaterThan(0);
    expect(b.deliverability_bar).toBe(65);
    expect(b.deliverability_parts.map((p) => p.metric)).toContain("Spam complaint rate");
    expect(b.checks).toHaveLength(8);
    expect(b.checks.find((c) => c.check === "Deliverability")?.value).toBe(d.score);
    expect(b.checks.find((c) => c.check === "Campaign open rate")?.value).toBe(62);
    expect(b.email_score).toBe(s.score);
  });

  it("says why there is no deliverability score, and is null with no board score", () => {
    const s = { ...emailScore({ attributed: null, rpr: null, deliverability: null, campaignOpen: null, campaignClick: null, flowOpen: 0.4, flowClick: 0.02 }), deliverability: null };
    const b = kpiBoardEmail(s)!;
    expect(b.deliverability_score).toBeNull();
    expect(b.deliverability_note).toMatch(/no deliverability score/);
    expect(kpiBoardEmail(null)).toBeNull();
  });
});
