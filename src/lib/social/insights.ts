import { daysBetween, shiftDay, type Platform, type PostFormat, type SocialPost } from "./core";

// The Social tab's reading of a client's numbers: windows (the last 30 days against the 30 before), followers over time
// rebuilt from daily changes, engagement rate, posts per week, formats, post sorting, and the account's health in
// plain red, amber and green with what to do. Pure, so it's tested without a browser.

export type DailyRow = { platform: Platform; date: string; followers: number | null; gained: number | null; lost: number | null; reach: number | null; views: number | null; profileViews: number | null; engaged: number | null; interactions: number | null };

export type HealthTone = "bad" | "warn" | "good";
export type HealthFinding = { id: string; tone: HealthTone; title: string; detail: string; action: string | null };

/** Engagement rate (interactions over reach) lines: under low is weak, over high is strong */
export const ENGAGEMENT_BENCH = { low: 0.015, high: 0.05 } as const;

export const engagementRate = (interactions: number | null | undefined, reach: number | null | undefined): number | null => (interactions != null && reach != null && reach > 0 ? interactions / reach : null);

// ─── Windows ───────────────────────────────────────────────────────────────

export type Window = { reach: number | null; views: number | null; interactions: number | null; profileViews: number | null; engaged: number | null; gained: number | null; lost: number | null; rate: number | null };

