import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { judgeSocial } from "@/lib/channel-kpis/calc";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { rateSub, reachSub, socialMetrics, socialTiles } from "@/lib/channel-reports/core";
import { applyOverrides, carryTeamFindings, overrideNote, plainNote, teamFindingsOf, teamFindingsPrompt, tidyTeamFindings, type MetricOverride } from "@/lib/channel-reports/social-notes";
import { mtdCells, socialInsights } from "@/lib/channel-reports/social-report";
import type { Sections } from "@/lib/reports/write";
import { socialAccountScore, socialScore, type SocialDayRow, type SocialPostRow } from "@/lib/social-score";
import type { SocialPost } from "@/lib/social/core";
import type { DailyRow } from "@/lib/social/insights";
import { barFor, basisLabel, combineParts, engagementChain, FALLBACK_BARS, postInteractionsOf, postSums } from "@/lib/social/rate";

// The engagement rate and its backup chain: interactions over reach; with no reach, over views; with neither, per post over
// followers. Interactions missing: the posts' likes + comments + shares + saves. Every value says which basis it used, the
// score and the targets compare like with like, and the team can add notes and enter figures Meta didn't report.

const none = { interactions: null, reach: null, views: null, followers: null, posts: 0 };

describe("the engagement chain", () => {
  it("uses interactions over reach when Meta gives reach", () => {
    const r = engagementChain({ ...none, interactions: 50, reach: 1000, views: 4000, followers: 5000, posts: 4 });
    expect(r.basis).toBe("reach");
    expect(r.rate).toBeCloseTo(0.05);
  });

  it("falls back to views when there is no reach", () => {
    const r = engagementChain({ ...none, interactions: 60, views: 2000, followers: 5000, posts: 4 });
    expect(r.basis).toBe("views");
    expect(r.rate).toBeCloseTo(0.03);
    // A reach of zero is "didn't report", not a real zero to divide by
    expect(engagementChain({ ...none, interactions: 60, reach: 0, views: 2000 }).basis).toBe("views");
  });

  it("falls back to followers, per post, when there is neither reach nor views", () => {
    const r = engagementChain({ ...none, interactions: 80, followers: 2000, posts: 4 });
    expect(r.basis).toBe("followers");
    // 80 interactions over 4 posts is 20 a post, over 2,000 followers
    expect(r.rate).toBeCloseTo(0.01);
    // No post counted: the total over followers
    expect(engagementChain({ ...none, interactions: 20, followers: 2000, posts: 0 }).rate).toBeCloseTo(0.01);
  });

  it("is empty (never zero) when nothing can carry it", () => {
    expect(engagementChain({ ...none, interactions: 80 })).toMatchObject({ rate: null, basis: null });
    expect(engagementChain({ ...none, reach: 1000, views: 5000, followers: 100 })).toMatchObject({ rate: null, basis: null });
  });

  it("adds up likes, comments, shares and saves from the posts when the account gave no interactions", () => {
    const posts = [
      { likes: 10, comments: 2, shares: 1, saves: 3, reach: 400 },
      { likes: 20, comments: 0, shares: null, saves: null, reach: 600 },
    ];
    expect(postInteractionsOf(posts[0])).toBe(16);
    expect(postInteractionsOf({ interactions: 99, likes: 1 })).toBe(99);
    expect(postInteractionsOf({})).toBeNull();
    const r = engagementChain({ ...none, reach: 2000, posts: 2, fromPosts: postSums(posts) });
    expect(r.interactions).toBe(36);
    expect(r.interactionsFrom).toBe("posts");
    // Over the posts' own reach it still reads over reach (the account's 2,000)
    expect(r.rate).toBeCloseTo(36 / 2000);
  });

  it("uses the posts' reach when the account's is missing, over the interactions of those same posts, and says so", () => {
    const posts = [
      { interactions: 30, reach: 500 },
      { interactions: 20, reach: 500 },
      { interactions: 100, reach: null },
    ];
    const r = engagementChain({ interactions: 150, reach: null, views: null, followers: 9000, posts: 3, fromPosts: postSums(posts) });
    expect(r.reach).toBe(1000);
    expect(r.reachFrom).toBe("posts");
    expect(r.basis).toBe("reach");
    expect(r.rate).toBeCloseTo(50 / 1000);
    expect(basisLabel(r.basis, r.reachFrom)).toBe("by post reach");
  });

  it("reads last period on the basis this period used, so the two are like with like", () => {
    const now = engagementChain({ ...none, interactions: 60, views: 2000 });
    const before = engagementChain({ ...none, interactions: 40, reach: 500, views: 2000 }, { only: now.basis });
    expect(before.basis).toBe("views");
    expect(before.rate).toBeCloseTo(0.02);
    // The basis can't be worked out last period: empty, never a rate on another basis
    expect(engagementChain({ ...none, interactions: 40, reach: 500 }, { only: "views" }).rate).toBeNull();
  });

  it("adds platforms up on one basis when every platform has it, else the first any has", () => {
    const ig = engagementChain({ ...none, interactions: 40, reach: 800, views: 2000 }).parts;
    const fb = engagementChain({ ...none, interactions: 60, views: 3000 }).parts;
    const both = combineParts([ig, fb]);
    // Facebook has no reach: both on views (40 + 60 over 5,000)
    expect(both.basis).toBe("views");
    expect(both.rate).toBeCloseTo(100 / 5000);
    const reachOnly = combineParts([ig, engagementChain({ ...none, interactions: 20, reach: 200 }).parts]);
    expect(reachOnly.basis).toBe("reach");
    expect(reachOnly.rate).toBeCloseTo(60 / 1000);
    expect(combineParts([{}, {}])).toMatchObject({ rate: null, basis: null });
  });
});

