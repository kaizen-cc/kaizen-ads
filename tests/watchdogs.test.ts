import { describe, expect, it } from "vitest";
import { accountStatusIssue, bigDatesAhead, isAccessError, isAccessRemoval, isAuthError, isDogKind, missingSpecialCategory, pageProblems, pastEvent, quietFor, resultsOf, siteDown, stuckDays, zeroOutcome } from "@/lib/watchdogs/core";
import { overspend } from "@/lib/account-watch/core";

describe("ads past their event", () => {
  it("Halloween ads in November", () => {
    expect(pastEvent("Spooky Halloween sale 20% off", "2026-11-20")).toMatchObject({ event: "Halloween", date: "2026-10-31" });
  });
  it("Black Friday run-up is fine, and a few days after", () => {
    expect(pastEvent("Black Friday early access", "2026-11-20")).toBeNull();
    expect(pastEvent("Black Friday deals", "2026-11-29")).toBeNull();
    expect(pastEvent("Black Friday deals", "2026-12-10")).toMatchObject({ event: "Black Friday" });
  });
  it("next year's run-up isn't past", () => {
    expect(pastEvent("Valentine's gift guide", "2027-01-20")).toBeNull();
  });
  it("explicit past dates", () => {
    expect(pastEvent("Event on Nov 8 - book now", "2026-11-20")).toMatchObject({ date: "2026-11-08" });
    expect(pastEvent("Open house 11/22", "2026-11-20")).toBeNull();
    expect(pastEvent("Evergreen offer", "2026-11-20")).toBeNull();
  });
});

describe("special ad categories", () => {
  it("housing, employment and credit without the category", () => {
    expect(missingSpecialCategory("Luxury apartments now leasing", [])?.label).toBe("housing");
    expect(missingSpecialCategory("We're hiring line cooks", ["NONE"])?.label).toBe("employment");
    expect(missingSpecialCategory("Auto loans with low APR", null)?.label).toBe("credit");
  });
  it("set correctly, or nothing special", () => {
    expect(missingSpecialCategory("Luxury apartments now leasing", ["HOUSING"])).toBeNull();
    expect(missingSpecialCategory("Auto loans", ["CREDIT"])).toBeNull();
    expect(missingSpecialCategory("Burgers and fries, 2 for $10", [])).toBeNull();
  });
});

describe("account status", () => {
  it("payment failing and suspensions", () => {
    expect(accountStatusIssue({ account_status: 3 }, true)?.kind).toBe("payment_issue");
    expect(accountStatusIssue({ account_status: 9 }, true)?.kind).toBe("payment_issue");
    expect(accountStatusIssue({ account_status: 2, disable_reason: 1 }, true)?.kind).toBe("delivery_issue");
    expect(accountStatusIssue({ account_status: 1, funding_source: null }, true)?.title).toMatch(/No payment method/);
    expect(accountStatusIssue({ account_status: 1, funding_source: "123" }, true)).toBeNull();
    expect(accountStatusIssue({ account_status: 1 }, true)).toBeNull();
    expect(accountStatusIssue(null, true)).toBeNull();
  });
  it("access and authorization", () => {
    expect(isAccessRemoval("Removed admin permissions for John")).toBe(true);
    expect(isAccessRemoval("Ad set budget changed")).toBe(false);
    expect(isAccessError("(#200) Ad account owner has NOT grant ads_management or ads_read permission")).toBe(true);
    expect(isAccessError("Timeout")).toBe(false);
    expect(isAuthError("401 Unauthorized: the API key was revoked")).toBe(true);
    expect(isAuthError("rate limited")).toBe(false);
  });
});

describe("spend with nothing to show", () => {
  it("clicks but no landing page views", () => {
    expect(zeroOutcome({ spend: 200, linkClicks: 40, landingPageViews: 0, results: 3 }, { expectsSite: true })?.kind).toBe("no_lpv");
  });
  it("no results", () => {
    expect(zeroOutcome({ spend: 200, linkClicks: 40, landingPageViews: 30, results: 0 }, { expectsSite: true })?.kind).toBe("no_results");
  });
  it("small spend is left alone", () => {
    expect(zeroOutcome({ spend: 40, linkClicks: 40, landingPageViews: 0, results: 0 }, { expectsSite: true })).toBeNull();
  });
  it("reads results from Meta actions", () => {
    expect(resultsOf({ lead: 4, link_click: 30 })).toBe(4);
    expect(resultsOf({ link_click: 30 })).toBe(0);
  });
});

