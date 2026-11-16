import { describe, expect, it } from "vitest";
import { emailScore, type EmailInputs } from "@/lib/email-score";
import { movement, nextCheckAt, plainMessage, snapshotOf, tally, verdictOf } from "@/lib/email-ops/sprint-core";

const base: EmailInputs = { attributed: 0.1, rpr: 0.05, deliverability: 50, campaignOpen: 0.2, campaignClick: 0.004, flowOpen: 0.3, flowClick: 0.01 };
const good: EmailInputs = { attributed: 0.35, rpr: 0.2, deliverability: 80, campaignOpen: 0.35, campaignClick: 0.012, flowOpen: 0.4, flowClick: 0.02 };
const snap = (i: EmailInputs) => snapshotOf(emailScore(i), "2026-11-17T12:00:00Z");

describe("sprint movement", () => {
  it("names the checks that crossed their bar, either way", () => {
    const m = movement(snap(base), snap({ ...base, deliverability: 70, campaignOpen: 0.31 }));
    expect(m.gained).toEqual(["Deliverability", "Campaign open rate"]);
    expect(m.lost).toEqual([]);
    expect(m.delta).toBeGreaterThan(0);
    const slip = movement(snap(good), snap({ ...good, deliverability: 40 }));
    expect(slip.lost).toEqual(["Deliverability"]);
    expect(slip.open[0]).toBe("Deliverability");
  });
});

describe("sprint verdicts", () => {
  const start = snap(base);
  it("nags when nothing is ticked, regardless of the score", () => {
    expect(verdictOf(movement(start, start), tally(["todo", "todo"]), start)).toBe("no_action");
  });
  it("is improving or worse past three points, otherwise on track", () => {
    const up = snap({ ...base, deliverability: 70 });
    expect(verdictOf(movement(start, up), tally(["done", "todo"]), up)).toBe("improving");
    const mid = snap({ ...good, attributed: 0.25, rpr: 0.12 });
    const down = snap({ ...good, attributed: 0.1, rpr: 0.05, deliverability: 30 });
    expect(verdictOf(movement(mid, down), tally(["doing"]), down)).toBe("worse");
    expect(verdictOf(movement(start, start), tally(["doing"]), start)).toBe("on_track");
  });
  it("is done once the account is back in the green", () => {
    const g = snap(good);
    expect(g.band).toBe("good");
    expect(verdictOf(movement(start, g), tally(["todo"]), g)).toBe("done");
  });
  it("looks again sooner after a slip, later once done", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    const days = (v: Parameters<typeof nextCheckAt>[0]) => Math.round((Date.parse(nextCheckAt(v, now)) - now) / 86_400_000);
    expect(days("worse")).toBe(1);
    expect(days("no_action")).toBe(2);
    expect(days("improving")).toBe(3);
    expect(days("done")).toBe(7);
  });
  it("writes a plain message with the real numbers and no em dash", () => {
    const up = snap({ ...base, deliverability: 70 });
    const m = movement(start, up);
    const text = plainMessage("improving", m, tally(["done", "todo"]), up);
    expect(text).toContain(`The score is ${up.score}`);
    expect(text).toContain("Deliverability now meets its bar");
    expect(text).not.toContain("—");
  });
});