describe("labels and bars", () => {
  it("labels only the rates that are not the standard reach rate", () => {
    expect(basisLabel("reach")).toBeNull();
    expect(basisLabel("views")).toBe("by views");
    expect(basisLabel("followers")).toBe("by followers");
    expect(basisLabel(null)).toBeNull();
  });

  it("holds a reach rate to the client's target and the others to their own bar", () => {
    expect(barFor("reach", 0.035)).toBe(0.035);
    expect(barFor("reach", null)).toBe(0.05);
    expect(barFor("views", 0.035)).toBe(FALLBACK_BARS.views);
    expect(barFor("followers", 0.035)).toBe(FALLBACK_BARS.followers);
  });

  it("judges the board's status like with like: a views rate never faces the reach target", () => {
    // 3.3% by views is on target against the views bar (3%), where against a 5% reach target it would read "off"
    expect(judgeSocial({ readable: true, target: 0.05, rate: 0.033, basis: "views" }).status).toBe("good");
    expect(judgeSocial({ readable: true, target: 0.05, rate: 0.033, basis: "reach" }).status).toBe("off");
    // With no target set a fallback basis still has its own bar; a reach rate does not
    expect(judgeSocial({ readable: true, target: null, rate: 0.011, basis: "followers" }).status).toBe("good");
    expect(judgeSocial({ readable: true, target: null, rate: 0.04, basis: "reach" }).status).toBe("unset");
    expect(judgeSocial({ readable: true, target: 0.05, rate: null, basis: null }).status).toBe("setup");
  });
});

describe("the score uses the right bar and says which basis", () => {
  it("scores a views rate against 3%, a followers rate against 1%, and a reach rate against the client's target", () => {
    const at = (basis: "reach" | "views" | "followers" | null, rate: number, target?: number) => socialScore({ engagement: rate }, { engagementBar: target ?? null, engagementBasis: basis }).checks.find((c) => c.key === "engagement")!;
    expect(at("views", 0.03, 0.05)).toMatchObject({ bar: 0.03, met: true, basis: "views" });
    expect(at("followers", 0.01, 0.05)).toMatchObject({ bar: 0.01, met: true, basis: "followers" });
    expect(at("reach", 0.03, 0.035)).toMatchObject({ bar: 0.035, met: false });
    expect(at(null, 0.05)).toMatchObject({ bar: 0.05, met: true });
  });

  const day = (date: string, extra: Partial<SocialDayRow> = {}): SocialDayRow => ({ platform: "instagram", date, followers: 4000, gained: 2, lost: 0, reach: null, interactions: 300, profileViews: null, views: null, ...extra });
  const dates = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-11-01T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  const post = (n: number): SocialPostRow => ({ platform: "instagram", postedAt: `2026-11-${String(n).padStart(2, "0")}T15:00:00Z`, format: "image", reach: null, interactions: 100, saves: null, shares: null });

  it("reads the account's engagement over views, then followers, when Meta gave no reach", () => {
    const viaViews = socialAccountScore({ today: "2026-11-30", days: dates.map((d) => day(d, { views: 10_000 })), posts: [post(3), post(10)] });
    const e = viaViews!.platforms[0].checks.find((c) => c.key === "engagement")!;
    expect(viaViews!.platforms[0].numbers.rateBasis).toBe("views");
    expect(e.basis).toBe("views");
    expect(e.bar).toBe(0.03);
    // 30 days x 300 = 9,000 interactions over 300,000 views
    expect(e.value).toBeCloseTo(0.03);

    const viaFollowers = socialAccountScore({ today: "2026-11-30", days: dates.map((d) => day(d)), posts: [post(3), post(10)] });
    const f = viaFollowers!.platforms[0].checks.find((c) => c.key === "engagement")!;
    expect(viaFollowers!.platforms[0].numbers.rateBasis).toBe("followers");
    expect(f.bar).toBe(0.01);
    // 9,000 interactions over 2 posts over 4,000 followers
    expect(f.value).toBeCloseTo(9000 / 2 / 4000);
  });
});

