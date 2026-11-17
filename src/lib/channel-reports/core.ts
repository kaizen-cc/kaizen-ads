import type { Move } from "@/lib/reports/weekly-core";
import type { EmailScoreResult } from "@/lib/email-score-calc";
import { lastFullWeek, previousPeriod, rangeLabel, shiftDay, type Range } from "@/lib/reports/period";
import { BENCHMARKS, deliverabilityOutliers, pulseWindow, type CampaignLite, type DailyRow as EmailDay, type FlowLite, type KeyFlow, type PulseWindow } from "@/lib/klaviyo/insights";
import { postRate, withRates, windowOf, type DailyRow as SocialDay, type PostView, type Window as SocialWindow } from "@/lib/social/insights";
import type { Platform as SocialPlatformKey, PostFormat, SocialPost } from "@/lib/social/core";
import type { RefreshNote } from "@/lib/reports/refresh-core";
import { emailDetail, type EmailDetail, type FlowDay, type Pair, type Upcoming } from "./email-detail";
import { locationChecks, type LocationBreakdown } from "@/lib/klaviyo/locations";

// Email (Klaviyo) and organic social reports as plain functions, free of server code and the database so they are tested:
// which reports exist (platform, line, cadence), the report's dates (the month just over against the month before, or the
// week just over against the week before), the numbers worked out from the daily rows, campaigns, flows and posts the
// client page already reads, the tiles and takeaways the PDF and the share page draw, target against actual, what the QA
// must never miss, and what counts as a real change when the numbers are refreshed before the report goes out.
// A channel report's metrics are kept on reports.metrics like an ads report's, with the same `main` and `compare` dates,
// so the period checks and the refresh notice work for both.

// ─── Which report ──────────────────────────────────────────────────────────

export type ChannelPlatform = "klaviyo" | "social";
export type ChannelLine = "email" | "social";
export type ChannelKind = "weekly" | "monthly";

export const CHANNEL_PLATFORMS: readonly ChannelPlatform[] = ["klaviyo", "social"];
export const isChannelPlatform = (p: unknown): p is ChannelPlatform => p === "klaviyo" || p === "social";
export const lineOfPlatform = (p: ChannelPlatform): ChannelLine => (p === "klaviyo" ? "email" : "social");
export const platformOfLine = (l: ChannelLine): ChannelPlatform => (l === "email" ? "klaviyo" : "social");
export const lineName = (l: ChannelLine) => (l === "email" ? "Email" : "Social");
export const channelName = (p: ChannelPlatform) => (p === "klaviyo" ? "Email marketing" : "Organic social");
export const ADS_PLATFORMS = ["meta", "google", "tiktok"] as const;

/** The seat that owns a line's reports on a client (the strategist or the social media manager) */
export const OWNER_SEAT: Record<ChannelLine, string> = { email: "email_strategist", social: "social_manager" };
/** The service a client buys for each line (clients.services slugs) */
export const LINE_SERVICE: Record<ChannelLine, string> = { email: "email-marketing", social: "social-media" };

// ─── Dates ─────────────────────────────────────────────────────────────────

export type Window = Range & { label: string };

const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const monthName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** The month before the one `day` is in: its first and last day */
export function lastMonthOf(day: string): Range {
  const end = shiftDay(monthStart(day), -1);
  return { start: monthStart(end), end };
}

/**
 * The report's dates: a monthly covers the calendar month just over (against the month before it), a weekly the Monday
 * to Sunday just over (against the 7 days before it). `today` is the day it is drafted, in New York.
 */
export function channelPeriods(kind: ChannelKind, today: string): { main: Window; compare: Window } {
  if (kind === "monthly") {
    const main = lastMonthOf(today);
    const compare = lastMonthOf(main.start);
    return { main: { ...main, label: monthName(main.start) }, compare: { ...compare, label: monthName(compare.start) } };
  }
  const main = lastFullWeek(today);
  const compare = previousPeriod(main);
  return { main: { ...main, label: rangeLabel(main, today) }, compare: { ...compare, label: rangeLabel(compare, today) } };
}

/** The window for a report that already has its dates (a monthly keeps its month, a weekly its seven days) */
export function windowsFor(kind: ChannelKind, period: Range, today: string): { main: Window; compare: Window } {
  const compare = kind === "monthly" ? lastMonthOf(period.start) : previousPeriod(period);
  return {
    main: { ...period, label: kind === "monthly" ? monthName(period.start) : rangeLabel(period, today) },
    compare: { ...compare, label: kind === "monthly" ? monthName(compare.start) : rangeLabel(compare, today) },
  };
}

/** The reports to queue on a weekday: the monthly on the first business days (day 1 to 3 of the month, a weekday), the weekly on Mondays that aren't the month's first business day */
/**
 * The same rhythm as the ads reports: every Monday from 5am New York a weekly, except the month's first Monday, which
 * gets last month's monthly instead (a weekly and a monthly the same Monday would say the same thing twice).
 */
export function dueKinds(p: { weekday: string; dom: number; hour: number }): ChannelKind[] {
  if (p.weekday !== "Mon" || p.hour < 5) return [];
  return p.dom <= 7 ? ["monthly"] : ["weekly"];
}

// ─── Numbers ───────────────────────────────────────────────────────────────

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const etDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");
const daysIn = (r: Range) => Math.round((Date.parse(`${r.end}T12:00:00Z`) - Date.parse(`${r.start}T12:00:00Z`)) / 86_400_000) + 1;

/** A line of what the client targets (set by the team on the KPI board), against what the period did */
export type TargetLine = { metric: string; label: string; unit: "money" | "percent" | "count"; target: number; actual: number | null; /** actual over target, a fraction */ progress: number | null; basis: string };

/** What the team set for a client's line (public.channel_targets): a metric name and a number */
export type TargetRow = { metric: string; target: number; /** Where the number came from: last month + 10% by itself, or typed on the board */ source?: "floor" | "manual" | null };

type Dim = { start: string; end: string };
/** 7-day buckets ending on the report's last day, oldest first: the trend the PDF draws */
export function weekBuckets(end: string, n: number): (Dim & { label: string })[] {
  const out: (Dim & { label: string })[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const e = shiftDay(end, -7 * i);
    const s = shiftDay(e, -6);
    const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    out.push({ start: s, end: e, label: `${f(s)}` });
  }
  return out;
}

