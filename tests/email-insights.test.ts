import { describe, expect, it } from "vitest";
import { subjectPatterns, weeklyListChange } from "@/lib/kaizen-ai/email-insights";

const c = (subject: string, recipients: number, openRate: number, revenue = 0, clickRate = 0.01) => ({ subject, channel: "email", recipients, openRate, clickRate, revenue });

describe("subject line patterns", () => {
  it("weights rates by recipients and drops traits with too few sends", () => {
    const rows = [c("Ready for summer?", 1000, 0.4), c("Why wait?", 3000, 0.2), c("Is this you?", 1000, 0.3), c("New arrivals", 1000, 0.25)];
    const q = subjectPatterns(rows).find((p) => p.trait === "a question");
    expect(q?.campaigns).toBe(3);
    expect(q?.open_rate_pct).toBe(26);
    expect(subjectPatterns(rows).find((p) => p.trait === "an emoji")).toBeUndefined();
  });
  it("ignores SMS and rows without a subject", () => {
    const rows = [{ ...c("20% off?", 100, 0.5), channel: "sms" }, { ...c("x", 100, 0.5), subject: null }];
    expect(subjectPatterns(rows, 1)).toEqual([]);
  });
  it("finds urgency and numbers", () => {
    const rows = [c("Last chance: 20% off", 500, 0.3, 100), c("Ends tonight", 500, 0.35, 200), c("Final 3 hours left", 500, 0.32, 150)];
    expect(subjectPatterns(rows).find((p) => p.trait === "urgency wording")?.campaigns).toBe(3);
  });
});

describe("weekly list change", () => {
  it("adds days into Monday weeks", () => {
    const out = weeklyListChange([
      { date: "2026-11-09", subscribed: 5, unsubscribed: 1 },
      { date: "2026-11-15", subscribed: 3, unsubscribed: 0 },
      { date: "2026-11-16", subscribed: 2, unsubscribed: 1 },
      { date: "2026-11-17", subscribed: null, unsubscribed: null },
    ]);
    expect(out).toEqual([
      { week_starting: "2026-11-09", subscribed: 8, unsubscribed: 1 },
      { week_starting: "2026-11-16", subscribed: 2, unsubscribed: 1 },
    ]);
  });
});
