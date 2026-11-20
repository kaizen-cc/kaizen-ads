import { describe, expect, it } from "vitest";
import { callDestination, callOnToday, ownScore, OWN_FLOOR } from "@/lib/promise-today-core";
import { makerItem, csItem } from "@/lib/maker-day-core";

describe("your own promises and replies are critical (Nov 20 2026)", () => {
  it("an owed reply or a said-yes is always critical, at the top, and rises when late", () => {
    expect(ownScore("owed", { late: 0 })).toBeGreaterThanOrEqual(OWN_FLOOR);
    expect(ownScore("said", { late: 0 })).toBeGreaterThanOrEqual(OWN_FLOOR);
    expect(ownScore("said", { late: 3 })).toBeGreaterThan(ownScore("said", { late: 0 }));
    expect(ownScore("owed", { late: 0, escalated: true })).toBeGreaterThanOrEqual(96);
    // Never above a client on fire
    expect(ownScore("said", { late: 50 })).toBeLessThanOrEqual(98);
  });
  it("a call promise is critical when due or late, high the day before", () => {
    expect(ownScore("call", { late: 0, dueInDays: 0 })).toBeGreaterThanOrEqual(OWN_FLOOR);
    expect(ownScore("call", { late: 2 })).toBeGreaterThan(OWN_FLOOR);
    const soon = ownScore("call", { late: 0, dueInDays: 0.5 });
    expect(soon).toBeGreaterThanOrEqual(80);
    expect(soon).toBeLessThan(OWN_FLOOR);
  });
});

describe("which call promises reach your Today", () => {
  const now = Date.parse("2026-11-20T15:00:00Z");
  it("only yours, open, and due within a day or past due", () => {
    expect(callOnToday({ routedTo: ["me"], status: "open", dueAt: "2026-11-19T15:00:00Z" }, "me", now)).toBe(true);
    expect(callOnToday({ routedTo: ["me"], status: "open", dueAt: "2026-11-21T10:00:00Z" }, "me", now)).toBe(true);
    expect(callOnToday({ routedTo: ["me"], status: "open", dueAt: "2026-11-25T10:00:00Z" }, "me", now)).toBe(false);
    expect(callOnToday({ routedTo: ["someone"], status: "open", dueAt: "2026-11-19T15:00:00Z" }, "me", now)).toBe(false);
    expect(callOnToday({ routedTo: ["me"], status: "dismissed", dueAt: "2026-11-19T15:00:00Z" }, "me", now)).toBe(false);
    expect(callOnToday({ routedTo: ["me"], status: "done", dueAt: "2026-11-19T15:00:00Z" }, "me", now)).toBe(false);
  });
});

describe("where an update to the client goes", () => {
  it("the client's Slack channel, never Slack for an email-only client", () => {
    expect(callDestination({ slackChannelId: "C1", services: ["facebook-ads"], contactEmail: "a@b.co", subject: "x" })?.source).toBe("slack");
    const emailOnly = callDestination({ slackChannelId: "C1", services: ["email-marketing"], contactEmail: "a@b.co", subject: "Update" });
    expect(emailOnly?.source).toBe("gmail");
    expect(emailOnly?.url.startsWith("mailto:")).toBe(true);
    expect(callDestination({ slackChannelId: null, services: ["facebook-ads"], contactEmail: null, subject: "x" })).toBeNull();
  });
});

describe("every role sees their own call promises", () => {
  it("makers and the support positions let them through", () => {
    expect(makerItem("callp:123")).toBe(true);
    expect(csItem("callp:123")).toBe(true);
  });
});
