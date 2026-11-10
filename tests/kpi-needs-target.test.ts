import { describe, expect, it } from "vitest";
import { computeSnapshot, hasKpiTarget, shownStatus, type Day } from "@/lib/kpi/calc";
import { successOf } from "@/lib/kpi/success";
import { STATUS } from "@/lib/kpi/format";
import { missingKpiCards, type EnsureClient } from "@/lib/kpi/ensure";
import { auditRefusal } from "@/lib/audit-queue";

// A client running ads with no KPI set has a real card: every number, never judged, no audit until the KPI is set

const NOW = new Date("2026-10-15T16:00:00Z");
const day = (date: string, spend: number, purchases: number): Day => ({ date, spend, actions: { omni_purchase: purchases }, values: {} });
const client = (over: Partial<EnsureClient> = {}): EnsureClient => ({ id: "c1", status: "active", archived_at: null, meta_ad_account_id: "act_123", services: ["facebook-ads"], services_extra: [], services_removed: [], ...over });

describe("which clients get a KPI card", () => {
  it("one per ad service with no active KPI, owned by the seat's primary buyer", () => {
    const seats = [
      { client_id: "c1", profile_id: "second", role: "meta_buyer", is_primary: false, created_at: "2026-01-01" },
      { client_id: "c1", profile_id: "lead", role: "meta_buyer", is_primary: true, created_at: "2026-02-01" },
      { client_id: "c1", profile_id: "g", role: "google_buyer", is_primary: true, created_at: "2026-02-01" },
    ];
    const cards = missingKpiCards(client({ services: ["facebook-ads", "creative"], services_extra: ["google-ads"] }), [], seats);
    expect(cards).toEqual([
      { client_id: "c1", platform: "meta", ad_account_id: "123", conversion: "campaign_goal", target: null, monthly_budget: null, owner_id: "lead", source: "strategy" },
      { client_id: "c1", platform: "google", ad_account_id: null, conversion: "campaign_goal", target: null, monthly_budget: null, owner_id: "g", source: "strategy" },
    ]);
  });

  it("none where a KPI is already active on that platform", () => {
    expect(missingKpiCards(client(), [{ platform: "meta", active: true, ad_account_id: "123" }], [])).toEqual([]);
  });

  it("an inactive one doesn't count, and Google reuses the account an old KPI knew", () => {
    const cards = missingKpiCards(client({ services: ["google-ads"] }), [{ platform: "google", active: false, ad_account_id: "269-856-4936", updated_at: "2026-09-01" }], []);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ platform: "google", ad_account_id: "269-856-4936", owner_id: null });
  });

  it("a removed service, an archived, paused or offboarded client gets none", () => {
    expect(missingKpiCards(client({ services_removed: ["facebook-ads"] }), [], [])).toEqual([]);
    expect(missingKpiCards(client({ archived_at: "2026-10-01" }), [], [])).toEqual([]);
    expect(missingKpiCards(client({ status: "paused" }), [], [])).toEqual([]);
    expect(missingKpiCards(client({ status: "offboarded" }), [], [])).toEqual([]);
    expect(missingKpiCards(client({ status: "onboarding" }), [], [])).toHaveLength(1);
  });

  it("a client without ad services gets none", () => {
    expect(missingKpiCards(client({ services: ["creative", "email"] }), [], [])).toEqual([]);
  });
});

describe("no KPI set is neutral", () => {
  it("a snapshot without a target is never judged, however bad the numbers", () => {
    const days = Array.from({ length: 14 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 500, 0));
    const s = computeSnapshot(days, { conversion: "purchases", target: null, budget: null, now: NOW });
    expect(s.status).toBe("unset");
    expect(s.deviation).toBeNull();
    // Every number is still there
    expect(s.windows.d14.spend).toBeGreaterThan(0);
    expect(s.months.mtd.spend).toBeGreaterThan(0);
    expect(s.budget).toBeNull();
  });

  it("an older snapshot that says off (judged on the benchmark) shows as no KPI set", () => {
    expect(shownStatus("off", null)).toBe("unset");
    expect(shownStatus("close", null)).toBe("unset");
    expect(shownStatus("excellent", undefined)).toBe("unset");
    expect(shownStatus("idle", null)).toBe("unset");
  });

  it("a setup problem stays setup; a target judges as before", () => {
    expect(shownStatus("setup", null)).toBe("setup");
    expect(shownStatus(null, null)).toBe("setup");
    expect(shownStatus("off", 45)).toBe("off");
    expect(shownStatus("good", "45")).toBe("good");
    // A target just set, before its first recompute
    expect(shownStatus("unset", 45)).toBe("setup");
  });

  it("no verdict, no colors", () => {
    expect(successOf("unset", "slipping", 0.5)).toBeNull();
    expect(STATUS.unset.label).toBe("No KPI set");
    expect(STATUS.unset.tone).not.toMatch(/bad|warn|ok/);
  });

  it("what counts as a target", () => {
    expect(hasKpiTarget(null)).toBe(false);
    expect(hasKpiTarget(undefined)).toBe(false);
    expect(hasKpiTarget(0)).toBe(false);
    expect(hasKpiTarget(45)).toBe(true);
    expect(hasKpiTarget("3.5")).toBe(true);
  });
});

describe("audits wait for the KPI", () => {
  it("refuses an audit with no target: Set the KPI first", () => {
    expect(auditRefusal({ platform: "meta", ad_account_id: "123", target: null })).toBe("Set the KPI first.");
    expect(auditRefusal({ platform: "google", ad_account_id: "2698564936", target: null })).toBe("Set the KPI first.");
  });

  it("still needs an ad account on a platform we read", () => {
    expect(auditRefusal({ platform: "meta", ad_account_id: null, target: 40 })).toBe("This KPI has no ad account to audit.");
    expect(auditRefusal({ platform: "linkedin", ad_account_id: "7", target: 40 })).toBe("This KPI has no ad account to audit.");
    expect(auditRefusal({ platform: "tiktok", ad_account_id: "7", target: 40 })).toBeNull();
  });

  it("runs with a target and an account", () => {
    expect(auditRefusal({ platform: "meta", ad_account_id: "123", target: 40 })).toBeNull();
    expect(auditRefusal({ platform: "google", ad_account_id: "2698564936", target: "3.2" })).toBeNull();
  });
});
