import { describe, expect, it } from "vitest";
import { runBounded } from "@/lib/bounded";
import { BEHIND_MS, googleClientHealth, parseCustomerId, plainGoogleError } from "@/lib/google-health";
import { FULL_EVERY_MS, klaviyoClientState, klaviyoCostMs, pickKlaviyoWindow, plainKlaviyoError } from "@/lib/klaviyo/core";

// Sync health for Google Ads and Klaviyo: each client's state (synced, failing, not connected), the failures in plain
// words with their fix, how much Klaviyo reads each run, and running clients side by side within a budget.

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("Google Ads: each client's state", () => {
  it("is not connected without a customer ID (an empty one on the KPI board included)", () => {
    expect(googleClientHealth({ accounts: [], runs: new Map(), now: NOW }).state).toBe("missing");
    expect(googleClientHealth({ accounts: [{ id: null, active: true }, { id: "", active: true }], runs: new Map(), now: NOW }).state).toBe("missing");
  });
  it("is synced with a recent clean sync, and says when", () => {
    const h = googleClientHealth({ accounts: [{ id: "123-456-7890", active: true }], runs: new Map([["1234567890", { at: ago(600_000), error: null }]]), now: NOW });
    expect(h.state).toBe("synced");
    expect(h.lastSync).toBe(ago(600_000));
    expect(h.accounts[0].id).toBe("123-456-7890");
  });
  it("is failing with the recorded error in plain words", () => {
    const h = googleClientHealth({ accounts: [{ id: "1234567890", active: true }], runs: new Map([["1234567890", { at: ago(600_000), error: "Google Ads can't see this account through our manager account. Link it to the MCC (or check the customer ID)." }]]), now: NOW });
    expect(h.state).toBe("failing");
    expect(h.error?.message).toBe("Kaizen's manager account can't reach 123-456-7890");
    expect(h.error?.fix).toMatch(/Link it in Google Ads/);
  });
  it("is behind after a day without a sync, and waiting before its first", () => {
    expect(googleClientHealth({ accounts: [{ id: "1234567890", active: true }], runs: new Map([["1234567890", { at: ago(BEHIND_MS + 60_000), error: null }]]), now: NOW }).state).toBe("behind");
    expect(googleClientHealth({ accounts: [{ id: "1234567890", active: true }], runs: new Map(), now: NOW }).state).toBe("pending");
  });
  it("takes the worst of its accounts, and ignores paused targets for the state", () => {
    const runs = new Map([
      ["1111111111", { at: ago(60_000), error: null }],
      ["2222222222", { at: ago(60_000), error: "Google Ads: CUSTOMER_NOT_ENABLED" }],
    ]);
    expect(googleClientHealth({ accounts: [{ id: "1111111111", active: true }, { id: "2222222222", active: true }], runs, now: NOW }).state).toBe("failing");
    expect(googleClientHealth({ accounts: [{ id: "1111111111", active: true }, { id: "2222222222", active: false }], runs, now: NOW }).state).toBe("synced");
  });
  it("fails every account when Kaizen's own sign-in isn't set up", () => {
    const h = googleClientHealth({ accounts: [{ id: "1234567890", active: true }], runs: new Map([["1234567890", { at: ago(60_000), error: null }]]), setupError: "Google Ads isn't connected yet (missing GOOGLE_ADS_LOGIN_CUSTOMER_ID (the MCC's ID))", now: NOW });
    expect(h.state).toBe("failing");
    expect(h.error?.message).toMatch(/sign-in isn't set up/);
  });
  it("reads a pasted customer ID", () => {
    expect(parseCustomerId(" 123 456 7890 ")).toEqual({ ok: true, id: "123-456-7890" });
    expect(parseCustomerId("12345").ok).toBe(false);
    expect(parseCustomerId("").ok).toBe(false);
  });
});

describe("Google Ads: failures in plain words", () => {
  it.each([
    ["Google Ads: The caller does not have permission (USER_PERMISSION_DENIED)", /manager account can't reach 123-456-7890/],
    ["This Google Ads account isn't enabled (cancelled or suspended).", /cancelled or suspended/],
    ["Google Ads: INVALID_CUSTOMER_ID", /isn't a Google Ads account/],
    ["Google sign-in failed: invalid_grant", /sign-in stopped working/],
    ["Our Google Cloud project only has Test access. Apply for Explorer access", /Test only/],
    ["Turn on the Google Ads API in the Google Cloud project our service account belongs to.", /API is off/],
    ["Google Ads: RESOURCE_EXHAUSTED quota", /daily API limit/],
    ["fetch failed", /didn't answer/],
  ])("%s", (raw, message) => {
    const p = plainGoogleError(raw, "1234567890");
    expect(p.message).toMatch(message);
    expect(p.fix.length).toBeGreaterThan(10);
    expect(p.message + p.fix).not.toMatch(/—/);
  });
  it("keeps Google's own words when it doesn't know the error", () => {
    expect(plainGoogleError("Google Ads: Something new happened", "1234567890").message).toBe("Something new happened");
  });
});

describe("Klaviyo: each client's state and failures", () => {
  it("is missing without a connection, connected with a recent read", () => {
    expect(klaviyoClientState(null, NOW).state).toBe("missing");
    expect(klaviyoClientState({ status: "active", lastSyncedAt: ago(60_000), error: null }, NOW)).toEqual({ state: "connected", error: null });
  });
  it("is failing when Klaviyo refused the key, with the fix", () => {
    const s = klaviyoClientState({ status: "invalid", lastSyncedAt: ago(60_000), error: "Klaviyo refused this key." }, NOW);
    expect(s.state).toBe("failing");
    expect(s.error?.message).toMatch(/revoked or deleted/);
    expect(s.error?.fix).toMatch(/new read-only private key/);
  });
  it("is failing when the key lacks a scope", () => {
    const s = klaviyoClientState({ status: "active", lastSyncedAt: ago(60_000), error: "This key can't read everything Kaizen Ads needs. Make a new private key with read access to accounts:read." }, NOW);
    expect(s.state).toBe("failing");
    expect(s.error?.fix).toMatch(/Read on Accounts, Campaigns/);
  });
  it("only warns when there's no Placed Order metric", () => {
    const s = klaviyoClientState({ status: "active", lastSyncedAt: ago(60_000), error: "No Placed Order metric in this account yet, so revenue can't be read." }, NOW);
    expect(s.state).toBe("connected");
    expect(s.error?.severity).toBe("warn");
  });
  it("is behind after a day, and pending before the first read", () => {
    expect(klaviyoClientState({ status: "active", lastSyncedAt: ago(27 * 3_600_000), error: null }, NOW).state).toBe("behind");
    expect(klaviyoClientState({ status: "active", lastSyncedAt: null, error: null }, NOW).state).toBe("pending");
  });
  it("never repeats a key in its messages", () => {
    expect(plainKlaviyoError("Klaviyo answered 500: pk_[redacted]")?.message).not.toMatch(/pk_[A-Za-z0-9]{8}/);
  });
});

describe("Klaviyo: recent or full read", () => {
  it("reads the full window first, then recent until a day has passed", () => {
    expect(pickKlaviyoWindow({ lastFullAt: null, now: NOW })).toBe("full");
    expect(pickKlaviyoWindow({ lastFullAt: ago(30 * 60_000), now: NOW })).toBe("recent");
    expect(pickKlaviyoWindow({ lastFullAt: ago(FULL_EVERY_MS - 60_000), now: NOW })).toBe("recent");
    expect(pickKlaviyoWindow({ lastFullAt: ago(FULL_EVERY_MS), now: NOW })).toBe("full");
    expect(pickKlaviyoWindow({ lastFullAt: "not a date", now: NOW })).toBe("full");
  });
  it("budgets more time for a full read", () => {
    expect(klaviyoCostMs("full")).toBeGreaterThan(klaviyoCostMs("recent"));
  });
});

describe("running clients side by side", () => {
  const tick = () => new Promise((r) => setTimeout(r, 1));
  it("never runs more than the limit at once and keeps every result", async () => {
    let running = 0;
    let peak = 0;
    const out = await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { limit: 3 }, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(out.done.map((d) => d.result).sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(out.skipped).toEqual([]);
  });
  it("doesn't start what wouldn't finish before the deadline, and hands it back", async () => {
    let clock = 0;
    const out = await runBounded(["a", "b", "c", "d"], { limit: 1, deadline: 250, cost: () => 100, now: () => clock }, async (x) => {
      clock += 100;
      return x;
    });
    expect(out.done.map((d) => d.item)).toEqual(["a", "b"]);
    expect(out.skipped).toEqual(["c", "d"]);
  });
  it("records a failure without stopping the rest", async () => {
    const out = await runBounded([1, 2, 3], { limit: 2 }, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(out.done.map((d) => d.item).sort()).toEqual([1, 3]);
    expect(out.failed).toEqual([{ item: 2, error: "boom" }]);
  });
});