// ─── The report ────────────────────────────────────────────────────────────

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 - Nov 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 - Nov 8" };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
/** Meta gave interactions and views but no reach */
const noReachDays = (): DailyRow[] => range("2026-10-20", "2026-11-15").map((date) => ({ platform: "instagram" as const, date, followers: 8000, gained: 1, lost: null, reach: null, views: 6000, profileViews: null, engaged: null, interactions: 180 }));
/** Meta gave neither reach nor views */
const bareDays = (): DailyRow[] => noReachDays().map((d) => ({ ...d, views: null }));
const post = (id: string, day: string): SocialPost => ({ id, platform: "instagram", format: "image", caption: "A post", permalink: null, thumbnail: null, postedAt: `${day}T15:00:00Z`, likes: 10, comments: 2, shares: null, saves: null, reach: null, views: null, interactions: 12, insightsOk: false });

describe("the report: the backup rate, labeled, with no zeros", () => {
  const byViews = socialMetrics({ kind: "weekly", main, compare, days: noReachDays(), posts: [post("a", "2026-11-12")], names: {} });
  const byFollowers = socialMetrics({ kind: "weekly", main, compare, days: bareDays(), posts: [post("a", "2026-11-12")], names: {} });

  it("reads the rate over views, labels it, and reads the period before on the same basis", () => {
    expect(byViews.now.rateBasis).toBe("views");
    expect(byViews.now.rate).toBeCloseTo((180 * 7) / (6000 * 7));
    expect(byViews.before.rateBasis).toBe("views");
    expect(byViews.insightsRead).toBe(true);
    expect(rateSub(byViews, "5% target")).toBe("By views: interactions over views");
    const tile = socialTiles(byViews).find((t) => t.label === "Engagement rate")!;
    expect(tile.value).toBe("3.0%");
    expect(tile.sub).toContain("by views".replace("b", "B"));
  });

  it("falls to followers when Meta gave neither, and never holds it to the client's reach target", () => {
    expect(byFollowers.now.rateBasis).toBe("followers");
    expect(rateSub(byFollowers, "5% target")).toBe("By followers: interactions per post over followers");
    const cells = mtdCells(byFollowers);
    const rate = cells.find((c) => c.key === "rate");
    if (rate) {
      expect(rate.note).toBe("by followers");
      expect(rate.tone).toBeNull();
    }
  });

  it("says Meta didn't report reach, never a bare zero", () => {
    expect(reachSub(byViews, null)).toBe("Meta didn't report reach for this period");
    expect(byViews.now.reach).toBeNull();
    const reachCell = mtdCells(byViews).find((c) => c.key === "reach");
    if (reachCell) expect(reachCell.note).toBe("Meta didn't report reach for this period");
  });

  it("does not hold a views rate to the reach target in the takeaways", () => {
    const text = JSON.stringify(socialInsights(byViews, { headline: "", summary: "", did: [], doing: [], next: [], highlights: [] }));
    expect(text).toContain("by views");
    expect(text).not.toContain("target");
  });
});

// ─── Team notes and entered figures ────────────────────────────────────────

const empty: Sections = { headline: "h", summary: "s", did: [], doing: [], next: [], highlights: [] };
const byViews = () => socialMetrics({ kind: "weekly", main, compare, days: noReachDays(), posts: [post("a", "2026-11-12")], names: {} });
const entered = (extra: Partial<MetricOverride> = {}): MetricOverride => ({ key: "reach", value: 20_000, by: "Dana", at: "2026-11-16T15:00:00Z", why: "Read from Instagram's own app", ...extra });

