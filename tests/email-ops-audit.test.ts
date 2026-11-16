import { describe, expect, it } from "vitest";
import { emailScore, type EmailInputs } from "@/lib/email-score";
import { checkLine, needsAutoAudit, ruleFindings, type LastAudit } from "@/lib/email-ops/audit-core";

const healthy: EmailInputs = { attributed: 0.35, rpr: 0.2, deliverability: 80, campaignOpen: 0.35, campaignClick: 0.012, flowOpen: 0.4, flowClick: 0.02 };

describe("rule findings", () => {
  it("lists each check under its bar, worst first, with the value against the bar", () => {
    const s = emailScore({ ...healthy, attributed: 0.1, campaignClick: 0.005 });
    const f = ruleFindings(s);
    expect(f.map((x) => x.title)).toEqual(["Attributed revenue is under its bar", "Campaign click rate is under its bar"]);
    expect(f[0].area).toBe("flows");
    expect(f[0].severity).toBe("high");
    expect(f[0].evidence[0]).toContain("10.0% against a 30.0% bar");
  });

  it("flags a critical key flow that is missing or not live, and nothing for a live one", () => {
    const s = emailScore(healthy);
    const f = ruleFindings(s, [
      { label: "Welcome series", state: "missing", critical: true },
      { label: "Abandoned checkout or cart", state: "present", critical: true },
      { label: "Browse abandonment", state: "missing", critical: false },
      { label: "Winback", state: "live", critical: true },
    ]);
    expect(f.map((x) => x.title)).toEqual(["Welcome series is missing", "Abandoned checkout or cart is built but not live"]);
  });

  it("reads a check with nothing to measure as left out, not failed", () => {
    const s = emailScore({ ...healthy, flowOpen: null });
    expect(checkLine(s.checks.find((c) => c.key === "flowOpen")!)).toContain("nothing to measure");
    expect(ruleFindings(s)).toEqual([]);
  });
});

describe("auto audits", () => {
  const now = Date.parse("2026-11-17T15:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const H = 3_600_000;
  const D = 24 * H;
  const last = (status: NonNullable<LastAudit>["status"], age: number, touched = false): LastAudit => ({ status, createdAt: ago(age), touched });

  it("only audits an account in the red", () => {
    expect(needsAutoAudit(59, null, now)).toBe(true);
    expect(needsAutoAudit(60, null, now)).toBe(false);
    expect(needsAutoAudit(null, null, now)).toBe(false);
  });
  it("audits a red account that has never been audited", () => {
    expect(needsAutoAudit(40, null, now)).toBe(true);
  });
  it("refreshes after three days when nobody has started on the last one", () => {
    expect(needsAutoAudit(40, last("ready", 2 * D), now)).toBe(false);
    expect(needsAutoAudit(40, last("ready", 3 * D + H), now)).toBe(true);
    expect(needsAutoAudit(40, last("ready", 5 * D, true), now)).toBe(false);
  });
  it("never doubles up on a running audit until it has timed out, and waits six hours after a failure", () => {
    expect(needsAutoAudit(40, last("running", 5 * 60_000), now)).toBe(false);
    expect(needsAutoAudit(40, last("running", 20 * 60_000), now)).toBe(true);
    expect(needsAutoAudit(40, last("failed", 2 * H), now)).toBe(false);
    expect(needsAutoAudit(40, last("failed", 7 * H), now)).toBe(true);
  });
});
