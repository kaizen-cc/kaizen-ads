import { describe, expect, it } from "vitest";
import { allotmentPace, veryBehind, cleanScope, emailAllotmentLine, emailPace, requestFit, requestUnits, toEmailAllotment, unitsOfRequest, type EmailAllotmentRow } from "@/lib/email-allotment-core";

const u = (p: Partial<{ campaigns: number; sms: number; flows: number; flowEmails: number }>) => ({ campaigns: 0, sms: 0, flows: 0, flowEmails: 0, ...p });

describe("requestUnits: what one Asana email request counts", () => {
  it("counts a batched campaign task by its emails", () => {
    expect(requestUnits("KZN x Crust Pizza Co. | Email Campaign - December (5)", "batch", "Email Campaign")).toEqual(u({ campaigns: 5 }));
  });
  it("counts a flow once, its messages as flow emails", () => {
    expect(requestUnits("KZN x Angry Chickz | Email Flow - Welcome Series (3)", "flow", "Email Flow")).toEqual(u({ flows: 1, flowEmails: 3 }));
  });
  it("counts flows when the name counts flows", () => {
    expect(requestUnits("KZN x Sierra Dreams | Email Flow Update (3 flows)", "flow", null)).toEqual(u({ flows: 3 }));
  });
  it("counts a single campaign with no number as one", () => {
    expect(requestUnits("KZN x OceanBox | Email Campaign - Gift the box", "batch", "Email Campaign")).toEqual(u({ campaigns: 1 }));
  });
  it("counts SMS campaigns in their own pool", () => {
    expect(requestUnits("KZN x Tejas | SMS Campaigns - Holiday (2)", "batch", "SMS")).toEqual(u({ sms: 2 }));
  });
  it("skips action items and templates", () => {
    expect(requestUnits("Update Account Overviews", "batch", null)).toBeNull();
    expect(requestUnits("KZN x Fig | Templates", "batch", "Templates")).toBeNull();
  });
  it("counts a new request from the form", () => {
    expect(unitsOfRequest("flow", 4)).toEqual(u({ flows: 1, flowEmails: 4 }));
    expect(unitsOfRequest("sms", 2)).toEqual(u({ sms: 2 }));
    expect(unitsOfRequest("campaign", 3)).toEqual(u({ campaigns: 3 }));
  });
});

// Basic: 3-5 campaigns, 2 SMS, 3-5 flow emails, flows not capped
const row = (p: Partial<EmailAllotmentRow>): EmailAllotmentRow => ({
  client_id: "c",
  campaigns_min: 3,
  campaigns_per_month: 5,
  sms_min: 2,
  sms_per_month: 2,
  flows_per_month: null,
  flow_emails_min: 3,
  flow_emails_per_month: 5,
  cap_source: "package",
  scope_label: null,
  scope_notes: null,
  package_key: "basic",
  package_label: "Basic",
  campaigns_used: 3,
  sms_used: 0,
  flows_used: 0,
  flow_emails_used: 0,
  campaigns_progress: 2,
  sms_progress: 0,
  flows_progress: 0,
  flow_emails_progress: 0,
  period_start: "2026-11-01",
  period_end: "2026-12-01",
  campaigns_done: 1,
  ...p,
});

