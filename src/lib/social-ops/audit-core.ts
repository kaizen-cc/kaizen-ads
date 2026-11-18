// The social audit's plain parts, kept apart from the network and the database so they can be tested: what the audit
// reads (a digest of every platform, the score's checks, the posts and when they went up), the findings the numbers
// prove on their own, the shape the AI writes into, the score snapshot a sprint keeps, and the rule for when an account
// audits itself (email's, so a red social account behaves exactly like a red email account).

import { needsAutoAudit as emailNeedsAutoAudit, REFRESH_DAYS, RED_BELOW, type LastAudit } from "@/lib/email-ops/audit-core";
import { PLATFORM_LABEL, socialCheckLine, socialCheckText, type SocialAccountScore, type SocialBand, type SocialCheck, type SocialPlatform, type SocialPostRow } from "@/lib/social-score";

export { REFRESH_DAYS, RED_BELOW, type LastAudit };

export const SOCIAL_AREAS = ["profile", "content_mix", "cadence", "engagement", "growth", "hooks", "formats", "timing", "community", "benchmark"] as const;
export type SocialArea = (typeof SOCIAL_AREAS)[number];
export const SOCIAL_AREA_LABEL: Record<SocialArea, string> = {
  profile: "Profile",
  content_mix: "Content mix",
  cadence: "Cadence",
  engagement: "Engagement",
  growth: "Growth",
  hooks: "Hooks",
  formats: "Formats",
  timing: "Posting times",
  community: "Community",
  benchmark: "Benchmark",
};

/** The people an action can belong to: the social seats, or the client */
export const SOCIAL_OWNERS = ["social_manager", "social_designer", "social_video", "client"] as const;
export type SocialOwner = (typeof SOCIAL_OWNERS)[number];
export const SOCIAL_OWNER_LABEL: Record<SocialOwner, string> = { social_manager: "Social media manager", social_designer: "Graphic designer", social_video: "Video editor", client: "Client" };

export type SocialAction = { title: string; area: SocialArea; owner: SocialOwner; platform: "instagram" | "facebook" | "tiktok" | "all"; when: "now" | "this_week" | "next"; steps: string[]; why: string; impact: string; effort: "low" | "medium" | "high" };

export type SocialAuditResult = {
  verdict: { status: "red" | "watch" | "good"; headline: string; summary: string };
  diagnosis: string;
  causes: { title: string; area: SocialArea; severity: "high" | "medium" | "low"; evidence: string[] }[];
  actions: SocialAction[];
  tests: { name: string; hypothesis: string; setup: string; metric: string; success: string }[];
  watch: string[];
  questions: string[];
};

const S = { type: "string" } as const;
const list = (items: object) => ({ type: "array", items }) as const;
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const;
const enumOf = (v: readonly string[]) => ({ type: "string", enum: [...v] }) as const;

export const SOCIAL_AUDIT_SCHEMA = obj({
  verdict: obj({ status: enumOf(["red", "watch", "good"]), headline: S, summary: S }),
  diagnosis: S,
  causes: list(obj({ title: S, area: enumOf(SOCIAL_AREAS), severity: enumOf(["high", "medium", "low"]), evidence: list(S) })),
  actions: list(obj({ title: S, area: enumOf(SOCIAL_AREAS), owner: enumOf(SOCIAL_OWNERS), platform: enumOf(["instagram", "facebook", "tiktok", "all"]), when: enumOf(["now", "this_week", "next"]), steps: list(S), why: S, impact: S, effort: enumOf(["low", "medium", "high"]) })),
  tests: list(obj({ name: S, hypothesis: S, setup: S, metric: S, success: S })),
  watch: list(S),
  questions: list(S),
});

