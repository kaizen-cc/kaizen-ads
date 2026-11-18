import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { socialMetrics, type SocialMetrics } from "@/lib/channel-reports/core";
import { followerView, priorFollowersOver } from "@/lib/channel-reports/social-followers";
import { captionText, followerChangeText, mtdCells, pdfText, socialInsights, socialScoreText } from "@/lib/channel-reports/social-report";
import type { DailyRow } from "@/lib/social/insights";
import type { SocialPost } from "@/lib/social/core";
import type { Sections } from "@/lib/reports/write";

// The organic social report: followers compared over the same platforms (Mama Betty's Nov 9 to 15 report read "20,474,
// up 220.8% vs 6,383" because Instagram had no follower count the week before), captions cut between words, emoji the
// PDF fonts can't draw left out, and the PDF drawing. The internal social score never reaches the client.

const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

/** Facebook counts followers every day; Instagram only from Nov 12 (as Meta gave Mama Betty's) */
function days(): DailyRow[] {
  return range("2026-09-01", "2026-11-15").flatMap((date, i) => [
    { platform: "facebook" as const, date, followers: 6300 + Math.floor(i / 2), gained: 1, lost: 0, reach: 3000, views: 5000, profileViews: 40, engaged: null, interactions: 150 },
    { platform: "instagram" as const, date, followers: date >= "2026-11-12" ? 14089 : null, gained: 6, lost: null, reach: 2000, views: 3000, profileViews: 50, engaged: 60, interactions: 90 },
  ]);
}
const post = (id: string, day: string, extra: Partial<SocialPost> = {}): SocialPost => ({ id, platform: "instagram", format: "carousel", caption: "Come celebrate with us", permalink: null, thumbnail: null, postedAt: `${day}T15:00:00Z`, likes: 10, comments: 1, shares: 5, saves: 1, reach: 1700, views: 3000, interactions: 164, insightsOk: true, ...extra });
const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 – Nov 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – Nov 8" };

describe("followers compared over the same platforms", () => {
  it("fills a platform's missing prior count from this period's, so both totals count both platforms", () => {
    const m = socialMetrics({ kind: "weekly", main, compare, days: days(), posts: [post("a", "2026-11-13")], names: {} });
    const ig = m.platforms.find((p) => p.platform === "instagram")!;
    expect(ig.before.followers).toBe(14089 - ig.now.followerChange!);
    expect(m.before.followers).not.toBeNull();
    // Never a 200%+ jump: the totals are the same platforms, a week apart
    expect(Math.abs((m.now.followers! - m.before.followers!) / m.before.followers!)).toBeLessThan(0.01);
    expect(m.now.followers! - m.before.followers!).toBe(m.now.followerChange);
  });

  it("reads a stored report from before the fix fairly (the PDF's own view)", () => {
    const f = followerView([
      { now: { followers: 14089, followerChange: 43, followersStart: null }, before: { followers: null, followerChange: 39, followersStart: null } },
      { now: { followers: 6385, followerChange: 2, followersStart: 6383 }, before: { followers: 6383, followerChange: 6, followersStart: 6377 } },
    ]);
    expect(f).toEqual({ total: 20474, change: 45, growth: 45 / 20429, prior: 20429 });
    expect(followerChangeText(f)).toBe("+45 (+0.22%)");
  });

  it("gives no prior total rather than one over fewer platforms", () => {
    expect(priorFollowersOver([{ followers: 14000, followerChange: null, followersStart: null }, { followers: 6385, followerChange: null, followersStart: null }], [{ followers: null, followerChange: null, followersStart: null }, { followers: 6383, followerChange: null, followersStart: null }])).toBeNull();
    expect(priorFollowersOver([{ followers: null, followerChange: null, followersStart: null }, { followers: 6385, followerChange: null, followersStart: null }], [{ followers: null, followerChange: null, followersStart: null }, { followers: 6383, followerChange: null, followersStart: null }])).toBe(6383);
  });

  it("keeps the month to date's follower total fair too, and shows the net change in its row", () => {
    const m = socialMetrics({ kind: "weekly", main, compare, days: days(), posts: [], names: {} });
    expect(m.mtd?.before.followers).toBeNull();
    expect(mtdCells(m).find((c) => c.key === "followers")?.value).toMatch(/^\+\d+$/);
  });
});

