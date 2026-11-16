import { describe, expect, it } from "vitest";
import { organicSocialReport, socialMissingNote } from "@/lib/kaizen-ai/social-report";
import type { ClientSocial } from "@/lib/social/store";

const today = "2026-11-16";
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const series = (v: (i: number) => number) => Array.from({ length: 90 }, (_, k) => ({ date: day(89 - k), value: v(89 - k) }));
const win = { reach: 0, views: 0, interactions: 0, profileViews: 0, engaged: 0, gained: 0, lost: 0, rate: null };

const base = {
  today,
  through: today,
  platforms: [],
  followers: Array.from({ length: 90 }, (_, k) => ({ date: day(89 - k), followers: 1000 + (89 - k) * -2 + 180, estimated: false })),
  followersNow: 1180,
  followersChange: 0,
  followersPrevChange: 0,
  reach: series((i) => (i < 30 ? 200 : 100)),
  interactions: series((i) => (i < 30 ? 10 : 5)),
  rate: [],
  now: win,
  before: win,
  postsPerWeek: 0,
  posts: [],
  health: [],
  warning: null,
} as unknown as ClientSocial;

describe("organicSocialReport", () => {
  it("sums the period and compares it with the one before", () => {
    const r = organicSocialReport(base, { days: 30, top: 3 });
    expect(r.reach.total).toBe(30 * 200);
    expect(r.reach.previous).toBe(30 * 100);
    expect(r.reach.change_pct).toBe(100);
    expect(r.engagement_rate_pct).toBe(5);
    expect(r.followers.now).toBe(1180);
  });
  it("leaves the comparison out when it falls outside the 90 days", () => {
    const r = organicSocialReport(base, { days: 60, top: 3 });
    expect(r.reach.previous).toBeNull();
    expect(r.reach.change_pct).toBeNull();
  });
});

describe("socialMissingNote", () => {
  it("says how to link an unlinked Page", () => {
    const n = socialMissingNote("missing", null, true);
    expect(n).toMatch(/aren't linked yet/);
    expect(n).toMatch(/Business Manager/);
    expect(n).toMatch(/Social tab/);
  });
  it("names a failing read and a pending first read", () => {
    expect(socialMissingNote("failing", { message: "Meta refused", fix: "Fix it", severity: "bad", permissions: [] }, true)).toMatch(/Meta refused/);
    expect(socialMissingNote("pending", null, true)).toMatch(/first read/);
    expect(socialMissingNote("missing", null, false)).toMatch(/doesn't have Social Media/);
  });
});