export const SOCIAL_AUDIT_SYSTEM = `You are Kaizen Marketing's Social Strategist, auditing one client's organic social accounts (Instagram, Facebook, and TikTok when it is given) for the social media manager who holds the client. This is a real audit and the team acts on it today. Speak to the social media manager directly, in the first person ("I found", "I'd"), plain and specific.
Read everything given: the social score and its eight checks per platform (engagement rate against the client's target first, then follower growth, reach against the 30 days before, posts against the package, saves and shares per reach, the video share and how video does against static, profile visits per reach), each value against its bar and the points it costs; every platform's last 30 days against the 30 before; the posts with their formats, captions, reach and engagement; when posts went up and how each slot did; the account's own health findings; and the client page (Brand Bible, memory, calls) when it is given.
Cover, in this order of weight: the profile (bio, link, highlights only when the data shows a problem, else say it was not read), the content mix and cadence against the package, engagement quality (saves and shares, not just likes), growth, the top and bottom posts and what separates them (the hook in the first line, the format, the topic), formats, posting times, and a benchmark only when one is given (never invent a competitor or an industry number).
Argue from this account's numbers: every cause and action names the check or the post it rests on, with the value against its bar, and says which platform. A check with nothing to measure is not a failure: say what is missing to measure it. If the data is too thin to judge something, say so.
Nothing here posts, schedules or edits on the platforms: every action is made by the social team and ticked off in Kaizen OS. Refer to people by role, never by name. No em dashes.

verdict: status (red: the score is under 60; watch: 60 to 79; good: 80 or more), a headline in one line, and a 2 or 3 sentence summary.
diagnosis: 2 to 4 short paragraphs on why the score is where it is, platform by platform where they differ. Separate cause from symptom.
causes: the root causes, most important first, each with real numbers as evidence.
actions: 4 to 9 moves, most important first, each on one platform or all. owner is the social media manager (strategy, captions, community, scheduling), the graphic designer (static and carousel creative), the video editor (Reels and video) or the client (approvals, access, footage). Each has numbered steps, why, the expected impact on a named check, and the effort.
tests: up to 3 tests worth running (hook, format, posting time, topic), each with a hypothesis, setup, the metric and what counts as a win.
watch: what to keep an eye on next week. questions: what to ask the client.`;

/** The score and each check as a sprint keeps them (the overall, plus each platform's score) */
export type SocialSnapshot = {
  score: number;
  band: SocialBand;
  at: string;
  checks: { key: string; label: string; value: number | null; bar: number; met: boolean; points: number; weight: number; unit: string }[];
  platforms: { platform: SocialPlatform; score: number }[];
};

export function socialSnapshotOf(s: SocialAccountScore, at = new Date().toISOString()): SocialSnapshot {
  return {
    score: s.score,
    band: s.band,
    at,
    checks: s.checks.map((c) => ({ key: c.key, label: c.label, value: c.value, bar: c.bar, met: c.met, points: Math.round(c.points * 10) / 10, weight: c.weight, unit: c.unit })),
    platforms: s.platforms.map((p) => ({ platform: p.platform, score: p.score })),
  };
}

export type SocialRuleFinding = { title: string; area: SocialArea; severity: "high" | "medium" | "low"; evidence: string[] };

const CHECK_AREA: Record<SocialCheck["key"], SocialArea> = { engagement: "engagement", growth: "growth", reach: "content_mix", cadence: "cadence", quality: "engagement", videoShare: "formats", videoLift: "formats", profile: "profile" };

