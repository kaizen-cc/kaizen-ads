import { describe, expect, it } from "vitest";
import { BATCH_MS, DEFAULT_PREFS, RING_MS, SETTLE_MS, STALE_MS, afterRing, cleanPrefs, decideHeadsUp, headsUpChat, headsUpLine, inQuietHours, isActive, itemLine, ringLeft, ringStep, type Presence, type RingState } from "@/lib/assistant/ring-core";

// Nov 18 2026, 15:00 New York (20:00 UTC)
const NOW = Date.parse("2026-11-18T20:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const here: Presence = { lastSeen: ago(5_000), visible: true, inCall: false };
const decide = (o: Partial<Parameters<typeof decideHeadsUp>[0]> = {}) => decideHeadsUp({ prefs: DEFAULT_PREFS, presence: here, now: NOW, oldestAt: ago(30_000), newestAt: ago(25_000), lastRingAt: null, ringing: false, ...o });

describe("who's in the app", () => {
  it("is active when seen in the last two minutes with the tab in view", () => {
    expect(isActive(here, NOW)).toBe(true);
    expect(isActive({ ...here, lastSeen: ago(3 * 60_000) }, NOW)).toBe(false);
    expect(isActive({ ...here, visible: false }, NOW)).toBe(false);
    expect(isActive(null, NOW)).toBe(false);
  });
});

describe("decideHeadsUp", () => {
  it("rings someone active", () => {
    expect(decide()).toEqual({ action: "ring" });
  });
  it("posts to the chat when they aren't in the app", () => {
    expect(decide({ presence: null })).toEqual({ action: "chat", why: "not_active" });
    expect(decide({ presence: { ...here, lastSeen: ago(10 * 60_000) } })).toEqual({ action: "chat", why: "not_active" });
  });
  it("never rings during a call or chat", () => {
    expect(decide({ presence: { ...here, inCall: true } })).toEqual({ action: "chat", why: "in_call" });
  });
  it("respects chat only and quiet hours", () => {
    expect(decide({ prefs: { ...DEFAULT_PREFS, mode: "chat" } })).toEqual({ action: "chat", why: "chat_only" });
    expect(decide({ prefs: { ...DEFAULT_PREFS, quietStart: "14:00", quietEnd: "16:00" } })).toEqual({ action: "chat", why: "quiet" });
    expect(decide({ prefs: { ...DEFAULT_PREFS, quietStart: "16:00", quietEnd: "17:00" } })).toEqual({ action: "ring" });
  });
  it("rings one at a time", () => {
    expect(decide({ ringing: true })).toEqual({ action: "wait", why: "ringing" });
  });
  it("waits a moment so a burst becomes one heads-up, but not forever", () => {
    expect(decide({ oldestAt: ago(10_000), newestAt: ago(2_000) })).toEqual({ action: "wait", why: "settling" });
    expect(decide({ oldestAt: ago(SETTLE_MS * 4), newestAt: ago(1_000) })).toEqual({ action: "ring" });
  });
  it("batches what lands just after a ring", () => {
    expect(decide({ lastRingAt: ago(60_000) })).toEqual({ action: "wait", why: "batching" });
    expect(decide({ lastRingAt: ago(BATCH_MS + 1_000) })).toEqual({ action: "ring" });
  });
  it("sends something already old to the chat instead of ringing", () => {
    expect(decide({ oldestAt: ago(STALE_MS + 1_000), newestAt: ago(STALE_MS) })).toEqual({ action: "chat", why: "stale" });
  });
});

describe("quiet hours", () => {
  it("handles hours past midnight and time zones", () => {
    const late = Date.parse("2026-11-19T03:30:00Z"); // 22:30 New York
    expect(inQuietHours({ quietStart: "21:00", quietEnd: "08:00", tz: "America/New_York" }, late)).toBe(true);
    expect(inQuietHours({ quietStart: "21:00", quietEnd: "08:00", tz: "America/New_York" }, NOW)).toBe(false);
    // 03:30 UTC is 04:30 in Madrid: inside 21:00 to 08:00 there too
    expect(inQuietHours({ quietStart: "21:00", quietEnd: "08:00", tz: "Europe/Madrid" }, late)).toBe(true);
    expect(inQuietHours({ quietStart: null, quietEnd: "08:00", tz: "America/New_York" }, late)).toBe(false);
  });
  it("cleans settings", () => {
    expect(cleanPrefs({ mode: "chat", quietStart: "9:05", quietEnd: "25:00", tz: "Nowhere" })).toEqual({ mode: "chat", quietStart: "09:05", quietEnd: null, tz: "America/New_York" });
    expect(cleanPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe("what the assistant says", () => {
  it("opens the call with the heads-up", () => {
    expect(headsUpLine("Santi", [{ title: "Sierra Dreams: needs 1 video and 5 statics by tomorrow." }])).toBe(
      "Hey Santi! Heads up, I just put something urgent on your board: Sierra Dreams needs 1 video and 5 statics by tomorrow. Want me to take you there now, or will you review it later?",
    );
  });
  it("lists several in one heads-up", () => {
    const line = headsUpLine("Santi", [{ title: "Acme: needs x" }, { title: "Bolt: needs y" }, { title: "Crust: needs z" }, { title: "Dune: needs w" }]);
    expect(line).toContain("4 urgent things");
    expect(line).toContain("Acme needs x; Bolt needs y; and Crust needs z, plus 1 more");
  });
  it("keeps a title's capital after the client", () => {
    expect(itemLine({ title: "Ocean Box: Billed but idle 9 days" })).toBe("Ocean Box: Billed but idle 9 days");
  });
  it("writes the chat version for a missed ring", () => {
    expect(headsUpChat("Santi", [{ title: "Sierra Dreams: needs 5 statics" }], "missed")).toBe("Hey Santi. I tried to call you about this. Something urgent landed on your board: **Sierra Dreams needs 5 statics**.");
    expect(headsUpChat("", [{ title: "A" }, { title: "B" }], "away")).toContain("2 urgent things landed on your board:\n- **A**\n- **B**");
  });
});

describe("the ring", () => {
  const idle: RingState = { phase: "idle" };
  it("rings, and is answered", () => {
    const r = ringStep(idle, { type: "ring", id: "h1", now: 0 });
    expect(r).toEqual({ phase: "ringing", id: "h1", since: 0 });
    expect(ringStep(r, { type: "answer" })).toEqual({ phase: "ended", id: "h1", outcome: "answered" });
  });
  it("is declined", () => {
    expect(ringStep(ringStep(idle, { type: "ring", id: "h1", now: 0 }), { type: "decline" })).toEqual({ phase: "ended", id: "h1", outcome: "declined" });
  });
  it("stops after ten seconds as a miss", () => {
    const r = ringStep(idle, { type: "ring", id: "h1", now: 1_000 });
    expect(ringStep(r, { type: "tick", now: 1_000 + RING_MS - 1 })).toBe(r);
    expect(ringLeft(r, 1_000 + 4_000)).toBe(6);
    expect(ringStep(r, { type: "tick", now: 1_000 + RING_MS })).toEqual({ phase: "ended", id: "h1", outcome: "missed" });
  });
  it("rings one at a time and ends once", () => {
    const r = ringStep(idle, { type: "ring", id: "h1", now: 0 });
    expect(ringStep(r, { type: "ring", id: "h2", now: 5 })).toBe(r);
    const ended = ringStep(r, { type: "decline" });
    expect(ringStep(ended, { type: "answer" })).toBe(ended);
    expect(ringStep(ended, { type: "tick", now: 99_999 })).toBe(ended);
    expect(ringStep(ended, { type: "reset" })).toEqual(idle);
  });
  it("an answer opens the call; a decline or a miss goes to the chat", () => {
    expect(afterRing("answered")).toBe("answered");
    expect(afterRing("declined")).toBe("chat");
    expect(afterRing("missed")).toBe("chat");
  });
});
