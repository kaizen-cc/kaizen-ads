import { describe, expect, it } from "vitest";
import { clientOfEvent, healthOf, sortHealth, type ClientMatch } from "@/lib/integration-health/core";

const now = new Date("2026-11-24T20:00:00Z");

describe("integration health", () => {
  it("connected and fresh is fine", () => {
    expect(healthOf({ kind: "meta", connected: true, lastAt: "2026-11-24T14:00:00Z" }, now).state).toBe("ok");
  });
  it("disconnected, auth errors, and expired tokens", () => {
    expect(healthOf({ kind: "shopify", connected: true, status: "disconnected" }, now).state).toBe("disconnected");
    expect(healthOf({ kind: "klaviyo", connected: true, error: "401 Unauthorized: invalid API key" }, now).state).toBe("disconnected");
    expect(healthOf({ kind: "motion", connected: true, expiresAt: "2026-11-23T10:00:00Z", lastAt: "2026-11-24T10:00:00Z" }, now).state).toBe("disconnected");
    expect(healthOf({ kind: "motion", connected: true, expiresAt: "2026-11-23T10:00:00Z", refreshes: true, lastAt: "2026-11-24T10:00:00Z" }, now).state).toBe("ok");
  });
  it("other errors and stale reads", () => {
    expect(healthOf({ kind: "google", connected: true, error: "Rate exceeded" }, now).state).toBe("error");
    const st = healthOf({ kind: "meta", connected: true, lastAt: "2026-11-21T20:00:00Z" }, now);
    expect(st).toMatchObject({ state: "stale", detail: "Meta Ads last read 3 days ago" });
    expect(healthOf({ kind: "tiktok", connected: true }, now).state).toBe("stale");
  });
  it("worst first", () => {
    const hs = sortHealth([healthOf({ kind: "meta", connected: true, lastAt: "2026-11-24T19:00:00Z" }, now), healthOf({ kind: "motion", connected: false }, now)]);
    expect(hs[0].kind).toBe("motion");
  });
});

describe("tomorrow's client calls", () => {
  const clients: ClientMatch[] = [
    { id: "a", name: "Crust Pizza", emails: ["owner@crustpizza.com"], domains: ["crustpizza.com"] },
    { id: "b", name: "Crust Pizza - Gleannloch", emails: [], domains: [] },
    { id: "c", name: "CheckPilot", emails: ["sam@gmail.com"], domains: [] },
  ];
  it("by a contact's email or company domain", () => {
    expect(clientOfEvent({ id: "1", summary: "Weekly", attendees: [{ email: "me@kaizenmarketing.agency" }, { email: "ops@crustpizza.com" }] }, clients)?.id).toBe("a");
    expect(clientOfEvent({ id: "2", summary: "Sync", attendees: [{ email: "sam@gmail.com" }] }, clients)?.id).toBe("c");
  });
  it("a shared personal domain never matches a company", () => {
    expect(clientOfEvent({ id: "3", summary: "Coffee", attendees: [{ email: "someone@gmail.com" }] }, clients)).toBeNull();
  });
  it("by name in the title, longest name first", () => {
    expect(clientOfEvent({ id: "4", summary: "Crust Pizza - Gleannloch monthly review" }, clients)?.id).toBe("b");
    expect(clientOfEvent({ id: "5", summary: "CheckPilot | Kaizen" }, clients)?.id).toBe("c");
    expect(clientOfEvent({ id: "6", summary: "Checkpoint planning" }, clients)).toBeNull();
  });
  it("cancelled events never match", () => {
    expect(clientOfEvent({ id: "7", summary: "CheckPilot", status: "cancelled" }, clients)).toBeNull();
  });
});
