import { describe, expect, it } from "vitest";
import { emailBadWeek, execSees, nextStatus, perExec, severityOf, suggestStep, trendOf, type Reason } from "@/lib/stepins/core";

const fire: Reason = { kind: "fire", line: null, title: "On fire: said they may cancel or leave", detail: "" };
const meta: Reason = { kind: "account", line: "meta", title: "Meta 62% off target for 9 days, nothing in motion", detail: "" };
const email: Reason = { kind: "email", line: "email", title: "Email score in the red all week (41)", detail: "" };

describe("who sees which step-in", () => {
  it("fires reach every exec; the rest by focus line", () => {
    expect(execSees([fire], ["email"])).toBe(true);
    expect(execSees([meta], ["email"])).toBe(false);
    expect(execSees([meta], ["meta", "google", "tiktok", "creative_performance"])).toBe(true);
    expect(execSees([email], ["email"])).toBe(true);
    expect(execSees([meta], [])).toBe(true);
  });
  it("counts per exec", () => {
    expect(perExec([{ reasons: [fire] }, { reasons: [meta] }, { reasons: [email] }], [{ name: "Paid", focus: ["meta", "google"] }, { name: "Email", focus: ["email"] }])).toEqual({ Paid: 2, Email: 2 });
  });
});

describe("the living card", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  it("opens, stays open, recovers", () => {
    expect(nextStatus(null, { qualifies: true, fire: false, now })).toMatchObject({ status: "open" });
    expect(nextStatus(null, { qualifies: false, fire: false, now })).toBeNull();
    expect(nextStatus({ status: "open" }, { qualifies: false, fire: false, now })).toMatchObject({ status: "recovered", closed: true });
  });
  it("reopens when it slides again", () => {
    expect(nextStatus({ status: "recovered" }, { qualifies: true, fire: false, now })).toMatchObject({ status: "open", reopened: true });
  });
  it("handled stays handled for a week unless a new fire appears", () => {
    const handledAt = "2026-11-21T12:00:00Z";
    expect(nextStatus({ status: "handled", handledAt, hadFire: false }, { qualifies: true, fire: false, now })).toMatchObject({ status: "handled" });
    expect(nextStatus({ status: "handled", handledAt, hadFire: false }, { qualifies: true, fire: true, now })).toMatchObject({ status: "open", reopened: true });
    expect(nextStatus({ status: "handled", handledAt: "2026-11-10T12:00:00Z", hadFire: false }, { qualifies: true, fire: false, now })).toMatchObject({ status: "open", reopened: true });
  });
});

describe("the rules", () => {
  it("fires rank first", () => {
    expect(severityOf([fire])).toBeGreaterThan(severityOf([meta, email]));
    expect(severityOf([])).toBe(0);
  });
  it("email red all week", () => {
    const days = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"].map((d) => ({ day: d, score: 45 }));
    expect(emailBadWeek(days, "2026-11-23")).toMatchObject({ days: 6, score: 45 });
    expect(emailBadWeek([...days.slice(0, 5), { day: "2026-11-22", score: 70 }], "2026-11-23")).toBeNull();
    expect(emailBadWeek(days.slice(0, 3), "2026-11-23")).toBeNull();
  });
  it("trend", () => {
    expect(trendOf({ d7: 80, d30: 50, roas: false })).toBe("worse");
    expect(trendOf({ d7: 3, d30: 2, roas: true })).toBe("better");
    expect(trendOf({ d7: 51, d30: 50, roas: false })).toBe("flat");
    expect(trendOf({ d7: null, d30: 50, roas: false })).toBeNull();
  });
  it("a suggested step-in", () => {
    expect(suggestStep([fire, meta], "Ana")).toMatch(/Call the client yourself/);
    expect(suggestStep([meta], "Ana")).toMatch(/15 minutes with Ana/);
  });
});

import { stepinWorthy } from "@/lib/stepins/core";

describe("items stuck past the lead", () => {
  it("unsent reports never make a step-in; client-facing items do; other items need two on a client", () => {
    const rows = [
      { itemKey: "report:1", kind: "other", clientId: "a" },
      { itemKey: "report:2", kind: "other", clientId: "a" },
      { itemKey: "owed:3", kind: "owed", clientId: "b" },
      { itemKey: "ticket:4", kind: "other", clientId: "c" },
      { itemKey: "ticket:5", kind: "other", clientId: "d" },
      { itemKey: "ticket:6", kind: "other", clientId: "d" },
    ];
    expect(stepinWorthy(rows).map((r) => r.itemKey)).toEqual(["owed:3", "ticket:5", "ticket:6"]);
  });
});
