import type { Move } from "@/lib/reports/weekly-core";
import type { Sections } from "@/lib/reports/write";
import { DEFAULT_ENGAGEMENT_BAR, PLATFORM_LABEL, socialCheckText, type SocialAccountScore, type SocialBand, type SocialCheck, type SocialCheckKey, type SocialPlatform } from "@/lib/social-score";
import { int, moveOf, pct, signed, type SocialMetrics, type SocialPostLite } from "./core";
import { followerView, type FollowerView } from "./social-followers";

// The organic social report's views, pure so the PDF (social-doc.tsx), the tests and the writer read the same thing:
// the social score in the client's words (what lifts it, what weighs it down), the follower comparison over the same
// platforms, the month to date as one row, captions that are safe for the PDF's fonts and cut between words, and the
// insight cards with what we'll do next.

// ─── The social score, for the client ──────────────────────────────────────

export type ScoreReason = { key: SocialCheckKey; text: string; platform?: SocialPlatform | null };
export type PlatformScoreLite = { platform: SocialPlatform; score: number; band: SocialBand; lifting: ScoreReason[]; weighing: ScoreReason[] };
/** The account's social score as the report keeps it (kept on the report's metrics, so a sent report never changes) */
export type SocialReportScore = {
  score: number;
  band: SocialBand;
  /** The client's engagement target, or Kaizen's 5% */
  engagementBar: number;
  /** The 30 days the score reads (ending on the report's last day) */
  window: { from: string; to: string };
  platforms: PlatformScoreLite[];
  lifting: ScoreReason[];
  weighing: ScoreReason[];
};

const tidy = (t: string) => t.replace(/\.0%$/, "%");
const v = (c: SocialCheck) => tidy(socialCheckText(c.unit, c.value));
const bar = (c: SocialCheck) => tidy(socialCheckText(c.unit, c.bar));
/** A reach change as words: "up 12%", "down 3%", "flat" */
const reachMove = (x: number | null) => {
  if (x == null) return "flat";
  const d = Math.round((x - 1) * 100);
  return d === 0 ? "flat" : `${d > 0 ? "up" : "down"} ${Math.abs(d)}%`;
};

/** A check that's met, in the client's words */
export function liftText(c: SocialCheck): string {
  switch (c.key) {
    case "engagement":
      return `Engagement at ${v(c)}, at or above the ${bar(c)} target`;
    case "growth":
      return `Followers up ${v(c)} over 30 days`;
    case "reach":
      return `Reach ${reachMove(c.value)} on the 30 days before`;
    case "cadence":
      return "Posting on pace with the plan";
    case "quality":
      return "Plenty of saves and shares for the reach";
    case "videoShare":
      return `Reels and video are ${v(c)} of posts`;
    case "videoLift":
      return "Video engaging better than still posts";
    case "profile":
      return "Lots of people visiting the profile";
  }
}

/** A check under its bar, in the client's words */
export function dragText(c: SocialCheck): string {
  switch (c.key) {
    case "engagement":
      return `Engagement at ${v(c)}, under the ${bar(c)} target`;
    case "growth":
      return c.value != null && c.value < 0 ? `Followers down ${socialCheckText("pct", Math.abs(c.value))} over 30 days` : `Followers up ${v(c)} in 30 days, short of ${bar(c)}`;
    case "reach":
      return `Reach ${reachMove(c.value)} on the 30 days before`;
    case "cadence":
      return "Fewer posts so far this month than the plan";
    case "quality":
      return "Few saves and shares for the reach";
    case "videoShare":
      return `Reels and video only ${v(c)} of posts`;
    case "videoLift":
      return "Video engaging less than still posts";
    case "profile":
      return "Few profile visits for the reach";
  }
}