/** A field's total over [start, end], null when no row in it has the field (so "no data" never reads as zero) */
export function sumField(rows: DailyRow[], key: "reach" | "views" | "interactions" | "profileViews" | "engaged" | "gained" | "lost", start: string, end: string): number | null {
  let total = 0;
  let any = false;
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    const v = r[key];
    if (v == null) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

export function windowOf(rows: DailyRow[], start: string, end: string): Window {
  const reach = sumField(rows, "reach", start, end);
  const interactions = sumField(rows, "interactions", start, end);
  return { reach, views: sumField(rows, "views", start, end), interactions, profileViews: sumField(rows, "profileViews", start, end), engaged: sumField(rows, "engaged", start, end), gained: sumField(rows, "gained", start, end), lost: sumField(rows, "lost", start, end), rate: engagementRate(interactions, reach) };
}

// ─── Followers over time ───────────────────────────────────────────────────

export type FollowerPoint = { date: string; followers: number | null; estimated: boolean };

/**
 * Followers per day from `from` to `today`. A day Meta (or a read) gave a count for keeps it; the days before are
 * rebuilt backwards from the next known day by taking that day's follows and unfollows off (net = gained - lost).
 * Instagram gives follows gained but not lost, so its rebuilt days are marked estimated. `current` is the live count,
 * used for today when today's row has none. Days before the first thing known stay null.
 */
export function followerSeries(rows: DailyRow[], opts: { from: string; today: string; current: number | null; lossKnown: boolean }): FollowerPoint[] {
  const by = new Map(rows.map((r) => [r.date, r]));
  const dates: string[] = [];
  for (let d = opts.from; d <= opts.today; d = shiftDay(d, 1)) dates.push(d);
  const value = new Map<string, { v: number; est: boolean }>();
  for (const d of dates) {
    const f = by.get(d)?.followers;
    if (f != null) value.set(d, { v: f, est: false });
  }
  if (!value.has(opts.today) && opts.current != null) value.set(opts.today, { v: opts.current, est: false });
  for (let i = dates.length - 2; i >= 0; i--) {
    const d = dates[i];
    if (value.has(d)) continue;
    const next = value.get(dates[i + 1]);
    if (!next) continue;
    const nr = by.get(dates[i + 1]);
    const gained = nr?.gained ?? null;
    const lost = nr?.lost ?? null;
    // No follows that day known: the count is carried back unchanged, and said to be an estimate
    const net = gained == null ? 0 : gained - (lost ?? 0);
    value.set(d, { v: Math.max(0, next.v - net), est: next.est || !opts.lossKnown || gained == null });
  }
  return dates.map((date) => ({ date, followers: value.get(date)?.v ?? null, estimated: value.get(date)?.est ?? false }));
}

export type Growth = { now: number; change: number; pct: number | null; prevChange: number | null; estimated: boolean };

/** Followers now, the change over the last 30 days, and the 30 before; null with no count. The earliest known day stands in when 30 days back isn't known. */
export function followerGrowth(series: FollowerPoint[], today: string): Growth | null {
  const known = series.filter((p) => p.followers != null);
  if (!known.length) return null;
  const at = (day: string) => {
    const exact = series.find((p) => p.date === day && p.followers != null);
    if (exact) return exact;
    return null;
  };
  const now = [...known].reverse().find((p) => p.date <= today)!;
  const back30 = at(shiftDay(today, -30)) ?? (known[0].date < now.date ? known[0] : null);
  if (!back30) return { now: now.followers!, change: 0, pct: null, prevChange: null, estimated: now.estimated };
  const back60 = at(shiftDay(today, -60));
  const change = now.followers! - back30.followers!;
  return { now: now.followers!, change, pct: back30.followers! > 0 ? change / back30.followers! : null, prevChange: back60 ? back30.followers! - back60.followers! : null, estimated: now.estimated || back30.estimated };
}

// ─── Posts ─────────────────────────────────────────────────────────────────

export type PostView = SocialPost & { rate: number | null; rateBasis: "reach" | "followers" | null };

/** A post's engagement rate: interactions over its reach, else over the account's followers (said so), else none */
export function postRate(p: Pick<SocialPost, "interactions" | "reach">, followers: number | null): { rate: number | null; basis: "reach" | "followers" | null } {
  if (p.interactions == null) return { rate: null, basis: null };
  if (p.reach != null && p.reach > 0) return { rate: p.interactions / p.reach, basis: "reach" };
  if (followers != null && followers > 0) return { rate: p.interactions / followers, basis: "followers" };
  return { rate: null, basis: null };
}

export function withRates(posts: SocialPost[], followers: Partial<Record<Platform, number | null>>): PostView[] {
  return posts.map((p) => {
    const r = postRate(p, followers[p.platform] ?? null);
    return { ...p, rate: r.rate, rateBasis: r.basis };
  });
}

export type PostSort = "date" | "reach" | "interactions" | "rate" | "saves" | "shares";
export const POST_SORTS: PostSort[] = ["date", "reach", "interactions", "rate", "saves", "shares"];

const sortKey = (p: PostView, s: PostSort): number => {
  if (s === "date") return p.postedAt ? Date.parse(p.postedAt) : 0;
  if (s === "reach") return p.reach ?? -1;
  if (s === "interactions") return p.interactions ?? -1;
  if (s === "rate") return p.rate ?? -1;
  if (s === "saves") return p.saves ?? -1;
  return p.shares ?? -1;
};

export function sortPosts(posts: PostView[], by: PostSort, dir: "asc" | "desc" = "desc"): PostView[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...posts].sort((a, b) => sign * (sortKey(a, by) - sortKey(b, by)) || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
}

export type PostFilter = { platform: "all" | Platform; days: 30 | 60 | 90 };

export function filterPosts(posts: PostView[], f: PostFilter, today: string): PostView[] {
  const from = shiftDay(today, -(f.days - 1));
  return posts.filter((p) => (f.platform === "all" || p.platform === f.platform) && p.postedAt != null && p.postedAt.slice(0, 10) >= from);
}

/** The posts' typical rate is the median, so one viral post doesn't hide the rest */
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The best and weakest posts by engagement rate, each platform against its own posts (at least 4 with a rate), never the same post twice */
export function bestAndWeakest(posts: PostView[], n = 3): { best: PostView[]; weakest: PostView[] } {
  const rated = posts.filter((p) => p.rate != null);
  if (rated.length < 4) return { best: sortPosts(rated, "rate").slice(0, Math.min(n, rated.length > 1 ? 1 : rated.length)), weakest: [] };
  const sorted = sortPosts(rated, "rate");
  const best = sorted.slice(0, n);
  const ids = new Set(best.map((p) => `${p.platform}:${p.id}`));
  const weakest = [...sorted].reverse().filter((p) => !ids.has(`${p.platform}:${p.id}`)).slice(0, n);
  return { best, weakest };
}

export type FormatStat = { format: PostFormat; count: number; typicalRate: number | null; avgReach: number | null };

export function formatStats(posts: PostView[]): FormatStat[] {
  const by = new Map<PostFormat, PostView[]>();
  for (const p of posts) by.set(p.format, [...(by.get(p.format) ?? []), p]);
  return [...by.entries()]
    .map(([format, ps]) => {
      const rates = ps.map((p) => p.rate).filter((x): x is number => x != null);
      const reaches = ps.map((p) => p.reach).filter((x): x is number => x != null);
      return { format, count: ps.length, typicalRate: median(rates), avgReach: reaches.length ? reaches.reduce((a, b) => a + b, 0) / reaches.length : null };
    })
    .sort((a, b) => b.count - a.count);
}

/** Posts a week over [start, end] (inclusive days) */
export function postsPerWeek(posts: { postedAt: string | null }[], start: string, end: string): number {
  const days = Math.max(1, daysBetween(start, end) + 1);
  const n = posts.filter((p) => p.postedAt && p.postedAt.slice(0, 10) >= start && p.postedAt.slice(0, 10) <= end).length;
  return Math.round((n / days) * 7 * 10) / 10;
}

/** The longest stretch with no post, in days, over [start, end] (a post's day to the next, and the last post to the end) */
export function longestGap(posts: { postedAt: string | null }[], start: string, end: string): number {
  const days = [...new Set(posts.filter((p) => p.postedAt).map((p) => p.postedAt!.slice(0, 10)).filter((d) => d >= start && d <= end))].sort();
  if (!days.length) return daysBetween(start, end) + 1;
  let gap = Math.max(daysBetween(start, days[0]), daysBetween(days[days.length - 1], end));
  for (let i = 1; i < days.length; i++) gap = Math.max(gap, daysBetween(days[i - 1], days[i]) - 1);
  return gap;
}

// ─── One platform's pulse and the account's health ─────────────────────────

export type PlatformPulse = {
  platform: Platform;
  name: string | null;
  followers: number | null;
  growth: Growth | null;
  now: Window;
  before: Window;
  posts30: number;
  postsPerWeek: number;
  lastPostAt: string | null;
  longestGap: number;
  formats: FormatStat[];
  /** Whether this platform's reach and interactions are read at all (false when its insights are refused) */
  insightsRead: boolean;
};

const PLATFORM_NAME: Record<Platform, string> = { instagram: "Instagram", facebook: "Facebook" };
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const rel = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? (a - b) / b : null);
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The account's health in plain words, worst first: when it last posted, posting rhythm and the longest silence,
 * followers (lost, stalled or growing), reach and engagement rate against the 30 days before and the account's own
 * lines, the format mix (no reels, or one format clearly winning). Each says what to do.
 */