// ─── Email ─────────────────────────────────────────────────────────────────

export type EmailCampaign = {
  id: string;
  name: string;
  subject: string | null;
  channel: string;
  sendDay: string;
  recipients: number;
  delivered: number;
  openRate: number | null;
  clickRate: number | null;
  unsubscribes: number;
  revenue: number;
  conversions: number;
  revenuePerRecipient: number | null;
  /** The email's picture from its saved preview (a link; the PDF fetches it), null when there is no preview */
  image: string | null;
};
export type EmailFlow = { id: string; name: string; status: string | null; trigger: string | null; revenue: number; recipients: number; openRate: number | null; clickRate: number | null; share: number | null };
export type DeliverabilityFlag = { tone: "bad" | "warn"; text: string };
export type TrendPoint = { label: string; start: string; end: string; value: number; extra?: number };

/** The email account score as the report keeps it: read when the numbers were gathered, over the 30 days to that day (not the report's own dates) */
export type EmailScoreSnapshot = Pick<EmailScoreResult, "score" | "band" | "checks" | "weighingDown" | "unmeasured" | "window">;
export const scoreSnapshot = (r: EmailScoreResult): EmailScoreSnapshot => ({ score: r.score, band: r.band, checks: r.checks, weighingDown: r.weighingDown, unmeasured: r.unmeasured, window: r.window });

export type EmailMetrics = {
  platform: "klaviyo";
  /** The email provider the numbers come from, by name (older reports have none: Klaviyo) */
  source?: string;
  /** False when that source reports no revenue: revenue, orders and their rates are left out, never shown as zero */
  revenueMeasured?: boolean;
  version: 1;
  kind: ChannelKind;
  currency: string | null;
  account: string | null;
  main: Window;
  compare: Window;
  now: PulseWindow;
  before: PulseWindow;
  campaigns: EmailCampaign[];
  campaignsTotal: number;
  flows: EmailFlow[];
  /** What the flow table covers: Klaviyo reports flows over their last 30 days, read on this day */
  flowsBasis: string;
  keyFlows: { label: string; state: KeyFlow["state"] }[];
  list: { profiles: number | null; net: number | null; subscribed: number | null; unsubscribed: number | null };
  trend: TrendPoint[];
  flags: DeliverabilityFlag[];
  target: TargetLine | null;
  gaps: string[];
  through: string | null;
  refreshNote?: RefreshNote;
  /** The account score (older stored reports have none) */
  score?: EmailScoreSnapshot | null;
  /** Orders, the daily split, each campaign and flow for the period, deliverability and subscribers (older stored reports have none) */
  detail?: EmailDetail | null;
  /** Dated campaigns after the period: scheduled in Klaviyo or planned by the team */
  upcoming?: Upcoming[];
  /** Numbers the owner stated in the chat, over the synced ones (stated.ts) */
  stated?: StatedMark;
  /** Each ranked conversion metric side by side, primary first (only when more than one is ranked) */
  byMetric?: MetricSide[] | null;
  /** A multi-location client's orders by restaurant for the campaigns sent (undefined: not multi-location; null: flagged, nothing read) */
  locations?: LocationBreakdown | null;
  /** What Klaviyo attributes to the same campaigns per metric, for the QA's check that the locations add up */
  locationAttributed?: Record<string, number>;
};

/** One ranked conversion metric's numbers for the period and the one before: attributed revenue and conversions, and the store's own total */
export type MetricSide = { id: string; name: string; revenue: Pair; conversions: Pair; store: Pair };

/** Which numbers on a report were stated by its owner, and where they read them */
export type StatedMark = { source: string; keys: string[] };

export type EmailInput = {
  kind: ChannelKind;
  main: Window;
  compare: Window;
  /** Today in New York, for the flows' read date */
  today: string;
  days: EmailDay[];
  campaigns: CampaignLite[];
  flows: FlowLite[];
  keyFlows: KeyFlow[];
  /** The list sizes now and at the period's edges, when the snapshots give them */
  profiles: number | null;
  currency: string | null;
  account: string | null;
  /** The provider's name and whether it reports revenue (Klaviyo when not given) */
  source?: string;
  revenueMeasured?: boolean;
  /** campaign id → the picture of its saved email */
  images?: Map<string, string | null>;
  target?: TargetLine | null;
  /** Each flow's numbers per day (klaviyo_flow_daily); null when they aren't stored */
  flowDays?: FlowDay[] | null;
  /** The main list's size on the days it was read */
  sizes?: { date: string; profiles: number }[];
  upcoming?: Upcoming[];
};

/** Campaigns that reached someone in the window (a scheduled, cancelled or test one with no recipients doesn't count) */
export const campaignsIn = <T extends { sendTime: string | null; recipients: number }>(list: T[], start: string, end: string) =>
  list.filter((c) => {
    const d = etDay(c.sendTime);
    return d >= start && d <= end && c.recipients > 0;
  });