/** The account's score as the report keeps it: the overall, each platform's, and the reasons either way (biggest first) */
export function reportScoreOf(a: SocialAccountScore): SocialReportScore {
  const measured = (cs: SocialCheck[]) => cs.filter((c) => c.value != null);
  const lifts = (cs: SocialCheck[]) => measured(cs).filter((c) => c.met).sort((x, y) => y.weight - x.weight);
  const drags = (cs: SocialCheck[]) => measured(cs).filter((c) => !c.met).sort((x, y) => y.weight - y.points - (x.weight - x.points));
  const engagement = a.checks.find((c) => c.key === "engagement");
  // The account's own reasons first; when the blend has none (one platform's strength averaged away), each platform's, named
  const overall = (own: SocialCheck[], per: (p: SocialAccountScore["platforms"][number]) => SocialCheck[], say: (c: SocialCheck) => string): ScoreReason[] => {
    const out: ScoreReason[] = own.slice(0, 3).map((c) => ({ key: c.key, text: say(c) }));
    if (out.length) return out;
    return a.platforms
      .flatMap((p) => per(p).slice(0, 2).map((c) => ({ key: c.key, text: `${PLATFORM_LABEL[p.platform]}: ${say(c).charAt(0).toLowerCase()}${say(c).slice(1)}`, platform: p.platform })))
      .slice(0, 3);
  };
  return {
    score: a.score,
    band: a.band,
    engagementBar: engagement?.bar ?? DEFAULT_ENGAGEMENT_BAR,
    window: a.window,
    platforms: a.platforms
      .filter((p) => p.unmeasured.length < p.checks.length)
      .map((p) => ({ platform: p.platform, score: p.score, band: p.band, lifting: lifts(p.checks).slice(0, 2).map((c) => ({ key: c.key, text: liftText(c) })), weighing: drags(p.checks).slice(0, 2).map((c) => ({ key: c.key, text: dragText(c) })) })),
    lifting: overall(lifts(a.checks), (p) => lifts(p.checks), liftText),
    weighing: overall(drags(a.checks), (p) => drags(p.checks), dragText),
  };
}

export const SCORE_HEX: Record<SocialBand, string> = { good: "#087a5e", watch: "#b7791f", bad: "#c23e4c" };
export const SCORE_BG: Record<SocialBand, string> = { good: "#e1f5ec", watch: "#fdf1dc", bad: "#ffeaec" };
export const SCORE_WORD: Record<SocialBand, string> = { good: "Healthy", watch: "Watch", bad: "Needs work" };

/** The engagement target the report holds every rate against: the client's own when the score or the target has one, else Kaizen's 5% */
export function engagementBarOf(m: SocialMetrics): number {
  if (m.score?.engagementBar) return m.score.engagementBar;
  const t = m.target;
  if (t && /engagement|rate/i.test(t.metric) && t.target > 0 && t.target < 1) return t.target;
  return DEFAULT_ENGAGEMENT_BAR;
}

