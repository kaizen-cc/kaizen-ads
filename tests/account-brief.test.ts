import { describe, expect, it } from "vitest";
import { accountBrief, type BriefInput } from "@/lib/account-brief";

const base: BriefInput = { status: "good", label: "CPL", value: "$30", target: "$35", deviation: 0.1, pacing: null, pace: null, spend30: 4000, hasAccount: true };
const now = Date.parse("2026-11-19T18:00:00Z");

describe("what to know about an account", () => {
  it("worst first, five at most", () => {
    const b = accountBrief({ ...base, status: "off", deviation: -0.92, value: "$479", target: "$250", owed: { n: 3, escalated: 1 }, pacing: "under", pace: 0.6, overduePromises: 2, changes: [{ summary: "Push the QLS only", pending: 2 }, { summary: "New offer", pending: 0 }], audit: { status: "ready", band: "bad", headline: "Wrong objective", actions: 4, done: 1, createdAt: "2026-11-10" } }, now);
    expect(b).toHaveLength(5);
    expect(b[0].text).toMatch(/CPL is 92% off target \(\$479 vs \$250/);
    expect(b[1].text).toMatch(/unanswered past the second notice/);
    expect(b.every((x) => x.tone !== "ok")).toBe(true);
  });
  it("a healthy account still says something useful", () => {
    const b = accountBrief(base, now);
    expect(b[0]).toMatchObject({ tone: "ok", text: "CPL is on target ($30 vs $35)" });
    expect(b[1].text).toMatch(/^Nothing critical/);
  });
  it("a stalled sprint and no account linked", () => {
    expect(accountBrief({ ...base, hasAccount: false }, now)[0].text).toMatch(/No ad account is linked/);
    const s = accountBrief({ ...base, sprint: { moves: 5, done: 1, score: 60, baseline: 60, lastDoneAt: "2026-11-10T12:00:00Z", startedAt: "2026-11-05" } }, now);
    expect(s[0].text).toBe("The sprint has stalled: no move done in 9 days (1 of 5)");
  });
});
