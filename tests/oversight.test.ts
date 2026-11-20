import { describe, expect, it } from "vitest";
import { econFlags, laborCost, monthly, payState, scorecard, visibleRows } from "@/lib/oversight/core";

const people = [
  { id: "h", name: "Head Meta", role: "head_of_meta", active: true },
  { id: "b1", name: "Buyer One", role: "media_buyer", active: true },
  { id: "b2", name: "Buyer Two", role: "media_buyer", active: true },
  { id: "gone", name: "Gone Buyer", role: "media_buyer", active: false },
  { id: "g", name: "Google Buyer", role: "google_buyer", active: true },
  { id: "d", name: "Designer", role: "graphic_designer", active: true },
];

describe("weekly scorecard", () => {
  const rows = scorecard({
    people,
    seats: [
      { client_id: "c1", profile_id: "b1", role: "meta_buyer" },
      { client_id: "c2", profile_id: "b1", role: "meta_buyer" },
      { client_id: "c3", profile_id: "b2", role: "meta_buyer" },
      { client_id: "c4", profile_id: "gone", role: "meta_buyer" },
      { client_id: "c1", profile_id: "g", role: "google_buyer" },
    ],
    missed: [{ profile_id: "b1", client_id: "c1" }, { profile_id: "b1", client_id: "c2" }, { profile_id: "gone", client_id: "c4" }],
    flags: [
      { client_id: "c1", kind: "unapproved_change", line: "facebook-ads" },
      { client_id: "c1", kind: "quiet_channel", line: null },
    ],
    atRisk: new Set(["c2"]),
  });
  it("ranks people by what went wrong, heads first with their line's totals", () => {
    expect(rows[0].id).toBe("h");
    expect(rows[0].team).toMatchObject({ people: 3, accounts: 3, missed: 2, unapproved: 1, busiest: 2, lightest: 0 });
    const b1 = rows.find((r) => r.id === "b1")!;
    expect(b1).toMatchObject({ accounts: 2, missed: 2, unapproved: 1, silent: 1, atRisk: 1 });
  });
  it("Meta's unapproved change isn't the Google buyer's", () => {
    expect(rows.find((r) => r.id === "g")).toMatchObject({ unapproved: 0, silent: 1 });
  });
  it("departed people and other roles aren't ranked", () => {
    expect(rows.some((r) => r.id === "gone" || r.id === "d")).toBe(false);
  });
  it("execs see everyone, a head their line, others nothing", () => {
    expect(visibleRows(rows, { isExec: true, role: "executive" })).toHaveLength(rows.length);
    expect(visibleRows(rows, { isExec: false, role: "head_of_meta" }).every((r) => r.line === "meta")).toBe(true);
    expect(visibleRows(rows, { isExec: false, role: "media_buyer" })).toEqual([]);
  });
});

describe("account economics", () => {
  it("monthly fees", () => {
    expect(monthly(1200, "year")).toBe(100);
    expect(monthly(750, "month")).toBe(750);
    expect(monthly(null, "month")).toBe(0);
  });
  it("labor cost at the rate in force", () => {
    const c = laborCost(
      [
        { profile_id: "a", started_at: "2026-11-10T10:00:00Z", duration_s: 7200 },
        { profile_id: "b", started_at: "2026-11-10T10:00:00Z", duration_s: 3600 },
      ],
      [
        { profile_id: "a", hourly_cost: 20, effective_from: "2026-01-01", effective_to: "2026-10-31" },
        { profile_id: "a", hourly_cost: 25, effective_from: "2026-11-01", effective_to: null },
      ],
    );
    expect(c).toEqual({ hours: 3, cost: 50, unrated: 1 });
  });
  const base = { fee: 1000, hours: 10, cost: 300, open: [], pastDue: false, failed: 0, uncollectible: 0, bestDeviation: null, idleBilled: false, today: "2026-11-20" };
  it("losing money, underpriced, billed with no work, unpaid", () => {
    expect(econFlags({ ...base, cost: 1400 }).map((f) => f.kind)).toEqual(["losing"]);
    expect(econFlags({ ...base, bestDeviation: -0.6 }).map((f) => f.kind)).toEqual(["underpriced"]);
    expect(econFlags({ ...base, hours: 0, cost: 0, idleBilled: true })[0]).toMatchObject({ kind: "no_work", confidence: "likely" });
    expect(econFlags({ ...base, open: [{ amount: 1000, due: "2026-11-10" }] })[0].text).toMatch(/\$1,000 open, past due/);
    expect(econFlags({ ...base, failed: 2 })[0].text).toMatch(/2 failed charges/);
    expect(econFlags(base)).toEqual([]);
  });
  it("pay state", () => {
    expect(payState({ ...base })).toBe("paid");
    expect(payState({ ...base, open: [{ amount: 5, due: "2026-12-01" }] })).toBe("unpaid");
    expect(payState({ ...base, pastDue: true })).toBe("overdue");
  });
});