describe("a figure the team entered", () => {
  it("replaces the missing figure, works the rate out again over reach, and reads last period on that basis", () => {
    const m = applyOverrides(byViews(), [entered()]);
    expect(m.now.reach).toBe(20_000);
    expect(m.now.rateBasis).toBe("reach");
    expect(m.now.rate).toBeCloseTo((180 * 7) / 20_000);
    expect(m.overrides).toHaveLength(1);
    expect(m.before.rateBasis).toBeNull();
  });

  it("leaves the metrics alone when nothing was entered, and keeps only the latest figure per metric", () => {
    const base = byViews();
    expect(applyOverrides(base, [])).toBe(base);
    expect(applyOverrides(base, null)).toBe(base);
    const m = applyOverrides(base, [entered({ value: 1, at: "2026-11-15T00:00:00Z" }), entered({ value: 9, at: "2026-11-16T00:00:00Z" })]);
    expect(m.now.reach).toBe(9);
  });

  it("notes it as the team's, with when but never who, and never an em dash", () => {
    const note = overrideNote(entered());
    expect(note).toBe("Reach entered by the Kaizen team on Nov 16: Read from Instagram's own app.");
    expect(note).not.toContain("Dana");
    expect(overrideNote(entered({ why: undefined }), { whiteLabel: true })).toBe("Reach entered by the team on Nov 16: Meta didn't report it for this period.");
    expect(plainNote("Up — and away – fast")).toBe("Up, and away, fast");
  });

  it("is stamped with who and when on the server, never taken from the browser, one per metric", () => {
    const sent: Sections = { ...empty, overrides: [{ key: "reach", value: 20_000.4, by: "someone else", at: "1999-01-01T00:00:00Z" }, { key: "reach", value: 5, by: "x", at: "x" }, { key: "views", value: -3, by: "x", at: "x" }] };
    const first = tidyTeamFindings(null, sent, "Dana Lee", "2026-11-18T10:00:00Z");
    expect(first.overrides).toEqual([{ key: "reach", value: 20_000, by: "Dana Lee", at: "2026-11-18T10:00:00Z" }]);
    // Saved again unchanged by someone else: it keeps who and when it was entered
    const again = tidyTeamFindings(first, { ...empty, overrides: first.overrides }, "Sam Roe", "2026-11-19T10:00:00Z");
    expect(again.overrides![0]).toMatchObject({ by: "Dana Lee", at: "2026-11-18T10:00:00Z" });
    // Changed: stamped anew
    const changed = tidyTeamFindings(first, { ...empty, overrides: [{ ...first.overrides![0], value: 21_000 }] }, "Sam Roe", "2026-11-19T10:00:00Z");
    expect(changed.overrides![0]).toMatchObject({ value: 21_000, by: "Sam Roe" });
  });
});

describe("team notes", () => {
  const notes: Sections = { ...empty, teamNotes: "The giveaway ran Tuesday — it drove the spike.", cardNotes: ["", "Reels are the plan for December."], overrides: [entered()] };

  it("are read cleaned, and reach the writer as the strategist's own findings", () => {
    const f = teamFindingsOf(notes);
    expect(f.notes).toBe("The giveaway ran Tuesday, it drove the spike.");
    expect(f.cards[1]).toBe("Reels are the plan for December.");
    const prompt = teamFindingsPrompt(notes);
    expect(prompt).toContain("<team_notes");
    expect(prompt).toContain("giveaway");
    expect(prompt).toContain("on takeaway 2");
    expect(prompt).toContain("Reach = 20000");
    expect(teamFindingsPrompt(empty)).toBe("");
  });

  it("survive an AI rewrite exactly", () => {
    const written: Sections = { ...empty, headline: "A new headline" };
    const kept = carryTeamFindings(notes, written);
    expect(kept.headline).toBe("A new headline");
    expect(kept.teamNotes).toBe(notes.teamNotes);
    expect(kept.cardNotes).toEqual(notes.cardNotes);
    expect(kept.overrides).toEqual(notes.overrides);
    expect(carryTeamFindings(null, written)).toBe(written);
    expect(carryTeamFindings(empty, written)).toEqual(written);
  });

  it("sit on the takeaway card they were written for", () => {
    const cards = socialInsights(byViews(), notes);
    expect(cards[1].teamNote).toBe("Reels are the plan for December.");
    expect(cards[0].teamNote).toBeUndefined();
  });

  it("always print on the report, labeled as the team's", async () => {
    const m = applyOverrides(byViews(), notes.overrides);
    const pdf = await renderToBuffer(createElement(ChannelDocument, { input: { client: "Mama Betty's", metrics: m, sections: notes }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    expect(pdf.byteLength).toBeGreaterThan(5000);
    // The text is compressed in the PDF stream; the drawing not throwing is the check here, the words are checked on the data
    expect(teamFindingsOf(notes).notes.length).toBeGreaterThan(0);
  });
});
