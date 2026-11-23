import { describe, expect, it } from "vitest";
import { topicGroups } from "@/lib/today-counts";
import { atRung3, capTab, chainLabel, execHears, groupEscalated, headerParts, inMotion, openingTab, sortNeeds, type ExecCard, type Rung3Row } from "@/lib/exec-overview-core";

const now = new Date("2026-11-23T15:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe("the ladder's third rung", () => {
  it("reaches the execs 48 hours after it reached the lead with nothing moving", () => {
    expect(atRung3({ createdAt: hoursAgo(49) }, false, now)).toBe(true);
    expect(atRung3({ createdAt: hoursAgo(30) }, false, now)).toBe(false);
  });
  it("any touch resets the clock: a comment, the lead's nudge sent", () => {
    expect(atRung3({ createdAt: hoursAgo(100), movedAt: hoursAgo(10) }, false, now)).toBe(false);
    expect(atRung3({ createdAt: hoursAgo(100), sentAt: hoursAgo(20) }, false, now)).toBe(false);
    expect(atRung3({ createdAt: hoursAgo(100), sentAt: hoursAgo(60) }, false, now)).toBe(true);
  });
  it("waiting on the client pauses it entirely", () => {
    expect(atRung3({ createdAt: hoursAgo(500) }, true, now)).toBe(false);
  });
});

const row = (o: Partial<Rung3Row> & { id: string }): Rung3Row => ({
  itemKey: `ticket:${o.id}`,
  clientId: "c1",
  client: "Acme",
  ownerId: "mel",
  owner: "Mel Crosson",
  leadId: "lead-email",
  lead: "Dana Head",
  leadRole: "head_of_email",
  leadLabel: "Head of Email",
  what: "Email #12 Black Friday",
  since: hoursAgo(120),
  reachedLead: hoursAgo(72),
  line: "email",
  href: "/board/email?t=12",
  ...o,
});

describe("Escalated: one card per client", () => {
  it("gathers a client's stuck items into one card with who had it and for how long", () => {
    const cards = groupEscalated([row({ id: "1" }), row({ id: "2", what: "Email #13 Cyber Monday" }), row({ id: "3" })], [], now);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Acme: 3 stuck");
    expect(cards[0].detail).toContain("with Mel 5d → Head of Email 3d");
    expect(cards[0].nudgeIds).toEqual(["1", "2", "3"]);
    expect(cards[0].draft).toMatch(/^Hey Dana, Acme has 3 things stuck/);
  });
  it("collapses a lead with more than 5 stuck items into one team card", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ id: String(i), clientId: `c${i}`, client: `Client ${i}`, ...(i < 6 ? {} : { ownerId: "sam", owner: "Sam Lee" }) }));
    const cards = groupEscalated(rows, [], now);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("team");
    expect(cards[0].title).toBe("Email team: 9 stuck, 6 with Mel");
  });
  it("fires skip the ladder, lead the tab, and merge with a client's stuck work", () => {
    const cards = groupEscalated([row({ id: "1" })], [{ clientId: "c1", client: "Acme", why: "said they may cancel or leave", href: "/clients/acme" }, { clientId: "c2", client: "Beta", why: "Meta ad account disabled", href: null, clientSlug: "beta" }], now);
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.severity === "fire")).toBe(true);
    expect(cards.find((c) => c.clientId === "c1")?.title).toBe("Acme is on fire: said they may cancel or leave");
    expect(cards.find((c) => c.clientId === "c2")?.action.href).toBe("/clients/beta");
  });
  it("says who had it", () => {
    expect(chainLabel({ owner: "Mel Crosson", since: hoursAgo(24 * 5), leadLabel: "Head of Email", reachedLead: hoursAgo(24 * 3) }, now)).toBe("with Mel 5d → Head of Email 3d");
  });
});

describe("which exec hears it", () => {
  it("by their focus lines", () => {
    expect(execHears("email", ["email"])).toBe(true);
    expect(execHears("meta", ["email"])).toBe(false);
    expect(execHears("meta", ["meta", "google", "tiktok", "creative_performance"])).toBe(true);
    // Creative production is the creative exec's, not the paid-ads exec's (creative performance)
    expect(execHears("creative", ["meta", "google", "tiktok", "creative_performance"])).toBe(false);
    expect(execHears("creative", ["social", "creative"])).toBe(true);
    // No focus set: everything
    expect(execHears("social", [])).toBe(true);
  });
});

