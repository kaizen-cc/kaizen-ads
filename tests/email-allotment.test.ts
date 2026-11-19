import { describe, expect, it } from "vitest";
import { cleanScope, emailAllotmentLine, emailPace, requestFit, requestUnits, toEmailAllotment, type EmailAllotmentRow } from "@/lib/email-allotment-core";

describe("requestUnits: what one Asana email request counts", () => {
  it("counts a batched campaign task by its emails", () => {
    expect(requestUnits("KZN x Crust Pizza Co. | Email Campaign - December (5)", "batch", "Email Campaign")).toEqual({ pool: "campaigns", units: 5 });
  });
  it("counts a flow as one, whatever its message count", () => {
    expect(requestUnits("KZN x Angry Chickz | Email Flow - Welcome Series (3)", "flow", "Email Flow")).toEqual({ pool: "flows", units: 1 });
  });
  it("counts flows when the name counts flows", () => {
    expect(requestUnits("KZN x Sierra Dreams | Email Flow Update (3 flows)", "flow", null)).toEqual({ pool: "flows", units: 3 });
  });
  it("counts a single campaign with no number as one", () => {
    expect(requestUnits("KZN x OceanBox | Email Campaign - Gift the box", "batch", "Email Campaign")).toEqual({ pool: "campaigns", units: 1 });
  });
  it("counts SMS campaigns as campaigns", () => {
    expect(requestUnits("KZN x Tejas | SMS Campaigns - Holiday (2)", "batch", "SMS")).toEqual({ pool: "campaigns", units: 2 });
  });
  it("skips action items and templates", () => {
    expect(requestUnits("Update Account Overviews", "batch", null)).toBeNull();
    expect(requestUnits("KZN x Fig | Templates", "batch", "Templates")).toBeNull();
  });
});

const row = (p: Partial<EmailAllotmentRow>): EmailAllotmentRow => ({
  client_id: "c",
  campaigns_per_month: 8,
  flows_per_month: 1,
  cap_source: "package",
  scope_label: null,
  package_key: "growth",
  package_label: "Growth",
  campaigns_used: 3,
  flows_used: 0,
  campaigns_progress: 2,
  flows_progress: 0,
  period_start: "2026-11-01",
  period_end: "2026-12-01",
  ...p,
});

describe("the allotment line and pace", () => {
  it("shows each pool with what's in progress", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({})))).toBe("Campaigns 3/8 used · 2 in progress · Flows 0/1 used");
  });
  it("names the overage", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({ campaigns_used: 10 })))).toContain("2 over");
    expect(emailPace(toEmailAllotment(row({ campaigns_used: 10 }))).group).toBe("over");
  });
  it("has no line without a cap", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({ campaigns_per_month: null, flows_per_month: null })))).toBeNull();
  });
  it("is behind pace late in the cycle with little used", () => {
    expect(emailPace(toEmailAllotment(row({ campaigns_used: 0, flows_used: 1 })), new Date("2026-11-25T12:00:00")).group).toBe("behind");
  });
  it("says what a request leaves", () => {
    const a = toEmailAllotment(row({}));
    expect(requestFit(a, "campaign", 3)).toEqual({ tone: "ok", text: "Counts as 3 campaigns · 2 of 8 left after this" });
    expect(requestFit(a, "flow", 4).text).toBe("Counts as 1 flow · 0 of 1 left after this");
    expect(requestFit(a, "campaign", 6).tone).toBe("warn");
  });
});

describe("cleanScope", () => {
  it("normalizes months and counts", () => {
    const s = cleanScope({ summary: "x", email_in_scope: true, months: [{ month: "2026-12", label: "Month 1", campaigns: 4.4, flows: 1, notes: "" }], ongoing: null } as never);
    expect(s.months).toEqual([{ month: "2026-12-01", label: "Month 1", campaigns: 4, flows: 1, notes: "" }]);
    expect(s.start).toBe("2026-12-01");
  });
});