/** The dates in the window with no daily row (the sync didn't reach them, or they are still to come) */
export function missingDays(days: { date: string }[], start: string, end: string): string[] {
  const have = new Set(days.map((d) => d.date));
  const out: string[] = [];
  for (let d = start; d <= end; d = shiftDay(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

const flowWindowTotal = (flows: FlowLite[], win: Range, today: string, field: "revenue" | "recipients") => {
  // Klaviyo reports each flow over its last 30 and 90 days only: used as a backstop when the daily rows are missing
  const f30 = sum(flows, (f) => (field === "revenue" ? f.revenue30 : f.recipients30));
  const f90 = sum(flows, (f) => (field === "revenue" ? f.revenue90 : f.recipients90));
  const recent = win.end >= shiftDay(today, -4);
  return recent ? (f30 / 30) * daysIn(win) : (Math.max(0, f90 - f30) / 60) * daysIn(win);
};

export function emailMetrics(i: EmailInput): EmailMetrics {
  const win = (w: Window) => pulseWindow({ days: i.days, campaigns: i.campaigns, start: w.start, end: w.end, flowTotal: flowWindowTotal(i.flows, w, i.today, "revenue"), flowRecipients: flowWindowTotal(i.flows, w, i.today, "recipients") });
  const now = win(i.main);
  const before = win(i.compare);
  const sent = campaignsIn(i.campaigns, i.main.start, i.main.end);
  const campaigns: EmailCampaign[] = [...sent]
    .sort((a, b) => b.revenue - a.revenue || b.recipients - a.recipients)
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      name: c.name,
      subject: c.subject,
      channel: c.channel,
      sendDay: etDay(c.sendTime),
      recipients: c.recipients,
      delivered: c.delivered,
      openRate: c.channel === "sms" ? null : c.openRate,
      clickRate: c.clickRate,
      unsubscribes: c.unsubscribes,
      revenue: round(c.revenue),
      conversions: c.conversions,
      revenuePerRecipient: c.recipients ? round(c.revenue / c.recipients, 3) : null,
      image: i.images?.get(c.id) ?? null,
    }));
  const flowRevenue = sum(i.flows, (f) => f.revenue30);
  const flows: EmailFlow[] = [...i.flows]
    .filter((f) => f.revenue30 > 0 || (f.status ?? "").toLowerCase() === "live")
    .sort((a, b) => b.revenue30 - a.revenue30)
    .slice(0, 10)
    .map((f) => ({ id: f.id, name: f.name, status: f.status, trigger: f.trigger, revenue: round(f.revenue30), recipients: f.recipients30, openRate: f.openRate30, clickRate: f.clickRate30, share: flowRevenue > 0 ? f.revenue30 / flowRevenue : null }));
  const inMain = i.days.filter((d) => d.date >= i.main.start && d.date <= i.main.end);
  const sub = inMain.filter((d) => d.subscribed != null || d.unsubscribed != null);
  const subscribed = sub.length ? sum(sub, (d) => d.subscribed ?? 0) : null;
  const unsubscribed = sub.length ? sum(sub, (d) => d.unsubscribed ?? 0) : null;
  const trend = weekBuckets(i.main.end, 8).map((w) => {
    const ds = i.days.filter((d) => d.date >= w.start && d.date <= w.end);
    return { ...w, value: round(sum(ds, (d) => d.revenue)), extra: round(sum(ds, (d) => d.flowRevenue)) };
  });
  const through = i.days.filter((d) => d.revenue || d.sends || d.storeRevenue).map((d) => d.date).sort().at(-1) ?? null;
  const gaps = i.days.length ? missingDays(i.days, i.main.start, i.main.end) : [];
  const m: EmailMetrics = {
    platform: "klaviyo",
    ...(i.source && i.source !== "Klaviyo" ? { source: i.source } : {}),
    ...(i.revenueMeasured === false ? { revenueMeasured: false } : {}),
    version: 1,
    kind: i.kind,
    currency: i.currency,
    account: i.account,
    main: i.main,
    compare: i.compare,
    now,
    before,
    campaigns,
    campaignsTotal: sent.length,
    flows,
    flowsBasis: `${i.source ?? "Klaviyo"}'s flow report, last 30 days to ${shortDay(i.today)}`,
    keyFlows: i.keyFlows.map((k) => ({ label: k.label, state: k.state })),
    list: { profiles: i.profiles, net: sub.length ? (subscribed ?? 0) - (unsubscribed ?? 0) : null, subscribed, unsubscribed },
    trend,
    flags: emailFlags(sent, now),
    target: i.target ?? null,
    gaps,
    through,
    detail: emailDetail({ main: i.main, compare: i.compare, days: i.days, campaigns: i.campaigns, flowDays: i.flowDays ?? null, flows: i.flows, sizes: i.sizes ?? [] }),
    upcoming: i.upcoming ?? [],
  };
  return m;
}