const card = (o: Partial<ExecCard>): ExecCard => ({ key: "k", tab: "needs", kind: "owed", client: null, clientId: null, title: "t", detail: "d", severity: "normal", action: { label: "Open", href: null }, ...o });

describe("the header and the opening tab", () => {
  it("one line, each part opening its tab", () => {
    expect(headerParts({ needs: 3, fires: 0, stuck: 2, accounts: 1 }).map((p) => p.text).join(" · ")).toBe("3 need you · 2 stuck with leads · 1 account to step into");
    expect(headerParts({ needs: 1, fires: 1, stuck: 0, accounts: 0 }).map((p) => [p.tab, p.text])).toEqual([
      ["escalated", "1 on fire"],
      ["needs", "1 needs you"],
    ]);
    expect(headerParts({ needs: 0, fires: 0, stuck: 0, accounts: 0 })).toEqual([]);
  });
  it("opens where the most critical thing is", () => {
    expect(openingTab({ needs: [card({})], escalated: [card({ tab: "escalated", severity: "fire" })] })).toBe("escalated");
    expect(openingTab({ needs: [card({ due: hoursAgo(5) })], escalated: [card({ tab: "escalated", severity: "critical" })] })).toBe("needs");
    expect(openingTab({ needs: [card({})], escalated: [card({ tab: "escalated", severity: "critical" })] })).toBe("escalated");
    expect(openingTab({ needs: [], escalated: [], accounts: [card({ tab: "accounts" })] })).toBe("accounts");
    expect(openingTab({})).toBe("needs");
  });
  it("5 cards a tab, the rest behind N more", () => {
    expect(capTab([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(capTab([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  });
  it("Needs me by due date, overdue first, undated last", () => {
    const sorted = sortNeeds([card({ key: "none" }), card({ key: "late", due: hoursAgo(48) }), card({ key: "soon", due: hoursAgo(-5) })]);
    expect(sorted.map((c) => c.key)).toEqual(["late", "soon", "none"]);
  });
});

describe("in motion: the team already handling an account", () => {
  it("a sprint a person moved or started this week, or a person's recent audit; the system's own checks don't count", () => {
    expect(inMotion({ sprints: [{ status: "active", lastActionAt: hoursAgo(48), startedAt: hoursAgo(24 * 40) }], audits: [] }, now)).toMatch(/sprint/);
    expect(inMotion({ sprints: [{ status: "active", startedAt: hoursAgo(24 * 3) }], audits: [] }, now)).toMatch(/sprint/);
    expect(inMotion({ sprints: [{ status: "active", lastActionAt: hoursAgo(24 * 20), startedAt: hoursAgo(24 * 40) }], audits: [] }, now)).toBeNull();
    expect(inMotion({ sprints: [], audits: [{ createdAt: hoursAgo(24 * 3), auto: true }] }, now)).toBeNull();
    expect(inMotion({ sprints: [], audits: [{ createdAt: hoursAgo(24 * 3), auto: false }] }, now)).toMatch(/Audited/);
  });
});

describe("the exec recap plays in the tabs' order", () => {
  const it2 = (topic: "needs" | "escalated" | "accounts" | "pulse" | "system" | "promises", score: number) => ({ topic, client: topic, tier: "normal" as const, score });
  it("Needs me, Escalated, Accounts, Pulse, System, whatever the scores", () => {
    expect(topicGroups([it2("pulse", 30), it2("escalated", 99), it2("system", 80), it2("accounts", 70), it2("needs", 64)]).map((g) => g.topic)).toEqual(["needs", "escalated", "accounts", "pulse", "system"]);
  });
  it("everyone else's day stays most critical first", () => {
    expect(topicGroups([it2("accounts", 70), it2("promises", 95)]).map((g) => g.topic)).toEqual(["promises", "accounts"]);
  });
});