describe("the allotment line and pace", () => {
  it("shows each pool's range with what's in progress", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({})))).toBe("Campaigns 3/3-5 used · 2 in progress · 1 done · SMS 0/2 used · Flow emails 0/3-5 used");
  });
  it("shows flows asked when the tier doesn't cap them", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({ flows_used: 1, flow_emails_used: 4 })))).toContain("Flows 1 asked");
  });
  it("names the overage against the top of the range", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({ campaigns_used: 7 })))).toContain("2 over");
    expect(emailPace(toEmailAllotment(row({ campaigns_used: 7 }))).group).toBe("over");
  });
  it("has no line without a cap", () => {
    expect(emailAllotmentLine(toEmailAllotment(row({ campaigns_per_month: null, sms_per_month: null, flow_emails_per_month: null, cap_source: null, campaigns_used: 0 })))).toBeNull();
  });
  it("holds nothing for a strategy-only client", () => {
    const a = toEmailAllotment(row({ cap_source: "strategy", campaigns_per_month: null, sms_per_month: null, flow_emails_per_month: null, campaigns_used: 0 }));
    expect(emailPace(a).group).toBe("none");
  });
  it("is behind pace late in the cycle with little used", () => {
    expect(emailPace(toEmailAllotment(row({ campaigns_used: 0, sms_used: 0 })), new Date("2026-11-25T12:00:00")).group).toBe("behind");
  });
  it("says what a request leaves", () => {
    const a = toEmailAllotment(row({ campaigns_used: 1 }));
    expect(requestFit(a, "campaign", 3)).toEqual({ tone: "ok", text: "Counts as 3 campaigns · 1 of 3-5 campaigns left after this" });
    expect(requestFit(a, "flow", 4).text).toBe("Counts as 1 flow and 4 flow emails · 1 of 3-5 flow emails left after this");
    expect(requestFit(a, "campaign", 6).tone).toBe("warn");
  });
  it("follows a setup month", () => {
    const a = toEmailAllotment(row({ cap_source: "setup", scope_label: "Setup month 1: Foundation", campaigns_min: 0, campaigns_per_month: 0, sms_min: 0, sms_per_month: 0, flows_per_month: 3, flow_emails_min: 15, flow_emails_per_month: 15, campaigns_used: 0, campaigns_progress: 0, campaigns_done: 0 }));
    expect(a.label).toBe("Setup month 1: Foundation");
    expect(emailAllotmentLine(a)).toBe("Flows 0/3 used · Flow emails 0/15 used");
  });
});

describe("cleanScope", () => {
  it("normalizes months, counts and ranges", () => {
    const s = cleanScope({ summary: "x", email_in_scope: true, setup: "three_month", ongoing_tier: "Basic", months: [{ month: "2026-12", label: "Month 1", campaigns: 4.4, campaigns_min: 9, sms: 2, sms_min: 2, flows: 3, flow_emails: 15, flow_emails_min: 15, notes: "" }] } as never);
    expect(s.months[0]).toEqual({ month: "2026-12-01", label: "Month 1", campaigns: 4, campaigns_min: 4, sms: 2, sms_min: 2, flows: 3, flow_emails: 15, flow_emails_min: 15, notes: "", signed: true });
    expect(s.start).toBe("2026-12-01");
    expect(s.ongoing_tier).toBe("basic");
  });
});

describe("allotment pacing", () => {
  const a = (p: Partial<EmailAllotmentRow>) => toEmailAllotment(row({ campaigns_used: 0, campaigns_progress: 0, campaigns_done: 0, ...p }));
  it("gives the first days of a cycle grace", () => {
    expect(allotmentPace(a({}), new Date("2026-11-03T12:00:00"))).toBeNull();
  });
  it("measures used against the cycle, the top of each range, over the cap adding nothing", () => {
    const p = allotmentPace(a({ campaigns_used: 9, sms_used: 1 }), new Date("2026-11-16T12:00:00"))!;
    // caps 5 + 2 + 5 = 12; used counted at the cap: 5 + 1 = 6
    expect(p.used).toBeCloseTo(0.5, 2);
    expect(p.expected).toBeGreaterThan(0.45);
  });
  it("leaves out strategy-only clients and clients with nothing set", () => {
    expect(allotmentPace(a({ cap_source: "strategy" }), new Date("2026-11-20T12:00:00"))).toBeNull();
    expect(allotmentPace(a({ cap_source: null, campaigns_per_month: null, sms_per_month: null, flow_emails_per_month: null }), new Date("2026-11-20T12:00:00"))).toBeNull();
  });
  it("flags very behind past half the cycle, and anything short in the last week", () => {
    expect(veryBehind(a({ campaigns_used: 1 }), new Date("2026-11-10T12:00:00"))).toBeNull();
    expect(veryBehind(a({ campaigns_used: 1 }), new Date("2026-11-20T12:00:00"))?.kind).toBe("behind");
    expect(veryBehind(a({ campaigns_used: 3, sms_used: 2, flow_emails_used: 2 }), new Date("2026-11-27T12:00:00"))?.kind).toBe("last_week");
    expect(veryBehind(a({ campaigns_used: 5, sms_used: 2, flow_emails_used: 5 }), new Date("2026-11-27T12:00:00"))).toBeNull();
  });
});