describe("captions", () => {
  it("cuts between words with an ellipsis, never mid-word", () => {
    const c = "A year ago, we opened our doors on Burnet Rd, and you made us feel at home. Come celebrate with us Thursday.";
    const out = captionText(c, 70);
    expect(out.endsWith("…")).toBe(true);
    expect(c.startsWith(out.slice(0, -1))).toBe(true);
    expect(c[out.length - 1]).toMatch(/[\s,.]/);
    expect(out.length).toBeLessThanOrEqual(71);
  });

  it("drops the broken last word of a caption that was already cut where it was stored", () => {
    const stored = "Fried rice. Tex-Mex style. 🔥✨ Pechuga gravy sautéed rice, scrambled eggs, pico, onions, mushrooms, and zucchini. The Mexican Fried Rice. Come see what all the ";
    const cut = "A year ago, we opened our doors on Burnet Rd, and you made us feel at home. Come celebrate with us Thursday, Nov. 19, all day, at the Burnet Rd location only. $";
    expect(captionText(cut, 400)).toBe("A year ago, we opened our doors on Burnet Rd, and you made us feel at home. Come celebrate with us Thursday, Nov. 19, all day, at the Burnet Rd location only…");
    expect(captionText(stored, 400).endsWith("Come see what all…")).toBe(true);
  });

  it("leaves a short caption whole", () => {
    expect(captionText("Taco Tuesday is back", 100)).toBe("Taco Tuesday is back");
  });
});

describe("text the PDF fonts can draw", () => {
  it("leaves emoji out cleanly, with no stray spaces", () => {
    expect(pdfText("Fried rice. Tex-Mex style. 🔥✨ Pechuga gravy")).toBe("Fried rice. Tex-Mex style. Pechuga gravy");
    expect(pdfText("Taco Tuesday is BACK 🌮🌮! Tag us 👇🏽 now 👨‍👩‍👧")).toBe("Taco Tuesday is BACK! Tag us now");
    expect(pdfText("Flags 🇺🇸 and keycaps 1️⃣ go")).toBe("Flags and keycaps 1 go");
  });

  it("keeps accents and the typographic marks Helvetica has, and makes em dashes plain", () => {
    expect(pdfText("Sautéed “jalapeño” rice — 2 for $10…")).toBe("Sautéed “jalapeño” rice - 2 for $10…");
  });
});

describe("what the writer gets", () => {
  it("gives the writer the target and the net follower change, never the internal score", () => {
    const m = socialMetrics({ kind: "weekly", main, compare, days: days(), posts: [post("a", "2026-11-13")], names: {} });
    const lines = socialScoreText(m).join(" | ");
    expect(lines).toMatch(/Engagement target: 5%/);
    expect(lines).toMatch(/net \+\d+/);
    expect(lines).not.toMatch(/score/i);
  });
});

describe("the social PDF", () => {
  const sections: Sections = { headline: "", summary: "", did: [], doing: [], next: [], highlights: [], takeaways: [{ title: "Reach grew", text: "Reach rose 23.7% to 38,410.", next: "Keep Facebook in the mix." }, { title: "Engagement under target", text: "4.1% against the 5% target.", next: "Lead with a carousel." }, { title: "Birthday carousel led", text: "164 interactions 🎉 on 1,704 reached.", next: "Recap the event." }] };

  it("keeps the writer's next lines and leaves emoji out of the cards", () => {
    const m = socialMetrics({ kind: "weekly", main, compare, days: days(), posts: [post("a", "2026-11-13")], names: {} });
    const cards = socialInsights(m, sections);
    expect(cards.map((c) => c.next)).toEqual(["Keep Facebook in the mix.", "Lead with a carousel.", "Recap the event."]);
    expect(cards[2].text).toBe("164 interactions on 1,704 reached.");
  });

  it("works out cards with next lines when the writer wrote none", () => {
    const m = socialMetrics({ kind: "weekly", main, compare, days: days(), posts: [post("a", "2026-11-13")], names: {} });
    const cards = socialInsights(m, { ...sections, takeaways: [] });
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards.every((c) => c.next)).toBe(true);
    expect(cards.some((c) => /5% target/.test(c.title))).toBe(true);
  });

  it("draws with one post or three, and for a stored report that still carries a score", async () => {
    const posts = [post("a", "2026-11-13", { caption: "Come celebrate 🎉 with us" }), post("b", "2026-11-11", { format: "image" }), post("c", "2026-11-10", { platform: "facebook", format: "reel" })];
    const draw = async (m: SocialMetrics) => renderToBuffer(createElement(ChannelDocument, { input: { client: "Mama Betty's", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]);
    const withScore: SocialMetrics = socialMetrics({ kind: "weekly", main, compare, days: days(), posts, names: { instagram: "@mama.bettys", facebook: "Mama Betty's" } });
    (withScore as unknown as Record<string, unknown>).score = { score: 71, band: "watch", lifting: [], weighing: [], platforms: [] };
    expect((await draw(withScore)).subarray(0, 4).toString()).toBe("%PDF");
    const one = socialMetrics({ kind: "monthly", main: { start: "2026-10-01", end: "2026-10-31", label: "October 2026" }, compare: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" }, days: days(), posts: [post("a", "2026-10-13")], names: {} });
    expect((await draw(one)).length).toBeGreaterThan(1000);
  });
});
