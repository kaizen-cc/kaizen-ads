import type { Move } from "@/lib/reports/weekly-core";
import type { Sections } from "@/lib/reports/write";
import { DEFAULT_ENGAGEMENT_BAR } from "@/lib/social-score";
import { int, moveOf, pct, signed, type SocialMetrics, type SocialPostLite } from "./core";
import { followerView, type FollowerView } from "./social-followers";
import { basisLabel, NOT_REPORTED } from "@/lib/social/rate";
import { teamFindingsOf } from "./social-notes";

// The organic social report's views, pure so the PDF (social-doc.tsx), the tests and the writer read the same thing:
// the engagement target, the follower comparison over the same
// platforms, the month to date as one row, captions that are safe for the PDF's fonts and cut between words, and the
// insight cards with what we'll do next.

// ─── The engagement target ─────────────────────────────────────────────────
// The social score (Kaizen's own account health, social-score.ts) is internal: the KPI board, Overview and audits read it.
// A client's report never draws or quotes it; the only thing it keeps from that read is the engagement target.

/** The engagement target the report holds every rate against: the client's own when it has one, else Kaizen's 5% */
export function engagementBarOf(m: SocialMetrics): number {
  if (m.engagementTarget) return m.engagementTarget;
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

/**
 * The small label on a rate that isn't the standard one ("by views", "by followers", "by post reach"); null for the reach rate.
 * The engagement target is set on reach, so only a reach rate is held to it.
 */
export const rateLabelOf = (n: { rateBasis?: "reach" | "views" | "followers" | null; reachFrom?: "meta" | "posts" | null }): string | null => basisLabel(n.rateBasis ?? "reach", n.reachFrom);

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
  const basisNote = rateLabelOf(now);
  const vs = basisNote ? null : againstBar(now.rate, target);
  const cell = (key: string, label: string, a: number | null, b: number | null, f: (n: number | null) => string, better: "up" | "down" | "none" = "up"): MtdCell => ({ key, label, value: f(a), before: f(b), move: moveOf(a, b, better) });
  return [
    cell("posts", "Posts", now.posts, before.posts, int, "none"),
    ...(m.insightsRead
      ? [
          { ...cell("reach", "Reach", now.reach, before.reach, int), note: now.reach == null ? NOT_REPORTED.reach : now.reachFrom === "posts" ? "from the posts" : null },
          cell("views", "Views", now.views, before.views, int),
          { ...cell("rate", "Engagement", now.rate, before.rate, (n) => pct(n)), note: basisNote ?? (vs ? `${pct(target, 0)} target · ${vs.text}` : null), tone: vs ? (vs.met ? ("good" as const) : ("bad" as const)) : null },
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

export type Insight = { title: string; text: string; next: string | null; tone: "good" | "bad" | "neutral"; /** The strategist's own note on this card (the team's words, shown as such) */ teamNote?: string | null };

const rel = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? (a - b) / b : null);
const pctWord = (x: number) => `${Math.abs(x * 100).toFixed(1)}%`;
const toneOfRel = (x: number | null): Insight["tone"] => (x == null || Math.abs(x) < 0.005 ? "neutral" : x > 0 ? "good" : "bad");

/**
 * Three or four cards: the writer's own (with its "what we'll do next" line) when it wrote them, else worked out from the
 * numbers. A written card without a next line keeps its words and gets none: a plan is never invented for it.
 */
/** The cards as drawn: the writer's or worked out from the numbers, each with the strategist's note on it when they wrote one */
export function socialInsights(m: SocialMetrics, sections: Sections): Insight[] {
  const notes = teamFindingsOf(sections).cards;
  return baseInsights(m, sections).map((t, i) => (notes[i] ? { ...t, teamNote: notes[i] } : t));
}

function baseInsights(m: SocialMetrics, sections: Sections): Insight[] {
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
    const basisNote = rateLabelOf(m.now);
    const vs = basisNote ? null : againstBar(m.now.rate, target);
    const over = m.now.rateBasis === "views" ? `${int(m.now.views)} views` : m.now.rateBasis === "followers" ? `${int(m.now.followers)} followers, per post` : `${int(m.now.reach)} reached`;
    out.push({
      title: basisNote ? `Engagement ${pct(m.now.rate)} ${basisNote}` : `Engagement ${pct(m.now.rate)} vs ${pct(target, 0)} target`,
      text: `${int(m.now.interactions)} likes, comments, shares and saves on ${over}${m.before.rate != null ? `, against ${pct(m.before.rate)} in ${m.compare.label}` : ""}.`,
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

/** The engagement target and the follower change over the same platforms, as lines for the writer (never the internal social score) */
export function socialScoreText(m: SocialMetrics): string[] {
  const f = followersOf(m);
  const target = engagementBarOf(m);
  return [
    `Engagement target: ${pct(target, 0)} (${m.engagementTarget && m.engagementTarget !== DEFAULT_ENGAGEMENT_BAR ? "the client's own" : "Kaizen's standard"}); quote a reach-based engagement rate against it. A rate marked "by views", "by followers" or "by post reach" is on another basis: say which, and never compare it with the target or with a reach-based rate.`,
    `Followers across the platforms: ${int(f.total)}, net ${followerChangeText(f)} in the period${f.prior != null ? ` (from ${int(f.prior)})` : ""}. Say follower growth as the net change, never as a percent jump in the total.`,
  ];
}