/** Deliverability in plain words: campaigns over the healthy lines on bounces, spam or unsubscribes, and the period's rates */
export function emailFlags(sent: CampaignLite[], now: PulseWindow): DeliverabilityFlag[] {
  const out: DeliverabilityFlag[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  if (now.spamRate != null && now.spamRate > BENCHMARKS.spam.bad) out.push({ tone: "bad", text: `Spam complaints ran at ${pct(now.spamRate)} of delivered email, above the ${pct(BENCHMARKS.spam.bad)} line mailbox providers act on.` });
  else if (now.spamRate != null && now.spamRate > BENCHMARKS.spam.warn) out.push({ tone: "warn", text: `Spam complaints ran at ${pct(now.spamRate)}, above the healthy ${pct(BENCHMARKS.spam.warn)}.` });
  if (now.bounceRate != null && now.bounceRate > BENCHMARKS.bounce.bad) out.push({ tone: "bad", text: `Bounces were ${pct(now.bounceRate)} of recipients, above the ${pct(BENCHMARKS.bounce.bad)} line. The list needs cleaning.` });
  else if (now.bounceRate != null && now.bounceRate > BENCHMARKS.bounce.warn) out.push({ tone: "warn", text: `Bounces were ${pct(now.bounceRate)} of recipients, above the healthy ${pct(BENCHMARKS.bounce.warn)}.` });
  if (now.unsubscribeRate != null && now.unsubscribeRate > BENCHMARKS.unsubscribe.bad) out.push({ tone: "bad", text: `Unsubscribes were ${pct(now.unsubscribeRate)} of delivered email, above the ${pct(BENCHMARKS.unsubscribe.bad)} line.` });
  else if (now.unsubscribeRate != null && now.unsubscribeRate > BENCHMARKS.unsubscribe.warn) out.push({ tone: "warn", text: `Unsubscribes were ${pct(now.unsubscribeRate)}, above the healthy ${pct(BENCHMARKS.unsubscribe.warn)}.` });
  const worst = deliverabilityOutliers(sent)[0];
  if (worst) {
    const kinds = worst.issues.map((x) => `${x.kind === "unsubscribe" ? "unsubscribes" : x.kind === "spam" ? "spam complaints" : "bounces"} ${pct(x.rate)}`).join(", ");
    out.push({ tone: "warn", text: `"${worst.campaign.name}" had ${kinds}.` });
  }
  return out;
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ─── Social ────────────────────────────────────────────────────────────────

export type SocialNumbers = {
  followers: number | null;
  /** Followers at the start of the period (the day before it), for the change */
  followersStart: number | null;
  followerChange: number | null;
  gained: number | null;
  lost: number | null;
  reach: number | null;
  views: number | null;
  interactions: number | null;
  engaged: number | null;
  profileViews: number | null;
  rate: number | null;
  posts: number;
};
export type SocialPostLite = {
  id: string;
  platform: SocialPlatformKey;
  format: PostFormat;
  caption: string | null;
  permalink: string | null;
  thumbnail: string | null;
  postedAt: string | null;
  reach: number | null;
  views: number | null;
  interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  rate: number | null;
  rateBasis: "reach" | "followers" | null;
};
export type SocialPlatformNumbers = { platform: SocialPlatformKey; name: string | null; now: SocialNumbers; before: SocialNumbers };

export type SocialMetrics = {
  platform: "social";
  version: 1;
  kind: ChannelKind;
  main: Window;
  compare: Window;
  now: SocialNumbers;
  before: SocialNumbers;
  platforms: SocialPlatformNumbers[];
  posts: SocialPostLite[];
  postsTotal: number;
  formats: { format: PostFormat; count: number }[];
  trend: TrendPoint[];
  target: TargetLine | null;
  gaps: string[];
  through: string | null;
  /** Whether Meta gave reach and interactions at all (when it didn't, the engagement rate is left out, never shown as 0) */
  insightsRead: boolean;
  refreshNote?: RefreshNote;
  stated?: StatedMark;
};

export type SocialInput = {
  kind: ChannelKind;
  main: Window;
  compare: Window;
  days: SocialDay[];
  posts: SocialPost[];
  names: Partial<Record<SocialPlatformKey, string | null>>;
  /** The live follower count per platform, used when the rows have none for the period's end */
  current?: Partial<Record<SocialPlatformKey, number | null>>;
  target?: TargetLine | null;
};

/** A platform's follower count on a day: the latest row on or before it that has one */
export function followersOn(rows: SocialDay[], platform: SocialPlatformKey, day: string): number | null {
  let best: { date: string; v: number } | null = null;
  for (const r of rows) {
    if (r.platform !== platform || r.followers == null || r.date > day) continue;
    if (!best || r.date > best.date) best = { date: r.date, v: r.followers };
  }
  return best ? best.v : null;
}

/** The change over a period: followers at its end against the day before it, else follows gained less lost (null when neither is known) */
export function followerChangeOver(rows: SocialDay[], platform: SocialPlatformKey, win: Range): { start: number | null; end: number | null; change: number | null } {
  const end = followersOn(rows, platform, win.end);
  const start = followersOn(rows, platform, shiftDay(win.start, -1));
  if (end != null && start != null) return { start, end, change: end - start };
  const mine = rows.filter((r) => r.platform === platform && r.date >= win.start && r.date <= win.end);
  const gained = mine.filter((r) => r.gained != null);
  if (gained.length) return { start, end, change: sum(gained, (r) => r.gained ?? 0) - sum(mine, (r) => r.lost ?? 0) };
  return { start, end, change: null };
}

function numbersFor(rows: SocialDay[], posts: PostView[], platform: SocialPlatformKey | null, win: Range, current: number | null): SocialNumbers {
  const mine = platform ? rows.filter((r) => r.platform === platform) : rows;
  const w: SocialWindow = windowOf(mine, win.start, win.end);
  const inWin = posts.filter((p) => p.postedAt && etDay(p.postedAt) >= win.start && etDay(p.postedAt) <= win.end && (!platform || p.platform === platform));
  if (platform) {
    const f = followerChangeOver(rows, platform, win);
    return { followers: f.end ?? current, followersStart: f.start, followerChange: f.change, gained: w.gained, lost: w.lost, reach: w.reach, views: w.views, interactions: w.interactions, engaged: w.engaged, profileViews: w.profileViews, rate: w.rate, posts: inWin.length };
  }
  return { followers: null, followersStart: null, followerChange: null, gained: w.gained, lost: w.lost, reach: w.reach, views: w.views, interactions: w.interactions, engaged: w.engaged, profileViews: w.profileViews, rate: w.rate, posts: inWin.length };
}

/** Both platforms added up (a platform that gives nothing for a number leaves it out of the total, and says null when none does) */
export function combineNumbers(list: SocialNumbers[]): SocialNumbers {
  const add = (k: keyof SocialNumbers) => {
    const xs = list.map((n) => n[k]).filter((x): x is number => typeof x === "number");
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };
  const reach = add("reach");
  const interactions = add("interactions");
  return {
    followers: add("followers"),
    followersStart: list.every((n) => n.followersStart != null) && list.length ? add("followersStart") : null,
    followerChange: add("followerChange"),
    gained: add("gained"),
    lost: add("lost"),
    reach,
    views: add("views"),
    interactions,
    engaged: add("engaged"),
    profileViews: add("profileViews"),
    rate: reach && interactions != null ? interactions / reach : null,
    posts: list.reduce((a, n) => a + n.posts, 0),
  };
}

const clip = (s: string | null, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);

export function socialMetrics(i: SocialInput): SocialMetrics {
  const platforms = (["instagram", "facebook"] as const).filter((p) => i.days.some((r) => r.platform === p) || i.posts.some((x) => x.platform === p) || i.names[p]);
  const latest: Partial<Record<SocialPlatformKey, number | null>> = {};
  for (const p of platforms) latest[p] = followersOn(i.days, p, i.main.end) ?? i.current?.[p] ?? null;
  const rated = withRates(i.posts, latest);
  const per: SocialPlatformNumbers[] = platforms.map((p) => ({ platform: p, name: i.names[p] ?? null, now: numbersFor(i.days, rated, p, i.main, latest[p] ?? null), before: numbersFor(i.days, rated, p, i.compare, followersOn(i.days, p, i.compare.end)) }));
  const now = combineNumbers(per.map((p) => p.now));
  const before = combineNumbers(per.map((p) => p.before));
  const inMain = rated.filter((p) => p.postedAt && etDay(p.postedAt) >= i.main.start && etDay(p.postedAt) <= i.main.end);
  const best = [...inMain]
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.interactions ?? -1) - (a.interactions ?? -1) || (b.reach ?? -1) - (a.reach ?? -1))
    .slice(0, 6)
    .map<SocialPostLite>((p) => ({ id: p.id, platform: p.platform, format: p.format, caption: clip(p.caption, 160), permalink: p.permalink, thumbnail: p.thumbnail, postedAt: p.postedAt, reach: p.reach, views: p.views, interactions: p.interactions, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, rate: p.rate, rateBasis: p.rateBasis }));
  const formats = new Map<PostFormat, number>();
  for (const p of inMain) formats.set(p.format, (formats.get(p.format) ?? 0) + 1);
  const trend = weekBuckets(i.main.end, 8).map((w) => {
    const ws = windowOf(i.days, w.start, w.end);
    return { ...w, value: ws.reach ?? 0, extra: ws.interactions ?? 0 };
  });
  const through = i.days.filter((r) => r.reach != null || r.followers != null).map((r) => r.date).sort().at(-1) ?? null;
  const gaps = i.days.length ? missingDays([...new Map(i.days.map((r) => [r.date, r])).values()], i.main.start, i.main.end) : [];
  return {
    platform: "social",
    version: 1,
    kind: i.kind,
    main: i.main,
    compare: i.compare,
    now,
    before,
    platforms: per,
    posts: best,
    postsTotal: inMain.length,
    formats: [...formats.entries()].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count),
    trend,
    target: i.target ?? null,
    gaps,
    through,
    insightsRead: now.reach != null,
  };
}

