import { describe, expect, it } from "vitest";
import { channelPeriods, changesBetween, combineNumbers, dataFlags, dueKinds, emailMetrics, emailTiles, followerChangeOver, heroImage, keyLines, moveOf, periodMismatch, socialMetrics, socialTiles, takeawaysFor, targetLine, windowsFor, type EmailMetrics } from "@/lib/channel-reports/core";
import { linesFor, mayOpen } from "@/lib/channel-reports/access-core";
import type { CampaignLite, DailyRow as EmailDay, FlowLite } from "@/lib/klaviyo/insights";
import type { DailyRow as SocialDay } from "@/lib/social/insights";

const day = (date: string, o: Partial<EmailDay> = {}): EmailDay => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2, ...o });
const camp = (id: string, sendTime: string, o: Partial<CampaignLite> = {}): CampaignLite => ({ id, name: `Campaign ${id}`, channel: "email", sendTime, subject: `Subject ${id}`, recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, unsubscribes: 2, bounced: 5, spamComplaints: 0, revenue: 500, conversions: 10, openRate: 0.4, clickRate: 0.05, ...o });
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

describe("periods", () => {
  it("a monthly is the month just over against the month before", () => {
    const p = channelPeriods("monthly", "2026-11-02");
    expect(p.main).toMatchObject({ start: "2026-10-01", end: "2026-10-31", label: "October 2026" });
    expect(p.compare).toMatchObject({ start: "2026-09-01", end: "2026-09-30", label: "September 2026" });
  });
  it("a monthly in January looks back across the year", () => {
    expect(channelPeriods("monthly", "2027-01-04").main).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
  });
  it("a weekly is the Monday to Sunday just over against the week before", () => {
    const p = channelPeriods("weekly", "2026-11-16");
    expect(p.main).toMatchObject({ start: "2026-11-09", end: "2026-11-15" });
    expect(p.compare).toMatchObject({ start: "2026-11-02", end: "2026-11-08" });
  });
  it("keeps a report's own dates and works the comparison from them", () => {
    const w = windowsFor("monthly", { start: "2026-03-01", end: "2026-03-31" }, "2026-11-16");
    expect(w.compare).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodMismatch({ start: "2026-03-01", end: "2026-03-31" }, w)).toEqual([]);
    expect(periodMismatch({ start: "2026-04-01", end: "2026-04-30" }, w)).toContain("numbers");
  });
});

describe("what is due", () => {
  it("queues the monthly on the month's first Monday, like the ads reports", () => {
    expect(dueKinds({ weekday: "Mon", dom: 2, hour: 7 })).toEqual(["monthly"]);
    expect(dueKinds({ weekday: "Mon", dom: 7, hour: 5 })).toEqual(["monthly"]);
    expect(dueKinds({ weekday: "Tue", dom: 1, hour: 9 })).toEqual([]);
    expect(dueKinds({ weekday: "Mon", dom: 2, hour: 4 })).toEqual([]);
  });
  it("queues the weekly on every other Monday, never beside the monthly", () => {
    expect(dueKinds({ weekday: "Mon", dom: 16, hour: 6 })).toEqual(["weekly"]);
    expect(dueKinds({ weekday: "Wed", dom: 18, hour: 9 })).toEqual([]);
  });
});