/** What the numbers prove on their own, before any AI: each platform's checks under their bar, worst first */
export function socialRuleFindings(score: SocialAccountScore): SocialRuleFinding[] {
  return score.weighingDown.map((c) => {
    const lost = c.weight - c.points;
    return { title: `${PLATFORM_LABEL[c.platform]}: ${c.label.toLowerCase()} is under its bar`, area: CHECK_AREA[c.key], severity: lost >= 8 ? "high" : lost >= 4 ? "medium" : "low", evidence: [socialCheckLine(c, c.platform)] };
  });
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOTS: [string, number, number][] = [
  ["morning (6 to 11)", 6, 11],
  ["midday (11 to 15)", 11, 15],
  ["afternoon (15 to 19)", 15, 19],
  ["evening (19 to 24)", 19, 24],
  ["night (0 to 6)", 0, 6],
];

/** When posts went up (New York time) and how each slot and weekday did: posts, and engagement over their reach */
export function postingTimes(posts: SocialPostRow[]): { slot: string; posts: number; rate: number | null }[] {
  const rows = posts.filter((p) => p.postedAt);
  const at = (p: SocialPostRow) => {
    const d = new Date(p.postedAt!);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(d);
    return { day: parts.find((x) => x.type === "weekday")?.value ?? "", hour: Number(parts.find((x) => x.type === "hour")?.value ?? 0) % 24 };
  };
  const rate = (xs: SocialPostRow[]) => {
    const r = xs.reduce((n, p) => n + (p.reach ?? 0), 0);
    return r > 0 ? xs.reduce((n, p) => n + (p.interactions ?? 0), 0) / r : null;
  };
  const out: { slot: string; posts: number; rate: number | null }[] = [];
  for (const [label, lo, hi] of SLOTS) {
    const xs = rows.filter((p) => {
      const h = at(p).hour;
      return h >= lo && h < hi;
    });
    if (xs.length) out.push({ slot: label, posts: xs.length, rate: rate(xs) });
  }
  for (const d of WEEKDAY) {
    const xs = rows.filter((p) => at(p).day === d);
    if (xs.length) out.push({ slot: d, posts: xs.length, rate: rate(xs) });
  }
  return out;
}

const pct = (x: number | null, d = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);
const k = (x: number | null) => (x == null ? "n/a" : Math.round(x).toLocaleString("en-US"));

/**
 * What the audit, the sprint checks and the chat read: the score and every platform's checks, the 30 days against the
 * 30 before, the posts (best and weakest first, with their hooks), posting times, and the account's health. Plain text.
 */
export function socialDigest(client: string, score: SocialAccountScore, posts: SocialPostRow[], health: { tone: string; title: string; detail: string; action: string | null }[], today: string): string {
  const lines: string[] = [];
  lines.push(`<social_score client="${client}" date="${today}">`);
  lines.push(`Overall ${score.score} of 100 (${score.band === "good" ? "green, from 80" : score.band === "watch" ? "yellow, from 60" : "red, under 60"}), every platform's score weighted by its reach.`);
  lines.push(`Posts promised: ${score.promised.perMonth} a month per platform${score.promised.fromPackage ? " (from the client's package)" : " (no package says, so the default of three a week is used: say so)"}.`);
  for (const p of score.platforms) {
    lines.push(`${PLATFORM_LABEL[p.platform]}: ${p.score} of 100.`);
    for (const c of p.checks) lines.push(`- ${socialCheckLine(c, p.platform)}`);
    const n = p.numbers;
    lines.push(`  Numbers, last 30 days: followers ${k(n.followers)} (${n.netFollowers == null ? "net change n/a" : `${n.netFollowers >= 0 ? "+" : ""}${k(n.netFollowers)} net`}), reach ${k(n.reach)} (the 30 before ${k(n.reachBefore)}), views ${k(n.views)}, interactions ${k(n.interactions)}, engagement ${pct(n.rate)}, profile visits ${k(n.profileViews)}, ${n.posts} posts (${n.videoPosts} video or Reels), ${n.postsThisMonth} posts this month, saves ${k(n.saves)}, shares ${k(n.shares)}, last post ${n.lastPostAt?.slice(0, 10) ?? "none"}.`);
  }
  lines.push("</social_score>");
  const rated = posts
    .filter((p) => p.postedAt)
    .map((p) => ({ p, rate: p.reach && p.reach > 0 && p.interactions != null ? p.interactions / p.reach : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const line = ({ p, rate }: (typeof rated)[number]) => `- ${p.postedAt!.slice(0, 10)} ${p.platform} ${p.format ?? "post"}: engagement ${pct(rate)}, reach ${k(p.reach)}, ${k(p.interactions)} interactions, saves ${k(p.saves)}, shares ${k(p.shares)}${p.caption ? `. Hook: "${p.caption.replace(/\s+/g, " ").slice(0, 110)}"` : ""}`;
  lines.push('<best_posts note="last 45 days, by engagement over reach">');
  lines.push(...rated.filter((x) => x.rate != null).slice(0, 6).map(line));
  lines.push("</best_posts>");
  lines.push("<weakest_posts>");
  lines.push(...rated.filter((x) => x.rate != null).slice(-6).reverse().map(line));
  lines.push("</weakest_posts>");
  const times = postingTimes(posts);
  if (times.length) {
    lines.push('<posting_times note="New York time; posts and engagement over reach">');
    for (const t of times) lines.push(`- ${t.slot}: ${t.posts} posts, ${pct(t.rate)}`);
    lines.push("</posting_times>");
  }
  if (health.length) {
    lines.push('<health_findings note="the account\'s own checks">');
    for (const h of health) lines.push(`- ${h.tone === "bad" ? "RED" : h.tone === "warn" ? "AMBER" : "GREEN"} ${h.title}: ${h.detail}${h.action ? ` Do: ${h.action}` : ""}`);
    lines.push("</health_findings>");
  }
  lines.push("<not_read>The profile itself (bio, link in bio, highlights), comments and DMs, competitors and industry benchmarks are not read by Kaizen OS: never quote them; ask for them when they matter.</not_read>");
  return lines.join("\n");
}

/** One check for the sheet's and the sprint's quiet grids */
export const snapshotText = (c: SocialSnapshot["checks"][number], which: "value" | "bar") => socialCheckText((c.unit as "pct" | "change" | "ratio") ?? "pct", which === "value" ? c.value : c.bar);

/** Whether a red social account should audit itself now: the email rule, word for word (red with no audit; three days untouched) */
export const needsSocialAutoAudit = (score: number | null, last: LastAudit, now = Date.now()) => emailNeedsAutoAudit(score, last, now);