// ─── Targets ───────────────────────────────────────────────────────────────

/**
 * The team's target for a line against what the period did. The metric names the team uses are matched loosely (the
 * target table's names aren't fixed here): revenue, engagement rate, followers, reach. A revenue or reach target is a
 * month's: a weekly report holds it against its share of a month. An unknown metric is left out, never guessed at.
 */
export function targetLine(line: ChannelLine, row: TargetRow | null, m: { kind: ChannelKind; main: Range; revenue?: number | null; rate?: number | null; followers?: number | null; reach?: number | null }): TargetLine | null {
  if (!row || !(row.target > 0)) return null;
  const name = row.metric.toLowerCase().replace(/[^a-z]/g, "");
  const share = m.kind === "monthly" ? 1 : Math.min(1, daysIn(m.main) / 30.4);
  const make = (label: string, unit: TargetLine["unit"], target: number, actual: number | null, b: string): TargetLine => ({ metric: row.metric, label, unit, target: round(target, 4), actual, progress: actual != null && target > 0 ? actual / target : null, basis: b });
  if (line === "email" && /revenue|sales/.test(name)) {
    const what = row.source === "floor" ? "monthly target (last month +10%)" : "monthly target";
    return make("Attributed revenue", "money", row.target * share, m.revenue ?? null, m.kind === "monthly" ? what : `weekly share of the ${what}`);
  }
  if (line === "social" && /engagement|rate/.test(name)) {
    // Stored as a percent (3) or a fraction (0.03): both read as the same rate
    const frac = row.target > 1 ? row.target / 100 : row.target;
    return make("Engagement rate", "percent", frac, m.rate ?? null, "target");
  }
  if (line === "social" && /follower/.test(name)) return make("Followers", "count", row.target, m.followers ?? null, "follower goal");
  if (line === "social" && /reach/.test(name)) return make("Reach", "count", row.target * share, m.reach ?? null, m.kind === "monthly" ? "monthly target" : "weekly share of the monthly target");
  return null;
}

// ─── Reading the numbers ───────────────────────────────────────────────────

export const money = (n: number | null | undefined, currency: string | null = "USD") => {
  if (n == null || !Number.isFinite(n)) return "–";
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  const big = Math.abs(n) >= 1000;
  return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 })}`;
};
export const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US"));
/** A fraction as a percent ("3.4%") */
export const pct = (x: number | null | undefined, digits = 1) => (x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(digits)}%`);
export const signed = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
/** Money short enough for a chart label ("$1.9k", "AUD 28.3k", "$640") */
export const shortMoney = (n: number, currency: string | null = "USD") => {
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  const a = Math.abs(n);
  const body = a >= 1e6 ? `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m` : a >= 1000 ? `${(n / 1000).toFixed(a >= 1e4 ? 0 : 1)}k` : `${Math.round(n)}`;
  return `${sym}${body.replace(/\.0(?=[km])/, "")}`;
};
/**
 * The font size that keeps a value on one line in a box `width` points wide: Helvetica-Bold digits and capitals run
 * about 0.6 of the size, so a long value ("AUD 1,234,567") shrinks instead of spilling into its neighbour.
 */
export const fitFont = (text: string, width: number, max: number, min = 8) => Math.max(min, Math.min(max, Math.floor((width / (Math.max(1, text.length) * 0.6)) * 10) / 10));

/** The change from before to now as the report shows it: a percent with one decimal, which way, and whether it's good news */
export function moveOf(now: number | null | undefined, before: number | null | undefined, better: "up" | "down" | "none" = "up"): Move {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  const raw = ((now - before) / Math.abs(before)) * 100;
  const text = Math.abs(raw).toFixed(1);
  if (text === "0.0") return { pct: "0.0%", up: false, tone: "flat" };
  const up = raw > 0;
  return { pct: `${text}%`, up, tone: better === "none" ? "flat" : up === (better === "up") ? "good" : "bad" };
}

export type ChannelTile = { label: string; value: string; sub: string | null; before: string; move: Move };

/** Progress against a target as one short line ("78% of the $12,000 monthly target") */
export function targetSub(t: TargetLine | null, currency: string | null = "USD"): string | null {
  if (!t || t.progress == null) return null;
  const goal = t.unit === "money" ? money(t.target, currency) : t.unit === "percent" ? pct(t.target) : int(t.target);
  return `${Math.round(t.progress * 100)}% of the ${goal} ${t.basis}`;
}