describe("email numbers", () => {
  const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
  const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };
  const days = range("2026-08-01", "2026-11-15").map((d) => day(d, { revenue: d >= "2026-10-01" && d <= "2026-10-31" ? 200 : 100 }));
  const flows: FlowLite[] = [{ id: "f1", name: "Welcome series", status: "live", trigger: "list", revenue30: 3000, revenue90: 8000, recipients30: 900, recipients90: 2500, openRate30: 0.5, clickRate30: 0.08, openRate90: null, clickRate90: null }];
  const m = emailMetrics({ kind: "monthly", main, compare, today: "2026-11-02", days, campaigns: [camp("a", "2026-10-10T15:00:00Z", { revenue: 900 }), camp("b", "2026-10-20T15:00:00Z"), camp("old", "2026-09-10T15:00:00Z"), camp("empty", "2026-10-12T15:00:00Z", { recipients: 0 })], flows, keyFlows: [], profiles: 12000, currency: "USD", account: "Acme", images: new Map([["a", "https://img/x.jpg"]]) });

  it("adds revenue up from the daily rows for the period and the one before", () => {
    expect(m.now.revenue).toBe(200 * 31);
    expect(m.before.revenue).toBe(100 * 30);
  });
  it("lists the campaigns sent in the period, best revenue first, with their picture", () => {
    expect(m.campaignsTotal).toBe(2);
    expect(m.campaigns.map((c) => c.id)).toEqual(["a", "b"]);
    expect(m.campaigns[0].image).toBe("https://img/x.jpg");
  });
  it("states what the flows cover and never as the period's own days", () => {
    expect(m.flowsBasis).toContain("last 30 days");
    expect(m.flows[0]).toMatchObject({ name: "Welcome series", revenue: 3000 });
  });
  it("reads list growth from the daily subscribe rows", () => {
    expect(m.list.net).toBe(8 * 31);
    expect(m.list.profiles).toBe(12000);
  });
  it("draws eight weeks ending on the period's last day", () => {
    expect(m.trend).toHaveLength(8);
    expect(m.trend.at(-1)?.end).toBe("2026-10-31");
  });
  it("has four tiles with the move against the month before", () => {
    const t = emailTiles(m);
    expect(t.map((x) => x.label)).toEqual(["Attributed revenue", "Campaign revenue", "Flow revenue", "List growth"]);
    expect(t[0].move).toMatchObject({ up: true, tone: "good" });
  });
  it("shows the target and progress when the team set one", () => {
    const t = targetLine("email", { metric: "Email revenue", target: 10000 }, { kind: "monthly", main, revenue: m.now.revenue });
    expect(t).toMatchObject({ unit: "money", target: 10000 });
    expect(t?.progress).toBeCloseTo(0.62, 2);
    expect(emailTiles({ ...m, target: t })[0].sub).toContain("62%");
  });
  it("flags days with no data and a collapse in revenue", () => {
    const short: EmailMetrics = { ...m, gaps: ["2026-10-05"], before: { ...m.before, revenue: 5000 }, now: { ...m.now, revenue: 1000 } };
    const flags = dataFlags(short).map((f) => f.issue).join(" ");
    expect(flags).toContain("No daily numbers");
    expect(flags).toContain("fell from");
  });
  it("has nothing alarming on a healthy month and quotes key lines", () => {
    expect(dataFlags(m).filter((f) => f.severity !== "check")).toEqual([]);
    expect(keyLines(m)[0]).toContain("Attributed revenue");
  });
});

describe("social numbers", () => {
  const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
  const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };
  const mk = (date: string, followers: number, reach: number, interactions: number): SocialDay => ({ platform: "instagram", date, followers, gained: 5, lost: null, reach, views: reach * 2, profileViews: 10, engaged: 20, interactions });
  const days = range("2026-08-01", "2026-10-31").map((d, i) => mk(d, 1000 + i, d >= "2026-10-01" ? 200 : 100, d >= "2026-10-01" ? 10 : 4));
  const post = (id: string, format: "reel" | "image", at: string, interactions: number) => ({ id, platform: "instagram" as const, format, caption: `Post ${id}`, permalink: null, thumbnail: null, postedAt: at, likes: 1, comments: 1, shares: 0, saves: 0, reach: 1000, views: 2000, interactions, insightsOk: true });
  const posts = [post("1", "reel", "2026-10-04T14:00:00Z", 100), post("2", "image", "2026-10-15T14:00:00Z", 12), post("3", "image", "2026-09-15T14:00:00Z", 12)];
  const m = socialMetrics({ kind: "monthly", main, compare, days, posts, names: { instagram: "@acme" } });
  it("counts the posts published in the period and ranks them by engagement", () => {
    expect(m.now.posts).toBe(2);
    expect(m.before.posts).toBe(1);
    expect(m.posts.map((p) => p.id)).toEqual(["1", "2"]);
  });
  it("sums reach and works the engagement rate as interactions over reach", () => {
    expect(m.now.reach).toBe(200 * 31);
    expect(m.now.rate).toBeCloseTo(10 / 200, 5);
  });
  it("reads follower change from the counts at the period's edges", () => {
    expect(followerChangeOver(days, "instagram", main).change).toBe(31);
    expect(m.now.followerChange).toBe(31);
  });
  it("leaves the engagement rate out when Meta gave no reach", () => {
    const none = socialMetrics({ kind: "monthly", main, compare, days: days.map((d) => ({ ...d, reach: null, interactions: null })), posts: [], names: {} });
    expect(none.insightsRead).toBe(false);
    expect(socialTiles(none)[3].value).toBe("–");
    expect(dataFlags(none).some((f) => f.issue.includes("no reach"))).toBe(true);
  });
  it("holds the engagement rate against a target given as a percent or a fraction", () => {
    const a = targetLine("social", { metric: "engagement_rate", target: 3 }, { kind: "monthly", main, rate: 0.05 });
    const b = targetLine("social", { metric: "Engagement rate", target: 0.03 }, { kind: "monthly", main, rate: 0.05 });
    expect(a?.target).toBeCloseTo(0.03, 5);
    expect(b?.progress).toBeCloseTo(5 / 3, 3);
  });
  it("never guesses at a metric it doesn't know", () => {
    expect(targetLine("social", { metric: "vibes", target: 10 }, { kind: "monthly", main })).toBeNull();
    expect(targetLine("email", null, { kind: "monthly", main })).toBeNull();
  });
  it("combines platforms and leaves out what none gives", () => {
    expect(combineNumbers([m.now, { ...m.now, reach: null }]).reach).toBe(m.now.reach);
  });
  it("always has takeaways", () => {
    expect(takeawaysFor(m, null).length).toBeGreaterThan(0);
  });
});