// ─── Text the PDF can draw ─────────────────────────────────────────────────

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
// What Helvetica (WinAnsi) can draw beyond Latin-1: everything else would print as garbage
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** Text safe for the PDF's built-in fonts: emoji and symbols dropped cleanly (no stray spaces), em dashes made plain */
export function pdfText(s: string | null | undefined): string {
  if (!s) return "";
  const out = s
    .normalize("NFC")
    .replace(EMOJI, " ")
    .replace(/\s*—\s*/g, " - ")
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (ch) => (WIN_ANSI_EXTRA.includes(ch) ? ch : " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/ +([.,!?;:)])/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return out;
}

/** Captions are kept to this many characters on the report's metrics: one this long was cut there, maybe mid-word */
export const STORED_CAPTION = 160;

/**
 * A caption as a card shows it: PDF-safe, at most `max` characters, cut between words with an ellipsis (never "you made
 * us feel at"), and a caption that was already cut where it was stored loses its broken last word.
 */
export function captionText(caption: string | null | undefined, max = 110): string {
  const raw = caption ?? "";
  // core.ts keeps a caption's first 160 characters after collapsing spaces, so one cut there may end on a space
  const wasCut = raw.replace(/\s+/g, " ").replace(/^ /, "").length >= STORED_CAPTION;
  let t = pdfText(raw);
  if (!t) return "";
  if (!wasCut && t.length <= max) return t;
  let cut = t.slice(0, max);
  // The last word is partial when the cut lands inside a word, or when the stored caption itself was cut there
  const partial = t.length > max ? /\S/.test(t[max]) : true;
  const space = cut.lastIndexOf(" ");
  if (partial && space > 0) cut = cut.slice(0, space);
  t = cut.replace(/[\s,.;:\-–(&$#@/]+$/u, "");
  return `${t}…`;
}

// ─── Followers and engagement ──────────────────────────────────────────────

/** Followers over the report's platforms (works on stored reports from before the fix, too) */
export const followersOf = (m: SocialMetrics): FollowerView => followerView(m.platforms);

/** "+45 (+0.2%)" */
export function followerChangeText(f: FollowerView): string {
  if (f.change == null) return "–";
  const g = f.growth != null ? ` (${f.growth >= 0 ? "+" : "-"}${Math.abs(f.growth * 100).toFixed(Math.abs(f.growth) < 0.1 ? 2 : 1)}%)` : "";
  return `${signed(f.change)}${g}`;
}

/** An engagement rate against the target: how far it is, as "0.9 pts under" or "1.2 pts over" */
export function againstBar(rate: number | null | undefined, target: number): { met: boolean; text: string } | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  const pts = (rate - target) * 100;
  if (Math.abs(pts) < 0.05) return { met: true, text: "right at target" };
  return { met: pts >= 0, text: `${Math.abs(pts).toFixed(1)} pts ${pts >= 0 ? "over" : "under"}` };
}

/** Each week's engagement rate (interactions over reach) on the reach chart */
export const trendRates = (m: SocialMetrics): (number | null)[] => m.trend.map((p) => (p.value > 0 && p.extra != null ? p.extra / p.value : null));

// ─── Month to date ─────────────────────────────────────────────────────────

export type MtdCell = { key: string; label: string; value: string; before: string; move: Move; note?: string | null; tone?: "good" | "bad" | null };

/** The month to date as one clean row: posts, reach, views, engagement against the target, interactions, followers */
export function mtdCells(m: SocialMetrics): MtdCell[] {
  const x = m.mtd;
  if (!x) return [];
  const { now, before } = x;
  const target = engagementBarOf(m);
  const vs = againstBar(now.rate, target);
  const cell = (key: string, label: string, a: number | null, b: number | null, f: (n: number | null) => string, better: "up" | "down" | "none" = "up"): MtdCell => ({ key, label, value: f(a), before: f(b), move: moveOf(a, b, better) });
  return [
    cell("posts", "Posts", now.posts, before.posts, int, "none"),
    ...(m.insightsRead
      ? [
          cell("reach", "Reach", now.reach, before.reach, int),
          cell("views", "Views", now.views, before.views, int),
          { ...cell("rate", "Engagement", now.rate, before.rate, (n) => pct(n)), note: vs ? `${pct(target, 0)} target · ${vs.text}` : null, tone: vs ? (vs.met ? ("good" as const) : ("bad" as const)) : null },
          cell("interactions", "Interactions", now.interactions, before.interactions, int),
        ]
      : [cell("views", "Views", now.views, before.views, int)]),
    cell("followers", "Net followers", now.followerChange, before.followerChange, signed),
  ];
}

// ─── Platforms and posts ───────────────────────────────────────────────────

/** A platform's best post in the period (by engagement), from the posts the report kept */
export const bestPostOf = (m: SocialMetrics, platform: string): SocialPostLite | null => m.posts.find((p) => p.platform === platform) ?? null;

export const FORMAT_WORD: Record<string, string> = { image: "Photo", carousel: "Carousel", reel: "Reel", video: "Video", link: "Link", text: "Text post" };

// ─── Insight cards ─────────────────────────────────────────────────────────

export type Insight = { title: string; text: string; next: string | null; tone: "good" | "bad" | "neutral" };

const rel = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? (a - b) / b : null);
const pctWord = (x: number) => `${Math.abs(x * 100).toFixed(1)}%`;
const toneOfRel = (x: number | null): Insight["tone"] => (x == null || Math.abs(x) < 0.005 ? "neutral" : x > 0 ? "good" : "bad");

/**
 * Three or four cards: the writer's own (with its "what we'll do next" line) when it wrote them, else worked out from the
 * numbers. A written card without a next line keeps its words and gets none: a plan is never invented for it.
 */
export function socialInsights(m: SocialMetrics, sections: Sections): Insight[] {
  type Written = { title?: string; text?: string; next?: string };
  const own = ((sections.takeaways ?? []) as Written[]).filter((t) => t.title?.trim() && t.text?.trim()).slice(0, 4);
  if (own.length >= 3) return own.map((t) => ({ title: pdfText(t.title), text: pdfText(t.text), next: t.next?.trim() ? pdfText(t.next) : null, tone: "neutral" }));
  const out: Insight[] = own.map((t) => ({ title: pdfText(t.title), text: pdfText(t.text), next: t.next?.trim() ? pdfText(t.next) : null, tone: "neutral" }));
  const f = followersOf(m);
  const target = engagementBarOf(m);
  const reach = rel(m.now.reach, m.before.reach);
  if (m.now.reach != null)
    out.push({
      title: reach == null ? "Reach this period" : reach >= 0 ? `Reach up ${pctWord(reach)}` : `Reach down ${pctWord(reach)}`,
      text: `Posts and stories reached ${int(m.now.reach)} accounts, against ${int(m.before.reach)} in ${m.compare.label}.${m.now.views != null ? ` Views came to ${int(m.now.views)}.` : ""}`,
      next: reach != null && reach < 0 ? "We'll put more of the calendar behind the formats that travelled furthest." : "We'll keep the posting rhythm that's driving it.",
      tone: toneOfRel(reach),
    });
  if (m.insightsRead && m.now.rate != null) {
    const vs = againstBar(m.now.rate, target);
    out.push({
      title: `Engagement ${pct(m.now.rate)} vs ${pct(target, 0)} target`,
      text: `${int(m.now.interactions)} likes, comments, shares and saves on ${int(m.now.reach)} reached${m.before.rate != null ? `, against ${pct(m.before.rate)} in ${m.compare.label}` : ""}.`,
      next: vs?.met ? "We'll keep leaning into what people are responding to." : "We'll test stronger hooks and more interactive posts to lift it.",
      tone: vs ? (vs.met ? "good" : "bad") : "neutral",
    });
  }
  const top = m.posts[0];
  if (top)
    out.push({
      title: `Best post: ${FORMAT_WORD[top.format] ?? top.format} on ${top.platform === "instagram" ? "Instagram" : "Facebook"}`,
      text: `${captionText(top.caption, 60) ? `"${captionText(top.caption, 60)}" drew` : "It drew"} ${int(top.interactions)} interactions from ${int(top.reach)} reached${top.rate != null ? ` (${pct(top.rate)})` : ""}.`,
      next: "We'll build more posts on the same idea.",
      tone: "good",
    });
  if (f.change != null)
    out.push({
      title: f.change >= 0 ? `${signed(f.change)} followers` : `${int(Math.abs(f.change))} followers lost`,
      text: `The accounts ended the period on ${int(f.total)} followers${f.growth != null ? `, a ${f.growth >= 0 ? "" : "-"}${Math.abs(f.growth * 100).toFixed(2)}% change` : ""}.`,
      next: f.change >= 0 ? "We'll keep giving people a reason to follow with every post." : "We'll look at what drove the unfollows and adjust the mix.",
      tone: f.change > 0 ? "good" : f.change < 0 ? "bad" : "neutral",
    });
  return out.slice(0, 4);
}

/** A post's picture key, as the PDF's images are keyed (the same as channel-doc's) */
export const postKey = (p: { platform: string; id: string }) => `${p.platform}:${p.id}`;

/** The frame each post picture is drawn in: near square (16:15) when three posts share a row, else Instagram's 4:5 portrait */
export const postFrame = (count: number) => (count >= 3 ? { w: 480, h: 450 } : { w: 480, h: 600 });

/** The engagement target, the follower change over the same platforms and the social score, as lines for the writer */
export function socialScoreText(m: SocialMetrics): string[] {
  const f = followersOf(m);
  const target = engagementBarOf(m);
  const out = [
    `Engagement target: ${pct(target, 0)} (${m.score?.engagementBar && m.score.engagementBar !== DEFAULT_ENGAGEMENT_BAR ? "the client's own" : "Kaizen's standard"}); quote every engagement rate against it.`,
    `Followers across the platforms: ${int(f.total)}, net ${followerChangeText(f)} in the period${f.prior != null ? ` (from ${int(f.prior)})` : ""}. Say follower growth as the net change, never as a percent jump in the total.`,
  ];
  const sc = m.score;
  if (sc) {
    out.push(`Social score (Kaizen's account health, last 30 days to ${sc.window.to}): ${sc.score} of 100 (${SCORE_WORD[sc.band]}); ${sc.platforms.map((p) => `${PLATFORM_LABEL[p.platform]} ${p.score}`).join(", ")}.`);
    if (sc.lifting.length) out.push(`Lifting it: ${sc.lifting.map((r) => r.text).join("; ")}.`);
    if (sc.weighing.length) out.push(`Weighing it down: ${sc.weighing.map((r) => r.text).join("; ")}.`);
  }
  return out;
}