export function emailTiles(m: EmailMetrics): ChannelTile[] {
  const c = m.currency;
  const { now, before } = m;
  return [
    { label: "Attributed revenue", value: money(now.revenue, c), sub: targetSub(m.target, c) ?? (now.estimated ? "Added up from campaigns and flows" : null), before: money(before.revenue, c), move: moveOf(now.revenue, before.revenue) },
    { label: "Campaign revenue", value: money(now.campaignRevenue, c), sub: `${int(now.campaignsSent)} ${now.campaignsSent === 1 ? "campaign" : "campaigns"} sent`, before: money(before.campaignRevenue, c), move: moveOf(now.campaignRevenue, before.campaignRevenue) },
    { label: "Flow revenue", value: money(now.flowRevenue, c), sub: now.revenue > 0 ? `${Math.round((now.flowRevenue / now.revenue) * 100)}% of email revenue` : null, before: money(before.flowRevenue, c), move: moveOf(now.flowRevenue, before.flowRevenue) },
    { label: "List growth", value: m.list.net != null ? signed(m.list.net) : "–", sub: m.list.profiles != null ? `${int(m.list.profiles)} profiles in the main lists` : null, before: "–", move: null },
  ];
}

/** The line under the tiles: the rates and volume that explain them */
export function emailSupport(m: EmailMetrics): { label: string; value: string }[] {
  const { now, before } = m;
  const chg = (a: number | null, b: number | null) => {
    const mv = moveOf(a, b, "up");
    return mv ? ` (${mv.up ? "+" : "-"}${mv.pct})` : "";
  };
  return [
    ...(m.score ? [{ label: "Email health score", value: `${m.score.score} of 100` }] : []),
    { label: "Open rate", value: `${pct(now.openRate)}${chg(now.openRate, before.openRate)}` },
    { label: "Click rate", value: `${pct(now.clickRate, 2)}${chg(now.clickRate, before.clickRate)}` },
    { label: "Unsubscribes", value: pct(now.unsubscribeRate, 2) },
    { label: "Revenue per email sent", value: now.revenuePerRecipient != null ? money(now.revenuePerRecipient, m.currency) : "–" },
    { label: "Emails sent", value: int(now.sends) },
  ];
}

export function socialTiles(m: SocialMetrics): ChannelTile[] {
  const { now, before } = m;
  const t = m.target;
  const followerTarget = t && /follower/i.test(t.metric) ? targetSub(t) : null;
  const rateTarget = t && /engagement|rate/i.test(t.metric) ? targetSub(t) : null;
  const reachTarget = t && /reach/i.test(t.metric) ? targetSub(t) : null;
  return [
    { label: "Followers", value: int(now.followers), sub: followerTarget ?? (now.followerChange != null ? `${signed(now.followerChange)} in the period` : null), before: int(before.followers), move: moveOf(now.followers, before.followers) },
    { label: "Reach", value: int(now.reach), sub: reachTarget ?? "Accounts that saw a post or a story", before: int(before.reach), move: moveOf(now.reach, before.reach) },
    { label: "Views", value: int(now.views), sub: null, before: int(before.views), move: moveOf(now.views, before.views) },
    { label: "Engagement rate", value: m.insightsRead ? pct(now.rate) : "–", sub: rateTarget ?? "Interactions over reach", before: pct(before.rate), move: moveOf(now.rate, before.rate) },
  ];
}

export function socialSupport(m: SocialMetrics): { label: string; value: string }[] {
  const { now, before } = m;
  const posts = moveOf(now.posts, before.posts, "none");
  return [
    { label: "Posts published", value: `${int(now.posts)}${posts ? ` (${posts.up ? "+" : "-"}${posts.pct} vs the period before)` : ""}` },
    { label: "Interactions", value: int(now.interactions) },
    { label: "Profile visits", value: int(now.profileViews) },
    { label: "Accounts engaged", value: int(now.engaged) },
  ];
}

export const metricsTiles = (m: EmailMetrics | SocialMetrics) => (m.platform === "klaviyo" ? emailTiles(m) : socialTiles(m));
export const metricsSupport = (m: EmailMetrics | SocialMetrics) => (m.platform === "klaviyo" ? emailSupport(m) : socialSupport(m));

/** The lines the email carries (subject-line numbers, one per line), each against the period before */
export function keyLines(m: EmailMetrics | SocialMetrics): string[] {
  return metricsTiles(m)
    .filter((t) => t.value !== "–")
    .map((t) => `${t.label}: ${t.value}${t.move ? `, ${t.move.up ? "up" : "down"} ${t.move.pct} vs ${m.compare.label}` : ""}`);
}

// ─── Takeaways ─────────────────────────────────────────────────────────────

export type Takeaway = { title: string; text: string };

