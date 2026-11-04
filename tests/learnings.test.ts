import { describe, expect, it } from "vitest";
import { applies, conditionFit, pickWinner, rankLearnings, widenScope, type Learning } from "@/lib/learning-rank";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const base: Learning = { id: "x", agentKey: "copy", scope: "client", clientId: "c1", model: "restaurant", verticalId: "v1", kind: "lesson", condition: null, lesson: "L", confidence: 0.6, evidence: 1, evidenceClients: ["c1"], lastSeen: "2026-11-01T00:00:00Z" };
const l = (p: Partial<Learning>): Learning => ({ ...base, ...p });

describe("which learnings a call sees", () => {
  it("keeps a client's lesson and a one-off exception to that client", () => {
    expect(applies(l({}), { clientId: "c1", model: null, verticalId: null })).toBe(true);
    expect(applies(l({}), { clientId: "c2", model: "restaurant", verticalId: "v1" })).toBe(false);
    expect(applies(l({ kind: "exception", scope: "everyone" }), { clientId: "c2", model: null, verticalId: null })).toBe(false);
  });

  it("matches sub-vertical, business model (either of two) and everyone", () => {
    expect(applies(l({ scope: "vertical", clientId: null, verticalId: "v1" }), { clientId: "c9", model: null, verticalId: "v1" })).toBe(true);
    expect(applies(l({ scope: "vertical", clientId: null, verticalId: "v1" }), { clientId: "c9", model: null, verticalId: "v2" })).toBe(false);
    expect(applies(l({ scope: "model", clientId: null, model: "lead_gen" }), { clientId: "c9", model: "restaurant", also: "lead_gen", verticalId: null })).toBe(true);
    expect(applies(l({ scope: "everyone", clientId: null }), { clientId: null, model: null, verticalId: null })).toBe(true);
  });

  it("ranks the specific, proven and on-topic first and caps the count", () => {
    const list = [
      l({ id: "everyone", scope: "everyone", clientId: null, evidence: 9 }),
      l({ id: "client", evidence: 1 }),
      l({ id: "video", condition: "top-of-funnel video ads", evidence: 1 }),
      ...Array.from({ length: 12 }, (_, i) => l({ id: `m${i}`, scope: "model", clientId: null, model: "restaurant" })),
    ];
    const top = rankLearnings(list, { clientId: "c1", model: "restaurant", verticalId: "v1", task: "Review this video for the top-of-funnel campaign" }, 8, NOW);
    expect(top).toHaveLength(8);
    expect(top[0].id).toBe("video");
    expect(top[1].id).toBe("client");
    expect(top.map((x) => x.id)).not.toContain("everyone");
  });

  it("doubts a condition that shares nothing with the task", () => {
    expect(conditionFit("only for carousel ads", "a single static image")).toBeLessThan(0);
    expect(conditionFit("only for carousel ads", "this carousel")).toBeGreaterThan(0);
    expect(conditionFit(null, "anything")).toBe(0);
  });
});

describe("how far a lesson reaches", () => {
  const p = (clientId: string, verticalId: string | null, model: string | null, also: string | null = null) => ({ clientId, verticalId, model, also });

  it("stays with the client below three independent clients, and always for an exception", () => {
    expect(widenScope([p("a", "v", "m"), p("b", "v", "m")], "everyone", "lesson").scope).toBe("client");
    expect(widenScope([p("a", "v", "m"), p("a", "v", "m"), p("b", "v", "m")], "everyone", "lesson").scope).toBe("client");
    expect(widenScope([p("a", "v", "m"), p("b", "v", "m"), p("c", "v", "m")], "everyone", "exception").scope).toBe("client");
  });

  it("reaches the narrowest group the clients share, never past what was proposed", () => {
    expect(widenScope([p("a", "v", "m"), p("b", "v", "m"), p("c", "v", "m")], "everyone", "lesson")).toEqual({ scope: "vertical", model: null, verticalId: "v" });
    expect(widenScope([p("a", "v1", "m"), p("b", "v2", "m"), p("c", "v3", "x", "m")], "model", "lesson")).toEqual({ scope: "model", model: "m", verticalId: null });
    expect(widenScope([p("a", "v1", "m"), p("b", "v2", "n"), p("c", "v3", "o")], "model", "lesson").scope).toBe("client");
    expect(widenScope([p("a", "v1", "m"), p("b", "v2", "n"), p("c", "v3", "o")], "everyone", "lesson").scope).toBe("everyone");
    expect(widenScope([p("a", "v", "m"), p("b", "v", "m"), p("c", "v", "m")], "client", "lesson").scope).toBe("client");
  });
});

describe("two learnings that contradict", () => {
  it("picks the one ahead on recency, evidence or condition and behind on none, else leaves it to an exec", () => {
    const older = l({ id: "a", lastSeen: "2026-10-01T00:00:00Z", evidence: 1 });
    const newer = l({ id: "b", lastSeen: "2026-11-01T00:00:00Z", evidence: 2, condition: "for video" });
    expect(pickWinner(older, newer)).toBe("b");
    expect(pickWinner(newer, older)).toBe("a");
    const newerThin = l({ id: "c", lastSeen: "2026-11-02T00:00:00Z", evidence: 1 });
    const olderProven = l({ id: "d", lastSeen: "2026-10-01T00:00:00Z", evidence: 4 });
    expect(pickWinner(newerThin, olderProven)).toBeNull();
  });
});