describe("refreshing", () => {
  const base = emailMetrics({ kind: "monthly", main: { start: "2026-10-01", end: "2026-10-31", label: "October 2026" }, compare: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" }, today: "2026-11-02", days: range("2026-09-01", "2026-10-31").map((d) => day(d)), campaigns: [], flows: [], keyFlows: [], profiles: null, currency: "USD", account: null });
  it("says nothing moved for a rounding difference", () => {
    expect(changesBetween(base, { ...base, now: { ...base.now, revenue: base.now.revenue + 0.4 } })).toEqual([]);
  });
  it("names the numbers the text quotes that moved", () => {
    const c = changesBetween(base, { ...base, now: { ...base.now, revenue: base.now.revenue + 500 } });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ label: "Attributed revenue" });
    expect(c[0].was).not.toBe(c[0].now);
  });
  it("has no opinion without an earlier version", () => {
    expect(changesBetween(null, base)).toEqual([]);
  });
});

describe("moves", () => {
  it("reads good and bad by what the metric is", () => {
    expect(moveOf(120, 100)).toMatchObject({ pct: "20.0%", tone: "good" });
    expect(moveOf(120, 100, "down")).toMatchObject({ tone: "bad" });
    expect(moveOf(5, 0)).toBeNull();
  });
});

describe("pictures", () => {
  it("picks the first real image and skips pixels, icons and small ones", () => {
    const html = `<img src="https://x/open.gif" width="1" height="1"><img src="https://x/logo.png" width="300"><img src="https://x/hero.jpg" width="600"><img src="https://x/second.jpg">`;
    expect(heroImage(html)).toBe("https://x/hero.jpg");
    expect(heroImage(null)).toBeNull();
    expect(heroImage(`<img src="https://x/tiny.jpg" width="40">`)).toBeNull();
  });
});

describe("who sees which line", () => {
  it("gives execs both lines and the teams their own", () => {
    expect(linesFor({ role: "executive", isExec: true })).toEqual(["email", "social"]);
    expect(linesFor({ role: "email_designer" })).toEqual(["email"]);
    expect(linesFor({ role: "head_of_social" })).toEqual(["social"]);
    expect(linesFor({ role: "media_buyer" })).toEqual([]);
  });
  it("lets a head see every client with the service and others only their seats", () => {
    const client = { services: ["email-marketing"], myRoles: [] as string[] };
    expect(mayOpen({ role: "head_of_email" }, "email", client)).toBe(true);
    expect(mayOpen({ role: "head_of_email" }, "social", client)).toBe(false);
    expect(mayOpen({ role: "head_of_email" }, "email", { services: ["social-media"], myRoles: [] })).toBe(false);
    expect(mayOpen({ role: "email_builder" }, "email", client)).toBe(false);
    expect(mayOpen({ role: "email_builder" }, "email", { ...client, myRoles: ["email_builder"] })).toBe(true);
    expect(mayOpen({ role: "email_builder" }, "email", { ...client, myRoles: ["social_manager"] })).toBe(false);
    expect(mayOpen({ role: "media_buyer" }, "email", { ...client, myRoles: ["email_builder"] })).toBe(false);
    expect(mayOpen({ role: "executive", isExec: true }, "social", { services: [], myRoles: [] })).toBe(true);
  });
});