describe("thresholds", () => {
  it("5 days silent", () => {
    expect(quietFor(5)).toBe(true);
    expect(quietFor(4)).toBe(false);
    expect(quietFor(null)).toBe(true);
  });
  it("7 days stuck creative", () => {
    expect(stuckDays("in_production", "2026-11-13T10:00:00Z", "2026-11-20")).toBe(7);
    expect(stuckDays("in_production", "2026-11-14T10:00:00Z", "2026-11-20")).toBeNull();
    expect(stuckDays("launched", "2026-10-01T10:00:00Z", "2026-11-20")).toBeNull();
  });
  it("20% over budget", () => {
    expect(overspend({ mtd: 1210, budget: 1000, dayOfMonth: 30, daysInMonth: 30 }).over).toBe(true);
    expect(overspend({ mtd: 1150, budget: 1000, dayOfMonth: 30, daysInMonth: 30 }).over).toBe(false);
  });
  it("BFCM about 10 days out", () => {
    const a = bigDatesAhead("2026-11-20");
    expect(a.map((x) => x.key)).toEqual(["black_friday", "cyber_monday"]);
    expect(a[0].date).toBe("2026-11-27");
    expect(a[1].date).toBe("2026-11-30");
    expect(bigDatesAhead("2026-11-10")).toEqual([]);
  });
});

describe("websites", () => {
  it("two misses in a row is down", () => {
    expect(siteDown([{ ok: false, status: 503, ms: 1 }, { ok: false, status: null, ms: 1 }])).toBe(true);
    expect(siteDown([{ ok: false, status: 503, ms: 1 }, { ok: true, status: 200, ms: 1 }])).toBe(false);
    expect(siteDown([{ ok: false, status: 503, ms: 1 }])).toBe(false);
  });
  it("the weekly page check", () => {
    expect(pageProblems("<html><title>Shop</title><body>Error establishing a database connection</body></html>", 200)).toContain("shows an error or maintenance page");
    const good = `<html><head><title>Shop</title></head><body><img src="a.jpg">${"Great products for you. ".repeat(40)}</body></html>`;
    expect(pageProblems(good, 200)).toEqual([]);
  });
  it("every watchdog kind is known", () => {
    expect(isDogKind("quiet_channel")).toBe(true);
    expect(isDogKind("idle")).toBe(false);
  });
});

import { conversionGap, cvrDrop, trackingProblems } from "@/lib/watchdogs/core";

describe("tracking", () => {
  it("keeps the audit's tracking problems, drops the all-clear lines", () => {
    const p = trackingProblems(["Both pixels last fired 48 days ago.", "Tracking looks clean on the lead form.", "No Conversions API events reach the dataset.", 5]);
    expect(p).toHaveLength(2);
    expect(trackingProblems(null)).toEqual([]);
  });
  it("platform vs store", () => {
    expect(conversionGap({ meta: 40, google: 0, store: 20 })?.kind).toBe("over");
    expect(conversionGap({ meta: 20, google: 15, store: 22 })?.kind).toBe("double");
    expect(conversionGap({ meta: 3, google: 0, store: 60 })?.kind).toBe("under");
    expect(conversionGap({ meta: 20, google: 0, store: 22 })).toBeNull();
    expect(conversionGap({ meta: 2, google: 1, store: 3 })).toBeNull();
  });
  it("conversion rate dropping abnormally", () => {
    expect(cvrDrop({ recentClicks: 100, recentResults: 1, baseClicks: 1000, baseResults: 50 })).not.toBeNull();
    expect(cvrDrop({ recentClicks: 100, recentResults: 4, baseClicks: 1000, baseResults: 50 })).toBeNull();
    expect(cvrDrop({ recentClicks: 30, recentResults: 0, baseClicks: 1000, baseResults: 50 })).toBeNull();
  });
});