const rel = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null);
const plus = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(1)}%`;

/** Three cards worked out from the numbers, for when the writer hasn't written its own (and the PDF always has something to say) */
export function takeawaysFor(m: EmailMetrics | SocialMetrics, written?: Takeaway[] | null): Takeaway[] {
  const own = (written ?? []).filter((t) => t.title?.trim() && t.text?.trim()).slice(0, 3);
  if (own.length === 3) return own;
  const out: Takeaway[] = [];
  if (m.platform === "klaviyo") {
    const c = m.currency;
    const r = rel(m.now.revenue, m.before.revenue);
    if (m.now.revenue > 0 || m.before.revenue > 0) out.push({ title: r == null ? "Email revenue" : r >= 0 ? "Email revenue is up" : "Email revenue is down", text: `Email brought in ${money(m.now.revenue, c)} against ${money(m.before.revenue, c)} in ${m.compare.label}${r != null ? ` (${plus(r)})` : ""}.` });
    const top = m.campaigns[0];
    if (top && top.revenue > 0) out.push({ title: "Best campaign", text: `"${top.name}" earned ${money(top.revenue, c)} from ${int(top.recipients)} recipients${top.openRate != null ? `, with a ${pct(top.openRate)} open rate` : ""}.` });
    const f = m.flows[0];
    if (f && f.revenue > 0) out.push({ title: "Flows keep earning", text: `${f.name} led the automations with ${money(f.revenue, c)} over its last 30 days.` });
    else if (m.list.net != null) out.push({ title: m.list.net >= 0 ? "The list grew" : "The list shrank", text: `${signed(m.list.net)} net subscribers in ${m.main.label}.` });
  } else {
    const fr = rel(m.now.followers, m.before.followers);
    if (m.now.followerChange != null) out.push({ title: m.now.followerChange >= 0 ? "Followers are growing" : "Followers dipped", text: `${signed(m.now.followerChange)} followers in ${m.main.label}${m.now.followers != null ? `, to ${int(m.now.followers)}` : ""}${fr != null ? ` (${plus(fr)})` : ""}.` });
    const reach = rel(m.now.reach, m.before.reach);
    if (m.now.reach != null) out.push({ title: reach != null && reach < 0 ? "Reach slipped" : "Reach", text: `Posts and stories reached ${int(m.now.reach)} accounts${reach != null ? ` (${plus(reach)} vs ${m.compare.label})` : ""}.` });
    const top = m.posts[0];
    if (top) out.push({ title: "Top post", text: `${top.platform === "instagram" ? "Instagram" : "Facebook"} ${top.format}${top.caption ? ` "${top.caption.slice(0, 60)}"` : ""} drew ${int(top.interactions)} interactions${top.reach != null ? ` from ${int(top.reach)} reached` : ""}.` });
  }
  return [...own, ...out].slice(0, 3);
}

// ─── The QA's plain checks ─────────────────────────────────────────────────

export type DataFlag = { severity: "fix" | "check" | "alert"; issue: string; where: string; suggestion: string };

/** Plain checks on the numbers, before any AI: what the QA must never miss */
export function dataFlags(m: EmailMetrics | SocialMetrics): DataFlag[] {
  const out: DataFlag[] = [];
  const add = (severity: DataFlag["severity"], issue: string, suggestion: string) => out.push({ severity, issue, where: "Data", suggestion });
  if (m.gaps.length) add("alert", `No daily numbers for ${m.gaps.length} day${m.gaps.length === 1 ? "" : "s"} in the period (${m.gaps.slice(0, 4).join(", ")}${m.gaps.length > 4 ? "…" : ""}).`, "Check the connection is reading (Sync now on the client's page) before sending.");
  if (m.platform === "klaviyo") {
    const { now, before } = m;
    if (now.campaignsSent === 0 && now.flowRevenue === 0 && now.revenue === 0) add("alert", "Nothing was sent and no revenue was attributed in the period.", "If sending was paused on purpose, the report should say so.");
    else if (now.campaignsSent === 0) add("alert", "No campaigns were sent in the period.", "Say why (a planned pause, a list clean-up) and what sends next.");
    if (before.revenue > 0 && now.revenue < before.revenue * 0.6) add("alert", `Attributed revenue fell from ${money(before.revenue, m.currency)} to ${money(now.revenue, m.currency)}.`, "Make sure the report explains why and what is being done about it.");
    if (now.estimated) add("check", "Revenue was added up from campaigns and flows because the daily rows were short.", "Confirm the figure in Klaviyo before sending.");
    for (const f of m.flags.filter((x) => x.tone === "bad")) add("alert", f.text, "Say what is being done about deliverability.");
    const missing = m.keyFlows.filter((k) => k.state === "missing").map((k) => k.label);
    if (missing.length) add("check", `Key flows missing: ${missing.join(", ")}.`, "Mention them in what's next only if the team has planned them.");
    if (m.target && m.target.progress != null && m.target.progress < 0.7) add("check", `Revenue is at ${Math.round(m.target.progress * 100)}% of its target.`, "Say where it stands against the target and the plan to close it.");
    if (m.locations === null && now.campaignsSent > 0) add("alert", "This client is broken down by location, but no orders with a location were read for the campaigns in the period.", "Check the location property on the client's Klaviyo card and Sync health before sending; the report's location section is left out.");
    for (const t of locationChecks(m.locations ?? null, m.locationAttributed ?? {}, m.currency)) add("check", t, "Check the location property picked on the Klaviyo card, or say in the report that some orders carry no location.");
  } else {
    const { now, before } = m;
    if (now.posts === 0) add("alert", "Nothing was published in the period.", "If posting paused, the report should say so and when it resumes.");
    if (now.followerChange != null && now.followerChange < 0) add("alert", `The account lost ${Math.abs(now.followerChange)} followers in the period.`, "Say what the team makes of it and what changes.");
    if (before.reach && now.reach != null && now.reach < before.reach * 0.6) add("alert", `Reach fell from ${int(before.reach)} to ${int(now.reach)}.`, "Make sure the report explains why and what is being done about it.");
    if (!m.insightsRead) add("check", "Meta gave no reach or interaction numbers for this account, so the engagement rate is left out.", "Check the account's permissions on the client's Social tab.");
    if (m.target && m.target.progress != null && m.target.progress < 0.7) add("check", `${m.target.label} is at ${Math.round(m.target.progress * 100)}% of its target.`, "Say where it stands and the plan to close it.");
  }
  return out;
}

// ─── Refreshing the numbers ────────────────────────────────────────────────

type Kind = "count" | "money" | "ratio";
type Line = { key: string; label: string; kind: Kind; value: number | null };

/** The numbers a written report quotes (Klaviyo and Meta revise recent days, so these are what has to follow a refresh) */
export function quotedLines(m: EmailMetrics | SocialMetrics): Line[] {
  if (m.platform === "klaviyo") {
    return [
      { key: "revenue", label: "Attributed revenue", kind: "money", value: finite(m.now.revenue) },
      { key: "campaignRevenue", label: "Campaign revenue", kind: "money", value: finite(m.now.campaignRevenue) },
      { key: "flowRevenue", label: "Flow revenue", kind: "money", value: finite(m.now.flowRevenue) },
      { key: "sent", label: "Campaigns sent", kind: "count", value: finite(m.now.campaignsSent) },
      { key: "sends", label: "Emails sent", kind: "count", value: finite(m.now.sends) },
      { key: "open", label: "Open rate", kind: "ratio", value: finite(m.now.openRate) },
      { key: "click", label: "Click rate", kind: "ratio", value: finite(m.now.clickRate) },
      { key: "net", label: "Net new subscribers", kind: "count", value: finite(m.list.net) },
      { key: "prevRevenue", label: "Revenue in the period before", kind: "money", value: finite(m.before.revenue) },
      ...(m.locations ? [{ key: "locations", label: "Revenue by location (every metric summed)", kind: "money" as const, value: finite(m.locations.combined.revenue) }] : []),
    ];
  }
  return [
    { key: "followers", label: "Followers", kind: "count", value: finite(m.now.followers) },
    { key: "change", label: "Follower change", kind: "count", value: finite(m.now.followerChange) },
    { key: "reach", label: "Reach", kind: "count", value: finite(m.now.reach) },
    { key: "views", label: "Views", kind: "count", value: finite(m.now.views) },
    { key: "interactions", label: "Interactions", kind: "count", value: finite(m.now.interactions) },
    { key: "rate", label: "Engagement rate", kind: "ratio", value: finite(m.now.rate) },
    { key: "posts", label: "Posts published", kind: "count", value: finite(m.now.posts) },
    { key: "prevReach", label: "Reach in the period before", kind: "count", value: finite(m.before.reach) },
  ];
}

/** A real change, not rounding: a whole count and half a percent of it, a dollar and half a percent of money, a hundredth of a point of a rate */
export function moved(kind: Kind, a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  const d = Math.abs(a - b);
  const big = Math.max(Math.abs(a), Math.abs(b));
  if (kind === "count") return d >= 1 && d >= big * 0.005;
  if (kind === "money") return d >= 1 && d >= big * 0.005;
  return d >= 0.0005 && d >= big * 0.01;
}

const show = (l: Line, v: number | null, currency: string | null) => (v == null ? "n/a" : l.kind === "money" ? money(v, currency) : l.kind === "ratio" ? pct(v, 2) : int(v));

/** The numbers the text quotes that moved between two versions of a report's numbers (empty: nothing for the text to follow) */
export function changesBetween(was: EmailMetrics | SocialMetrics | null | undefined, now: EmailMetrics | SocialMetrics): { label: string; was: string; now: string }[] {
  if (!was || was.platform !== now.platform) return [];
  const before = quotedLines(was);
  const currency = now.platform === "klaviyo" ? now.currency : null;
  const out: { label: string; was: string; now: string }[] = [];
  for (const l of quotedLines(now)) {
    const o = before.find((x) => x.key === l.key);
    if (o && moved(l.kind, o.value, l.value)) out.push({ label: l.label, was: show(l, o.value, currency), now: show(l, l.value, currency) });
  }
  return out;
}

/** Whether the report's numbers are drawn for its own dates (a report drawn for other dates is redrawn before it goes) */
export function periodMismatch(period: Range, m: { main: Range; compare: Range } | null | undefined): string[] {
  if (!m) return ["numbers"];
  const out: string[] = [];
  if (m.main.start !== period.start || m.main.end !== period.end) out.push("numbers");
  const prev = previousPeriod(period);
  // A monthly compares with the month before, not the same number of days
  const sameLength = daysIn(m.compare) === daysIn(prev);
  if (sameLength && (m.compare.start !== prev.start || m.compare.end !== prev.end)) out.push("comparison");
  return out;
}

// ─── Pictures ──────────────────────────────────────────────────────────────

/**
 * The picture that stands for a saved email: the first real image in its HTML (not a tracking pixel, a spacer or an icon),
 * as an address. The preview is made safe on the way in, so images are plain links. Null when there isn't one.
 */
export function heroImage(html: string | null | undefined): string | null {
  if (!html) return null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || !/^https?:\/\//i.test(src)) continue;
    if (/\.(gif|svg)(\?|$)/i.test(src) || /track|pixel|open\.|beacon|spacer|logo|icon|badge|social|facebook|instagram|twitter|linkedin/i.test(src)) continue;
    const w = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const h = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    if ((w && w < 200) || (h && h < 80)) continue;
    return src;
  }
  return null;
}

/** The name a platform goes by in the report */
export const socialName = (p: SocialPlatformKey) => (p === "instagram" ? "Instagram" : "Facebook");

/** The rate a post is shown at, with what it was worked out over */
export const postRateText = (p: Pick<SocialPostLite, "rate" | "rateBasis">) => (p.rate == null ? "–" : `${pct(p.rate)} of ${p.rateBasis === "followers" ? "followers" : "reach"}`);

export { postRate };

// ─── The notice when numbers were refreshed ────────────────────────────────

const sourceWord = (p: ChannelPlatform) => (p === "klaviyo" ? "Klaviyo" : "Meta");

/** The calm line the studio shows: what moved, and what became of the text */
export function channelNoteText(platform: ChannelPlatform, note: RefreshNote): string {
  const shown = note.changes.slice(0, 4).map((c) => `${c.label} ${c.was} → ${c.now}`);
  const more = note.changes.length > 4 ? ` and ${note.changes.length - 4} more` : "";
  const head = `Numbers updated from ${sourceWord(platform)} since this was written: ${shown.join(", ")}${more}.`;
  if (note.text === "updated") return `${head} The summary was updated to match.`;
  if (note.text === "needs_look") return `${head} The text couldn't be updated automatically and may still show the old figures. Update it before sending.`;
  if (note.text === "kept") return `${head} The text was left as it is.`;
  return `${head} The text is being updated to match.`;
}

/** Why a send is held, in the owner's words */
export function channelBlockedMessage(platform: ChannelPlatform, note: RefreshNote): string {
  const shown = note.changes.slice(0, 3).map((c) => `${c.label} ${c.was} → ${c.now}`).join(", ");
  return `The ${sourceWord(platform)} numbers changed since the text was written (${shown}) and the text hasn't been updated to match. Open the report and press "Update the text", then send.`;
}

/** The ask that has the text follow the numbers: only the figures, and what depends on them, nothing else */
export function numbersAsk(note: RefreshNote): string {
  const lines = note.changes.map((c) => `- ${c.label}: was ${c.was}, now ${c.now}`).join("\n");
  return `The report's numbers were refreshed from the source after this was written. What moved:\n${lines}\nThe <numbers> given now are the right ones. Bring the message and the sections up to date with them: change only the figures, and the statements that depend on them (percent changes, "up" or "down", a highlight, a takeaway or a bullet that quotes them). Keep everything else exactly as it is, the owner's own wording and edits included. Don't say the numbers were refreshed or revised. Leave lesson empty.`;
}