export function socialHealth(input: { today: string; platforms: PlatformPulse[] }): HealthFinding[] {
  const out: HealthFinding[] = [];
  const { today } = input;
  for (const p of input.platforms) {
    const who = PLATFORM_NAME[p.platform];
    const id = (k: string) => `${p.platform}-${k}`;
    // Cadence
    if (p.lastPostAt) {
      const since = daysBetween(p.lastPostAt.slice(0, 10), today);
      if (since >= 14) out.push({ id: id("quiet"), tone: "bad", title: `${who} hasn't posted in ${since} days`, detail: "A quiet account loses reach with every day, and the algorithm needs recent posts to show them.", action: "Get a post out this week and agree a standing rhythm with the client." });
      else if (since >= 7) out.push({ id: id("quiet"), tone: "warn", title: `${who} last posted ${since} days ago`, detail: "A week without a post starts to cost reach.", action: "Schedule the next post now." });
    } else {
      out.push({ id: id("noposts"), tone: "warn", title: `No ${who} posts found`, detail: "No recent posts were read from the account.", action: "Check the right account is linked, or that the client is posting." });
    }
    if (p.lastPostAt && p.postsPerWeek < 1 && daysBetween(p.lastPostAt.slice(0, 10), today) < 14) out.push({ id: id("cadence"), tone: "warn", title: `${who} posts under once a week`, detail: `${p.postsPerWeek} a week over the last 30 days.`, action: "Aim for 3 to 5 posts a week; batch the content so it doesn't depend on the week." });
    else if (p.postsPerWeek >= 3) out.push({ id: id("cadence-good"), tone: "good", title: `${who} posts ${p.postsPerWeek} times a week`, detail: "A steady rhythm gives the account something to compound.", action: null });
    if (p.longestGap >= 10 && p.postsPerWeek >= 1) out.push({ id: id("gap"), tone: "warn", title: `${who} went ${p.longestGap} days without a post`, detail: "Long silences inside the month break the rhythm.", action: "Keep a buffer of finished posts so a busy week doesn't leave a gap." });
    // Followers
    const g = p.growth;
    if (g) {
      if (g.change < 0) out.push({ id: id("followers-down"), tone: "bad", title: `${who} lost ${fmt(-g.change)} followers in 30 days`, detail: `Now ${fmt(g.now)}${g.prevChange != null ? `; the 30 days before moved ${g.prevChange >= 0 ? "+" : ""}${fmt(g.prevChange)}` : ""}.`, action: "Look at what was posted when it dipped; stop what lost people, and run a follow-worthy post or collab." });
      else if (g.pct != null && g.pct >= 0.03) out.push({ id: id("followers-up"), tone: "good", title: `${who} grew ${pct1(g.pct)} in 30 days`, detail: `+${fmt(g.change)} to ${fmt(g.now)}${g.prevChange != null ? `, against ${g.prevChange >= 0 ? "+" : ""}${fmt(g.prevChange)} the 30 days before` : ""}.`, action: null });
      else if (g.now >= 200 && g.pct != null && g.pct < 0.003) out.push({ id: id("followers-flat"), tone: "warn", title: `${who} followers are flat`, detail: `${g.change >= 0 ? "+" : ""}${fmt(g.change)} in 30 days on ${fmt(g.now)}.`, action: "Add content aimed at new people (reels, collabs, shareable posts), not only the people who already follow." });
    }
    // Reach and engagement
    const reachMove = rel(p.now.reach, p.before.reach);
    if (reachMove != null) {
      if (reachMove <= -0.4) out.push({ id: id("reach-down"), tone: "bad", title: `${who} reach fell ${pct0(-reachMove)}`, detail: `${fmt(p.now.reach ?? 0)} accounts reached in the last 30 days, against ${fmt(p.before.reach ?? 0)} before.`, action: "Compare the top posts of each month; bring back the format and topics that reached furthest." });
      else if (reachMove <= -0.2) out.push({ id: id("reach-down"), tone: "warn", title: `${who} reach is down ${pct0(-reachMove)}`, detail: `${fmt(p.now.reach ?? 0)} against ${fmt(p.before.reach ?? 0)} in the 30 days before.`, action: "Check posting frequency and format mix; reels reach beyond followers." });
      else if (reachMove >= 0.2) out.push({ id: id("reach-up"), tone: "good", title: `${who} reach is up ${pct0(reachMove)}`, detail: `${fmt(p.now.reach ?? 0)} accounts reached, against ${fmt(p.before.reach ?? 0)} before.`, action: null });
    }
    const er = p.now.rate;
    if (er != null) {
      const prev = p.before.rate;
      if (er < ENGAGEMENT_BENCH.low) out.push({ id: id("engagement-low"), tone: "warn", title: `${who} engagement rate is low (${pct1(er)})`, detail: `Under ${pct1(ENGAGEMENT_BENCH.low)} of the people reached interact${prev != null ? `; it was ${pct1(prev)} the 30 days before` : ""}.`, action: "Ask a question, use a stronger first line, and post what the audience saves and shares (tips, proof, behind the scenes)." });
      else if (prev != null && prev > 0 && (er - prev) / prev <= -0.25) out.push({ id: id("engagement-down"), tone: "warn", title: `${who} engagement rate dropped to ${pct1(er)}`, detail: `It was ${pct1(prev)} the 30 days before.`, action: "Look at which posts earned interactions last month and repeat their angle." });
      else if (er >= ENGAGEMENT_BENCH.high) out.push({ id: id("engagement-good"), tone: "good", title: `${who} engagement rate is strong (${pct1(er)})`, detail: "The people it reaches act on it.", action: null });
    }
    // Formats
    const fm = p.formats;
    if (p.platform === "instagram" && p.posts30 >= 4 && !fm.some((f) => f.format === "reel" && f.count > 0)) out.push({ id: id("no-reels"), tone: "warn", title: "No reels in the last 30 days", detail: "Reels are what Instagram shows to people who don't follow the account yet.", action: "Add one or two reels a week." });
    const rated = fm.filter((f) => f.count >= 3 && f.typicalRate != null);
    if (rated.length >= 2) {
      const sorted = [...rated].sort((a, b) => b.typicalRate! - a.typicalRate!);
      const top = sorted[0];
      const next = sorted[1];
      if (top.typicalRate! >= next.typicalRate! * 1.5) out.push({ id: id("format-winner"), tone: "good", title: `${who}: ${top.format === "reel" ? "reels" : top.format === "carousel" ? "carousels" : `${top.format}s`} do best`, detail: `Typical engagement ${pct1(top.typicalRate!)} against ${pct1(next.typicalRate!)} for ${next.format === "reel" ? "reels" : next.format === "carousel" ? "carousels" : `${next.format}s`}.`, action: "Make more of that format." });
    }
  }
  const rank = { bad: 0, warn: 1, good: 2 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

export function socialStatus(health: Pick<HealthFinding, "tone">[]): { tone: HealthTone; label: string } {
  const bad = health.filter((h) => h.tone === "bad").length;
  const warn = health.filter((h) => h.tone === "warn").length;
  if (bad) return { tone: "bad", label: "Needs attention" };
  if (warn > 2) return { tone: "warn", label: "Watch" };
  return { tone: "good", label: "Healthy" };
}
