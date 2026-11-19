import { describe, expect, it } from "vitest";
import { historyStart, shiftDay } from "@/lib/social/core";
import { socialMonths } from "@/lib/kaizen-ai/social-report";

describe("how far back a client's social history goes", () => {
  const today = "2026-11-19";
  it("keeps 13 months for an existing client", () => {
    expect(historyStart(today, "2024-01-10")).toBe(shiftDay(today, -400));
  });
  it("reaches 60 days before Kaizen took over when that's further back", () => {
    expect(historyStart(today, "2025-11-01")).toBe("2025-09-02");
  });
  it("never asks Meta past two years", () => {
    expect(historyStart("2026-11-19", "2026-11-01") >= shiftDay(today, -720)).toBe(true);
    expect(historyStart(today, "2025-10-20")).toBe("2025-08-21");
  });
  it("keeps 13 months with no takeover date", () => {
    expect(historyStart(today, null)).toBe(shiftDay(today, -400));
  });
});

describe("month by month", () => {
  const days: { date: string; value: number | null }[] = [];
  for (let d = "2025-10-01"; d <= "2026-11-19"; d = shiftDay(d, 1)) days.push({ date: d, value: d.startsWith("2026-10") ? 200 : 100 });
  const inter = days.map((p) => ({ date: p.date, value: (p.value ?? 0) / 20 }));
  const m = socialMonths({ today: "2026-11-19", reach: days, interactions: inter, followers: [{ date: "2025-10-31", followers: 1000 } as never, { date: "2026-10-31", followers: 1300 } as never], posts: [{ postedAt: "2026-10-05T10:00:00Z" } as never] });
  it("covers every month read, newest first, the current one partial", () => {
    expect(m[0]).toMatchObject({ month: "2026-11", partial: true });
    expect(m.at(-1)!.month).toBe("2025-10");
  });
  it("compares a month with the one before and the same month a year before", () => {
    const oct = m.find((x) => x.month === "2026-10")!;
    expect(oct.reach).toBe(6200);
    expect(oct.posts).toBe(1);
    expect(oct.reach_vs_month_before_pct).toBeCloseTo(106.7, 1);
    expect(oct.reach_vs_year_before_pct).toBe(100);
    expect(oct.engagement_rate_pct).toBe(5);
    expect(oct.followers_vs_year_before).toBe(300);
  });
});
