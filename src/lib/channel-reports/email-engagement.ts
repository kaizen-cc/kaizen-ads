import { campaignDay } from "./campaign-day";
import { daysIn, monthSoFar, shiftDay } from "@/lib/reports/period";
import type { CampaignLite, DailyRow } from "@/lib/klaviyo/insights";

// The email report for a client whose revenue can't be read (Brevo with no store connected, Customer.io with no revenue
// event, Klaviyo with no conversion metric): built on what the account does show, the way an owner judges it with no
// sales number. Who it reached, who engaged, the clicks it sent to the website and booking pages and which links they
// were, the list, and each number against the period before and against the account's own usual (its trailing eight
// weeks), so "is email over or under performing" has an answer without revenue. Never a Kaizen grade or bar.
// Pure, so the PDF, the live page, the writer's numbers and the tests all read the same view.

export type EmailTemplate = "revenue" | "engagement";

/**
 * Which email report a client gets: the engagement one when revenue isn't readable. That is a source that says it reads
 * none, a Klaviyo account with no conversion metric, or a non-Klaviyo source whose trailing weeks of sends carried no
 * revenue and no orders at all (its store isn't connected, whatever the flag says). Everything else keeps the revenue report.
 */
export function emailTemplateFor(p: {
  source?: string | null;
  revenueMeasured: boolean;
  hasConversionMetric?: boolean | null;
  revenue: number;
  orders: number;
  sends: number;
}): EmailTemplate {
  if (!p.revenueMeasured) return "engagement";
  if (p.hasConversionMetric === false) return "engagement";
  const klaviyo = !p.source || p.source === "Klaviyo";
  if (!klaviyo && p.sends > 0 && p.revenue <= 0 && p.orders <= 0)
    return "engagement";
  return "revenue";
}

// ─── Against the usual ─────────────────────────────────────────────────────

export type UsualWord = "above" | "in line" | "below";
/** Weeks of history the usual is the average of */
export const USUAL_WEEKS = 8;
/** At least three weeks of history before a usual is quoted */
export const USUAL_MIN_DAYS = 21;
/** Within 5% of the usual reads as in line */
export const USUAL_BAND = 0.05;

/** A number with the period before, the account's usual for a period this long, and how far from it */
export type Measure = {
  now: number | null;
  before: number | null;
  usual: number | null;
  vsUsual: number | null;
  word: UsualWord | null;
};

/** How far `now` is from the usual (a fraction) and the word for it; null without a usual to compare with */
export function usualWord(
  now: number | null | undefined,
  usual: number | null | undefined,
  band = USUAL_BAND,
): { diff: number; word: UsualWord } | null {
  if (
    now == null ||
    usual == null ||
    !Number.isFinite(now) ||
    !Number.isFinite(usual) ||
    usual <= 0
  )
    return null;
  const diff = (now - usual) / usual;
  return {
    diff,
    word: diff > band ? "above" : diff < -band ? "below" : "in line",
  };
}

/** A count's usual for a period of `periodDays`: the history's total per day times the period's days (null on too little history) */
export function usualCount(
  total: number,
  historyDays: number,
  periodDays: number,
): number | null {
  if (historyDays < USUAL_MIN_DAYS || periodDays <= 0) return null;
  return (total / historyDays) * periodDays;
}

/** A rate's usual: the history's pooled rate (null on too little history or nothing to divide by) */
export function usualRate(
  num: number,
  den: number,
  historyDays: number,
): number | null {
  if (historyDays < USUAL_MIN_DAYS || den <= 0) return null;
  return num / den;
}

const measure = (
  now: number | null,
  before: number | null,
  usual: number | null,
): Measure => {
  const u = usualWord(now, usual);
  return {
    now,
    before,
    usual,
    vsUsual: u?.diff ?? null,
    word: u?.word ?? null,
  };
};

/** "12% above your usual", "in line with your usual", "8% below your usual" (null without a usual) */
export function usualText(x: Pick<Measure, "vsUsual" | "word">): string | null {
  if (x.word == null || x.vsUsual == null) return null;
  if (x.word === "in line") return "in line with your usual";
  // None at all against a usual above none (no spam complaints this time): plainly below, never "100% below"
  if (x.word === "below" && x.vsUsual <= -0.995) return "below your usual";
  return `${Math.round(Math.abs(x.vsUsual) * 100)}% ${x.word} your usual`;
}

// ─── Links ─────────────────────────────────────────────────────────────────

export type LinkKind =
  | "booking"
  | "tickets"
  | "events"
  | "menu"
  | "social"
  | "directions"
  | "contact"
  | "jobs"
  | "press"
  | "website";
export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  booking: "Guest list & bookings",
  tickets: "Tickets",
  events: "Events",
  menu: "Menu & specials",
  social: "Social profiles",
  directions: "Directions",
  contact: "Calls & messages",
  jobs: "Jobs & casting",
  press: "Press & reviews",
  website: "Website",
};

const BOOKING_HOSTS =
  /(^|\.)(opentable|resy|sevenrooms|tablelist|discotech|exploretock|tock|speakeasygo|urvenue|vip|clubbable|guestlist|bookatable|yelp\.com\/reservations)\b/i;
const TICKET_HOSTS =
  /(^|\.)(eventbrite|ticketmaster|dice\.fm|posh\.vip|shotgun|seetickets|axs|tixr|ra\.co|universe)\b/i;
const SOCIAL: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/i, "Instagram"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/i, "Facebook"],
  [/(^|\.)tiktok\.com$/i, "TikTok"],
  [/(^|\.)(x|twitter)\.com$/i, "X"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, "YouTube"],
  [/(^|\.)linkedin\.com$/i, "LinkedIn"],
  [/(^|\.)snapchat\.com$/i, "Snapchat"],
];
const PRESS_HOSTS =
  /news|times|magazine|post|herald|eater|timeout|thrillist|infatuation|yelp|tripadvisor|google\.com\/search|reviews?/i;
/** Links that aren't a destination: unsubscribe and preference pages, the web version, placeholders and the provider's own pages */
const NOT_A_DESTINATION =
  /unsubscrib|optout|opt-out|manage[-_ ]?(your[-_ ]?)?preferences|update[-_ ]?profile|view[-_ ]?(it[-_ ]?)?(in|online|browser)|mirror|webversion|\{\{|\[\[|^#$|example\.(com|org)|sendinblue\.com|brevo\.com|klaviyo\.com|customer\.io|list-manage\.com\/(unsubscribe|profile)/i;

/** A page's path as words: "ufc-334-watch-party-in-miami" -> "UFC 334 watch party in Miami" */
function pathWords(slug: string): string {
  const words = decodeURIComponent(slug)
    .replace(/\.(html?|php|aspx?)$/i, "")
    .split(/[-_+\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      if (/^(ufc|nba|nfl|mlb|nhl|vip|dj|bogo|faq|usa)$/i.test(w))
        return w.toUpperCase();
      if (
        /^(miami|heat|halloween|christmas|thanksgiving|valentines?|tuesdays?|mondays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)$/i.test(
          w,
        )
      )
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase();
    });
  const s = words.join(" ");
  return s.length > 44 ? `${s.slice(0, 42).trimEnd()}…` : s;
}

type Parsed = {
  href: string;
  host: string;
  path: string;
  hash: string;
  scheme: string;
};
function parse(raw: string): Parsed | null {
  const href = String(raw ?? "").trim();
  if (!href) return null;
  const scheme = /^([a-z]+):/i.exec(href)?.[1]?.toLowerCase() ?? "";
  if (scheme === "tel" || scheme === "mailto" || scheme === "sms")
    return {
      href,
      host: "",
      path: href.slice(scheme.length + 1),
      hash: "",
      scheme,
    };
  try {
    const u = new URL(/^https?:\/\//i.test(href) ? href : `https://${href}`);
    return {
      href,
      host: u.hostname.toLowerCase().replace(/^www\./, ""),
      path: u.pathname.replace(/\/+$/, "") || "/",
      hash: u.hash,
      scheme: u.protocol.replace(":", ""),
    };
  } catch {
    return null;
  }
}

/** A link's address as one key: host and path, no query, no tracking, no trailing slash (a site's pop-up keeps its marker) */
export function linkKey(raw: string): string | null {
  const p = parse(raw);
  if (!p) return null;
  if (!p.host) return `${p.scheme}:${p.path}`;
  const popup = /elementor-action|popup/i.test(p.hash) ? "#popup" : "";
  return `${p.host}${p.path === "/" ? "" : p.path}${popup}`;
}

/**
 * What a link is to the owner: the guest list or a booking, tickets, an event page, the menu, a social profile,
 * directions, a call, jobs, press, or a page on the website, with a short plain label. Null for links that aren't a
 * destination (unsubscribe, preferences, the web version, placeholders). `home` is the client's own site, when known.
 */
export function linkLabel(
  raw: string,
  home?: string | null,
): { kind: LinkKind; label: string } | null {
  if (NOT_A_DESTINATION.test(raw)) return null;
  const p = parse(raw);
  if (!p) return null;
  if (p.scheme === "tel") return { kind: "contact", label: "Call" };
  if (p.scheme === "sms") return { kind: "contact", label: "Text" };
  if (p.scheme === "mailto") return { kind: "contact", label: "Email" };
  const social = SOCIAL.find(([re]) => re.test(p.host));
  if (social) return { kind: "social", label: social[1] };
  const path = p.path.toLowerCase();
  const full = `${p.host}${path}`;
  if (
    (/(^|\.)google\.[a-z.]+$/.test(p.host) && path.startsWith("/maps")) ||
    /maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.apple\.com|waze\.com/.test(
      full,
    )
  )
    return { kind: "directions", label: "Directions" };
  const last = p.path.split("/").filter(Boolean).at(-1) ?? "";
  if (BOOKING_HOSTS.test(p.host)) {
    const brand = p.host.split(".").at(-2) ?? p.host;
    return {
      kind: "booking",
      label: /event/.test(path)
        ? `Guest list & tickets (${brand === "speakeasygo" ? "SpeakEasyGo" : brand.charAt(0).toUpperCase() + brand.slice(1)})`
        : `Bookings (${brand.charAt(0).toUpperCase() + brand.slice(1)})`,
    };
  }
  if (/guest-?list|rsvp/.test(path))
    return { kind: "booking", label: "Guest list" };
  if (/reserv|book(ing)?s?\b|bottle-?service|\bvip\b|\/tables?\b/.test(path))
    return {
      kind: "booking",
      label: /bottle/.test(path) ? "Bottle service" : "Reservations",
    };
  if (TICKET_HOSTS.test(p.host) || /ticket/.test(path))
    return { kind: "tickets", label: "Tickets" };
  if (/career|jobs?\b|hiring|casting|audition|apply|employment/.test(path))
    return { kind: "jobs", label: "Jobs & casting" };
  if (
    /menu|food|drinks?\b|specials?\b|happy-hour/.test(path) &&
    !/event|calendar/.test(path)
  )
    return {
      kind: "menu",
      label: last && !/^menus?$/.test(last) ? pathWords(last) : "Menu",
    };
  if (/event|calendar|party|tonight|show|lineup|watch/.test(path))
    return {
      kind: "events",
      label:
        last && !/^(events?|calendar|events-calendar)$/.test(last)
          ? pathWords(last)
          : "Events calendar",
    };
  const own = !home || p.host === home || p.host.endsWith(`.${home}`);
  if (own) {
    if (/elementor-action|popup/i.test(p.hash))
      return { kind: "website", label: "Website pop-up" };
    if (path === "/") return { kind: "website", label: "Website home page" };
    if (/contact/.test(path)) return { kind: "contact", label: "Contact page" };
    return { kind: "website", label: pathWords(last) || "Website" };
  }
  if (PRESS_HOSTS.test(full))
    return {
      kind: "press",
      label: p.host
        .replace(/\.(com|net|org|co)$/, "")
        .replace(/^./, (c) => c.toUpperCase()),
    };
  return { kind: "website", label: p.host };
}

/** The client's own site: the host most of the campaigns' links point to (not a social network or a booking platform) */
export function homeHost(urls: string[]): string | null {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const p = parse(u);
    if (
      !p?.host ||
      NOT_A_DESTINATION.test(u) ||
      SOCIAL.some(([re]) => re.test(p.host)) ||
      BOOKING_HOSTS.test(p.host) ||
      TICKET_HOSTS.test(p.host) ||
      /google\.|goo\.gl/.test(p.host)
    )
      continue;
    counts.set(p.host, (counts.get(p.host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export type LinkRow = {
  key: string;
  url: string;
  label: string;
  kind: LinkKind;
  clicks: number;
  share: number;
  campaigns: number;
};
export type LinkKindRow = {
  kind: LinkKind;
  label: string;
  clicks: number;
  share: number;
};
export type LinkView = {
  rows: LinkRow[];
  byKind: LinkKindRow[];
  total: number;
  campaigns: number;
};

/** Clicks per link across the campaigns, by destination: the top links and the share each kind of destination drew */
export function linkView(
  campaigns: { id: string; links: Record<string, number> | null | undefined }[],
  top = 6,
): LinkView | null {
  const withLinks = campaigns.filter(
    (c) => c.links && Object.keys(c.links).length,
  );
  if (!withLinks.length) return null;
  const home = homeHost(withLinks.flatMap((c) => Object.keys(c.links ?? {})));
  const rows = new Map<string, LinkRow & { ids: Set<string> }>();
  for (const c of withLinks)
    for (const [url, n] of Object.entries(c.links ?? {})) {
      const clicks = Number(n);
      if (!Number.isFinite(clicks) || clicks <= 0) continue;
      const l = linkLabel(url, home);
      const key = linkKey(url);
      if (!l || !key) continue;
      const r = rows.get(key) ?? {
        key,
        url,
        label: l.label,
        kind: l.kind,
        clicks: 0,
        share: 0,
        campaigns: 0,
        ids: new Set<string>(),
      };
      r.clicks += clicks;
      r.ids.add(c.id);
      rows.set(key, r);
    }
  const all = [...rows.values()];
  const total = all.reduce((s, r) => s + r.clicks, 0);
  if (!total) return null;
  const kinds = new Map<LinkKind, number>();
  for (const r of all) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + r.clicks);
  return {
    total,
    campaigns: withLinks.length,
    rows: all
      .sort((a, b) => b.clicks - a.clicks || a.label.localeCompare(b.label))
      .slice(0, top)
      .map(({ ids, ...r }) => ({
        ...r,
        campaigns: ids.size,
        share: r.clicks / total,
      })),
    byKind: [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, clicks]) => ({
        kind,
        label: LINK_KIND_LABEL[kind],
        clicks,
        share: clicks / total,
      })),
  };
}

// ─── The view ──────────────────────────────────────────────────────────────

/** What the sync keeps beside a campaign's numbers when the source gives it: total clicks (not only unique) and clicks per link */
export type CampaignExtra = {
  clicksTotal?: number | null;
  links?: Record<string, number> | null;
};

export type EngagementCampaign = {
  id: string;
  name: string;
  subject: string | null;
  date: string;
  delivered: number;
  opens: number;
  clickers: number;
  clicks: number;
  openRate: number | null;
  clickRate: number | null;
  ctor: number | null;
  unsubscribes: number;
  topLink: string | null;
  small: boolean;
};
export type EngagementWeek = {
  label: string;
  start: string;
  end: string;
  sends: number;
  delivered: number;
  opens: number;
  clicks: number;
  clickers: number;
  openRate: number | null;
  clickRate: number | null;
  /** Click to open that week */ ctor: number | null;
  /** The week falls in the report's period */ inPeriod: boolean;
};
export type EngagementList = {
  name: string | null;
  size: number | null;
  sizeAt: string | null;
  sizeBefore: number | null;
  net: number | null;
  netBefore: number | null;
  joined: number | null;
  joinedBefore: number | null;
  unsubscribes: number;
  unsubscribesBefore: number;
  history: { date: string; size: number }[];
};
export type EngagementSms = {
  campaigns: number;
  sent: number;
  delivered: number;
  clicks: number;
  optOuts: number;
  before: {
    campaigns: number;
    sent: number;
    delivered: number;
    clicks: number;
    optOuts: number;
  };
};
export type EngagementMtd = {
  window: { start: string; end: string; label: string };
  compare: { start: string; end: string; label: string };
  sends: [number, number];
  reached: [number, number];
  clicks: [number, number];
  net: [number | null, number | null];
};

export type Engagement = {
  version: 1;
  /** The trailing weeks the usual is worked from (null with under three weeks of history) */
  history: { start: string; end: string; days: number } | null;
  /** Days in the period (the usual is scaled to it) */
  periodDays: number;
  /** Emails handed to the provider (delivered plus bounced), now and before */
  recipients: { now: number; before: number };
  /** Email campaigns sent, now and before */
  sends: { now: number; before: number; usual: number | null };
  reached: Measure;
  opens: Measure;
  clickers: Measure;
  /** Clicks to the site: total clicks when the source counts them, else the people who clicked */
  clicks: Measure & { basis: "total" | "unique" };
  openRate: Measure;
  clickRate: Measure;
  /** Click to open: of the people who opened, how many clicked (the measure of the email itself) */
  ctor: Measure;
  unsubRate: Measure;
  bounceRate: Measure;
  spamRate: Measure;
  list: EngagementList;
  links: LinkView | null;
  trend: EngagementWeek[];
  campaigns: EngagementCampaign[];
  picks: {
    best: { id: string; why: string };
    lowest: { id: string; why: string };
  } | null;
  sms: EngagementSms | null;
  mtd: EngagementMtd | null;
  /** What this report can measure, and what it can't, in the client's words */
  measures: string;
};

const etDay = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      })
    : "";
const sum = <T>(xs: T[], f: (x: T) => number) =>
  xs.reduce((s, x) => s + f(x), 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

type Range = { start: string; end: string };
type Win = Range & { label: string };

export type EngagementInput = {
  kind: "weekly" | "monthly" | "custom";
  main: Win;
  compare: Win;
  /** Every campaign read: the period, the one before and the trailing weeks */
  campaigns: CampaignLite[];
  extras?: Record<string, CampaignExtra>;
  days: DailyRow[];
  /** The main list's size on the days it was read, and its name */
  sizes: { date: string; profiles: number }[];
  listName?: string | null;
  profiles: number | null;
  /** The first day the account's numbers cover (the usual never reaches before it) */
  since?: string | null;
  source?: string | null;
};

type Totals = {
  sends: number;
  delivered: number;
  recipients: number;
  opens: number;
  clickers: number;
  clicks: number;
  unsubs: number;
  bounced: number;
  spam: number;
  totalBasis: boolean;
};
function totals(
  cs: CampaignLite[],
  extras: Record<string, CampaignExtra>,
): Totals {
  const total =
    cs.every((c) => extras[c.id]?.clicksTotal != null) && cs.length > 0;
  return {
    sends: cs.length,
    delivered: sum(cs, (c) => c.delivered),
    recipients: sum(cs, (c) => c.recipients),
    opens: sum(cs, (c) => c.opensUnique),
    clickers: sum(cs, (c) => c.clicksUnique),
    clicks: sum(cs, (c) =>
      total ? Number(extras[c.id]?.clicksTotal ?? 0) : c.clicksUnique,
    ),
    unsubs: sum(cs, (c) => c.unsubscribes),
    bounced: sum(cs, (c) => c.bounced),
    spam: sum(cs, (c) => c.spamComplaints),
    totalBasis: total,
  };
}

const inRange = <T extends { sendTime: string | null; recipients: number }>(
  cs: T[],
  r: Range,
) =>
  cs.filter((c) => {
    const d = campaignDay(c);
    return d >= r.start && d <= r.end && c.recipients > 0;
  });

const sizeAt = (sizes: { date: string; profiles: number }[], day: string) =>
  [...sizes]
    .filter((s) => s.date <= day)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1) ?? null;

/** The engagement report's numbers for the period (pure) */
export function emailEngagement(i: EngagementInput): Engagement {
  const extras = i.extras ?? {};
  const email = i.campaigns.filter((c) => c.channel !== "sms");
  const sms = i.campaigns.filter((c) => c.channel === "sms");
  const now = totals(inRange(email, i.main), extras);
  const before = totals(inRange(email, i.compare), extras);
  const periodDays = daysIn(i.main);

  // The usual: the eight weeks before the period (never before the account's numbers begin)
  const hStart = [
    shiftDay(i.main.start, -USUAL_WEEKS * 7),
    i.since ?? "0000-00-00",
  ]
    .sort()
    .at(-1)!;
  const hEnd = shiftDay(i.main.start, -1);
  const hDays = hStart <= hEnd ? daysIn({ start: hStart, end: hEnd }) : 0;
  const history =
    hDays >= USUAL_MIN_DAYS ? { start: hStart, end: hEnd, days: hDays } : null;
  const hist = totals(history ? inRange(email, history) : [], extras);
  const uc = (n: number) =>
    history ? usualCount(n, history.days, periodDays) : null;
  const ur = (a: number, b: number) =>
    history ? usualRate(a, b, history.days) : null;
  // A usual of clicks is only quoted on the same basis as the period's
  const clickBasis =
    now.totalBasis &&
    (!before.sends || before.totalBasis) &&
    (!hist.sends || hist.totalBasis)
      ? "total"
      : "unique";
  const clicksOf = (t: Totals) =>
    clickBasis === "total" ? t.clicks : t.clickers;

  // The list: its size at the end of each period from the snapshots, joins from the daily rows, leaves from the campaigns
  const end = sizeAt(i.sizes, i.main.end);
  const start = sizeAt(i.sizes, i.compare.end);
  const startBefore = sizeAt(i.sizes, shiftDay(i.compare.start, -1));
  const latest =
    [...i.sizes].sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
  const joinedIn = (r: Range) => {
    const rows = i.days.filter(
      (d) => d.date >= r.start && d.date <= r.end && d.subscribed != null,
    );
    return rows.length ? sum(rows, (d) => d.subscribed ?? 0) : null;
  };
  const joined = joinedIn(i.main);
  const joinedBefore = joinedIn(i.compare);
  const netOf = (a: typeof end, b: typeof end, j: number | null, u: number) =>
    a && b && a.date !== b.date
      ? a.profiles - b.profiles
      : j != null
        ? j - u
        : null;
  const list: EngagementList = {
    name: i.listName ?? null,
    size: end?.profiles ?? latest?.profiles ?? i.profiles,
    sizeAt: end?.date ?? latest?.date ?? null,
    sizeBefore:
      start && start.date !== (end ?? latest)?.date ? start.profiles : null,
    net: netOf(end, start, joined, now.unsubs),
    netBefore: netOf(start, startBefore, joinedBefore, before.unsubs),
    joined,
    joinedBefore,
    unsubscribes: now.unsubs,
    unsubscribesBefore: before.unsubs,
    history: [...i.sizes]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-12)
      .map((s) => ({ date: s.date, size: s.profiles })),
  };

  // Each campaign, with its best-clicked link when the source gives clicks per link
  const sent = inRange(email, i.main).sort((a, b) =>
    campaignDay(a).localeCompare(campaignDay(b)),
  );
  const median =
    [...sent.map((c) => c.delivered)].sort((a, b) => a - b)[
      Math.floor(sent.length / 2)
    ] ?? 0;
  const home = homeHost(
    sent.flatMap((c) => Object.keys(extras[c.id]?.links ?? {})),
  );
  const campaigns: EngagementCampaign[] = sent.map((c) => {
    const x = extras[c.id];
    const top = Object.entries(x?.links ?? {})
      .map(([u, n]) => ({ l: linkLabel(u, home), n: Number(n) }))
      .filter((y) => y.l && y.n > 0)
      .sort((a, b) => b.n - a.n)[0];
    return {
      id: c.id,
      name: c.name,
      subject: c.subject,
      date: campaignDay(c),
      delivered: c.delivered,
      opens: c.opensUnique,
      clickers: c.clicksUnique,
      clicks: x?.clicksTotal ?? c.clicksUnique,
      openRate: ratio(c.opensUnique, c.delivered || c.recipients),
      clickRate: ratio(c.clicksUnique, c.delivered || c.recipients),
      ctor: ratio(c.clicksUnique, c.opensUnique),
      unsubscribes: c.unsubscribes,
      topLink: top?.l?.label ?? null,
      // A test send or a staff-only email: listed, never picked as the best or the lowest
      small: c.delivered < Math.max(50, median * 0.25),
    };
  });
  const eligible = campaigns.filter((c) => !c.small && c.ctor != null);
  const avgCtor = ratio(
    sum(eligible, (c) => c.clickers),
    sum(eligible, (c) => c.opens),
  );
  const pctTxt = (x: number | null) =>
    x == null ? "–" : `${(x * 100).toFixed(1)}%`;
  const why = (c: EngagementCampaign) =>
    `${pctTxt(c.ctor)} of the people who opened it clicked, against ${pctTxt(avgCtor)} across the period's emails${c.topLink ? `; most clicks went to ${c.topLink}` : ""}.`;
  const ranked = [...eligible].sort(
    (a, b) => (b.ctor ?? 0) - (a.ctor ?? 0) || b.clickers - a.clickers,
  );
  const picks =
    ranked.length >= 2
      ? {
          best: { id: ranked[0].id, why: why(ranked[0]) },
          lowest: { id: ranked.at(-1)!.id, why: why(ranked.at(-1)!) },
        }
      : null;

  // Eight weeks to the period's last day: who it reached and who clicked, week by week
  const trend: EngagementWeek[] = [];
  for (let k = 7; k >= 0; k--) {
    const e = shiftDay(i.main.end, -7 * k);
    const s = shiftDay(e, -6);
    const t = totals(inRange(email, { start: s, end: e }), extras);
    trend.push({
      label: fmtDay(s),
      start: s,
      end: e,
      sends: t.sends,
      delivered: t.delivered,
      opens: t.opens,
      clicks: clicksOf(t),
      clickers: t.clickers,
      openRate: ratio(t.opens, t.delivered),
      clickRate: ratio(t.clickers, t.delivered),
      ctor: ratio(t.clickers, t.opens),
      inPeriod: e >= i.main.start,
    });
  }

  const smsSide = (r: Range) => {
    const xs = inRange(sms, r);
    return {
      campaigns: xs.length,
      sent: sum(xs, (c) => c.recipients),
      delivered: sum(xs, (c) => c.delivered),
      clicks: sum(xs, (c) => c.clicksUnique),
      optOuts: sum(xs, (c) => c.unsubscribes),
    };
  };
  const smsNow = smsSide(i.main);
  const smsView: EngagementSms | null = smsNow.campaigns
    ? { ...smsNow, before: smsSide(i.compare) }
    : null;

  let mtd: EngagementMtd | null = null;
  if (i.kind === "weekly") {
    const { mtd: w, mtdCompare: cw } = monthSoFar(i.main.end);
    const a = totals(inRange(email, w), extras);
    const b = totals(inRange(email, cw), extras);
    const ja = joinedIn(w);
    const jb = joinedIn(cw);
    mtd = {
      window: w,
      compare: cw,
      sends: [a.sends, b.sends],
      reached: [a.delivered, b.delivered],
      clicks: [clicksOf(a), clicksOf(b)],
      net: [
        ja != null ? ja - a.unsubs : null,
        jb != null ? jb - b.unsubs : null,
      ],
    };
  }

  const e: Engagement = {
    version: 1,
    history,
    periodDays,
    recipients: { now: now.recipients, before: before.recipients },
    sends: { now: now.sends, before: before.sends, usual: uc(hist.sends) },
    reached: measure(now.delivered, before.delivered, uc(hist.delivered)),
    opens: measure(now.opens, before.opens, uc(hist.opens)),
    clickers: measure(now.clickers, before.clickers, uc(hist.clickers)),
    clicks: {
      ...measure(clicksOf(now), clicksOf(before), uc(clicksOf(hist))),
      basis: clickBasis,
    },
    openRate: measure(
      ratio(now.opens, now.delivered),
      ratio(before.opens, before.delivered),
      ur(hist.opens, hist.delivered),
    ),
    clickRate: measure(
      ratio(now.clickers, now.delivered),
      ratio(before.clickers, before.delivered),
      ur(hist.clickers, hist.delivered),
    ),
    ctor: measure(
      ratio(now.clickers, now.opens),
      ratio(before.clickers, before.opens),
      ur(hist.clickers, hist.opens),
    ),
    unsubRate: measure(
      ratio(now.unsubs, now.delivered),
      ratio(before.unsubs, before.delivered),
      ur(hist.unsubs, hist.delivered),
    ),
    bounceRate: measure(
      ratio(now.bounced, now.recipients),
      ratio(before.bounced, before.recipients),
      ur(hist.bounced, hist.recipients),
    ),
    spamRate: measure(
      ratio(now.spam, now.delivered),
      ratio(before.spam, before.delivered),
      ur(hist.spam, hist.delivered),
    ),
    list,
    links: linkView(
      sent.map((c) => ({ id: c.id, links: extras[c.id]?.links ?? null })),
    ),
    trend,
    campaigns,
    picks,
    sms: smsView,
    mtd,
    measures: "",
  };
  e.measures = measuresNote(e, i.source ?? null);
  return e;
}

/** One plain sentence that answers "how did email do": reach and clicks, against the usual when there is one */
export function headlineSentence(e: Engagement, kind: string): string {
  const per =
    kind === "monthly" ? "month" : kind === "weekly" ? "week" : "period";
  const int = (x: number | null) =>
    x == null ? "–" : Math.round(x).toLocaleString("en-US");
  const sends = e.sends.now;
  const lead = `${sends} ${sends === 1 ? "email" : "emails"} reached ${int(e.reached.now)} people and sent ${int(e.clicks.now)} ${e.clicks.basis === "total" ? "clicks" : "people"} to your site`;
  const c = usualText(e.clicks);
  const r = usualText(e.reached);
  if (!c && !r) return `${lead}.`;
  const what = e.clicks.basis === "total" ? "Clicks" : "Clickers";
  if (c && r && e.clicks.word === e.reached.word)
    return `${lead}: both ${e.clicks.word === "in line" ? "in line with your usual" : `${e.clicks.word} your usual`} for a ${per}.`;
  return `${lead}. ${[c ? `${what} were ${c}` : null, r ? `reach ${r}` : null].filter(Boolean).join(", ")} for a ${per}.`;
}

/** The footer's note: what this report measures and what the source can't show, in the client's words */
export function measuresNote(
  e: Pick<Engagement, "links" | "list" | "sms" | "clicks">,
  source: string | null,
): string {
  const can = [
    "emails delivered",
    "opens",
    e.clicks.basis === "total" ? "clicks" : "people who clicked",
    ...(e.links ? ["the links clicked"] : []),
    ...(e.list.size != null ? ["list size"] : []),
    "unsubscribes and bounces",
    ...(e.sms ? ["texts sent"] : []),
  ];
  const list =
    can.length > 1
      ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}`
      : can[0];
  return `What this report can measure: ${list}. ${source && source !== "Klaviyo" ? source : "Your email platform"} doesn't record sales or bookings for this account, so email is judged on reach, engagement and clicks to your site.`;
}

/** The same note short enough for the PDF footer's line */
export function measuresShort(
  e: Pick<Engagement, "links" | "list">,
  source: string | null,
): string {
  const what = [
    "reach",
    "opens",
    "clicks",
    ...(e.links ? ["links clicked"] : []),
    ...(e.list.size != null ? ["the list"] : []),
  ];
  return `What this report can measure: ${what.slice(0, -1).join(", ")} and ${what.at(-1)} · ${source && source !== "Klaviyo" ? source : "Your platform"} records no sales for this account`;
}

/** Headline lines for the Slack and email summary (keyLines) */
export function engagementKeyLines(
  e: Engagement,
  compareLabel: string,
): string[] {
  const n = (x: number | null) =>
    x == null ? "–" : Math.round(x).toLocaleString("en-US");
  const vs = (x: Measure) => {
    const parts = [
      x.now != null && x.before != null && x.before > 0
        ? `${x.now >= x.before ? "up" : "down"} ${Math.abs(((x.now - x.before) / x.before) * 100).toFixed(1)}% vs ${compareLabel}`
        : null,
      usualText(x),
    ].filter(Boolean);
    return parts.length ? ` (${parts.join("; ")})` : "";
  };
  const out = [
    `People reached: ${n(e.reached.now)}${vs(e.reached)}`,
    `Opens: ${n(e.opens.now)}, ${n(e.clickers.now)} people clicked`,
    `Clicks to your site: ${n(e.clicks.now)}${vs(e.clicks)}`,
  ];
  if (e.links?.rows[0])
    out.push(
      `Most clicked: ${e.links.rows[0].label} (${n(e.links.rows[0].clicks)} clicks)`,
    );
  if (e.list.net != null)
    out.push(
      `List growth: ${e.list.net > 0 ? "+" : ""}${n(e.list.net)}${e.list.size != null ? `, ${n(e.list.size)} on the list` : ""}`,
    );
  else if (e.list.size != null)
    out.push(
      `List: ${n(e.list.size)} contacts, ${n(e.list.unsubscribes)} unsubscribed`,
    );
  if (e.sms)
    out.push(
      `SMS: ${n(e.sms.sent)} texts sent${e.sms.clicks ? `, ${n(e.sms.clicks)} clicks` : ""}`,
    );
  return out;
}

/** The engagement report's numbers as the writer and the QA read them */
export function engagementText(e: Engagement, compareLabel: string): string {
  const n = (x: number | null) =>
    x == null ? "n/a" : Math.round(x).toLocaleString("en-US");
  const p = (x: number | null, d = 1) =>
    x == null ? "n/a" : `${(x * 100).toFixed(d)}%`;
  const u = (x: Measure, f: (v: number | null) => string) =>
    `${f(x.now)} (before, ${compareLabel}: ${f(x.before)}${x.usual != null ? `; usual for a period this long: ${f(x.usual)}, ${usualText(x)}` : ""})`;
  const out = [
    `This client's revenue isn't tracked: the report is the engagement report. Judge email on reach, engagement and clicks against the period before and against the account's usual (${e.history ? `the average of ${fmtDay(e.history.start)} to ${fmtDay(e.history.end)}, scaled to this period` : "not enough history yet, so no usual"}). Never write revenue, sales, orders or bookings as numbers; never estimate them.`,
    `- Emails sent: ${e.sends.now} (before: ${e.sends.before})`,
    `- People reached (delivered): ${u(e.reached, n)}`,
    `- Opens (unique per email): ${u(e.opens, n)}; open rate ${u(e.openRate, (v) => p(v))}`,
    `- People who clicked: ${u(e.clickers, n)}; click rate ${u(e.clickRate, (v) => p(v, 2))}`,
    `- ${e.clicks.basis === "total" ? "Total clicks to the site and booking pages" : "Clicks (people who clicked; total clicks aren't stored)"}: ${u(e.clicks, n)}`,
    `- Of the people who opened, the share who clicked (click to open): ${u(e.ctor, (v) => p(v))}`,
    `- Unsubscribe rate ${u(e.unsubRate, (v) => p(v, 2))}; bounce rate ${u(e.bounceRate, (v) => p(v, 2))}; spam complaints ${u(e.spamRate, (v) => p(v, 3))}`,
    `- List${e.list.name ? ` (${e.list.name})` : ""}: ${e.list.size != null ? `${n(e.list.size)} contacts (read ${e.list.sizeAt ?? "recently"})` : "size not read"}${e.list.net != null ? `; net change ${e.list.net > 0 ? "+" : ""}${n(e.list.net)} (before: ${n(e.list.netBefore)})` : ""}${e.list.joined != null ? `; new contacts ${n(e.list.joined)} (before: ${n(e.list.joinedBefore)})` : ""}; unsubscribed ${n(e.list.unsubscribes)} (before: ${n(e.list.unsubscribesBefore)})`,
  ];
  if (e.links) {
    out.push(
      `What people clicked (${n(e.links.total)} link clicks across ${e.links.campaigns} emails), by destination: ${e.links.byKind.map((k) => `${k.label} ${Math.round(k.share * 100)}%`).join(", ")}`,
    );
    for (const r of e.links.rows)
      out.push(
        `- ${r.label} [${r.kind}]: ${n(r.clicks)} clicks (${Math.round(r.share * 100)}%), ${r.url}`,
      );
  } else
    out.push(
      "Clicks per link weren't read for this period: don't name which links were clicked.",
    );
  out.push(
    `Every email sent in the period, by date (click to open is the quality measure):`,
  );
  for (const c of e.campaigns)
    out.push(
      `- ${c.date} "${c.name}"${c.subject ? ` (subject: ${c.subject})` : ""}: ${n(c.delivered)} reached, ${p(c.openRate)} opened, ${p(c.clickRate, 2)} clicked, ${p(c.ctor)} of openers clicked, ${n(c.clicks)} clicks${c.topLink ? `, most to ${c.topLink}` : ""}${c.small ? " [a small or test send]" : ""}`,
    );
  if (e.picks) {
    const b = e.campaigns.find((c) => c.id === e.picks!.best.id);
    const l = e.campaigns.find((c) => c.id === e.picks!.lowest.id);
    out.push(
      `The report shows the best and the lowest by click to open: best "${b?.name}" (${e.picks.best.why}); lowest "${l?.name}" (${e.picks.lowest.why})`,
    );
  }
  out.push(
    `By week (ending ${e.trend.at(-1)?.end}): ${e.trend.map((w) => `${w.label}: ${w.sends} sent, ${n(w.delivered)} reached, ${n(w.clicks)} clicks`).join("; ")}`,
  );
  if (e.sms)
    out.push(
      `SMS: ${e.sms.campaigns} campaigns, ${n(e.sms.sent)} texts sent (before: ${n(e.sms.before.sent)}), ${n(e.sms.delivered)} delivered, ${n(e.sms.clicks)} clicks, ${n(e.sms.optOuts)} opt-outs`,
    );
  if (e.mtd)
    out.push(
      `Month to date (${e.mtd.window.label}) against the same days last month (${e.mtd.compare.label}): ${e.mtd.sends[0]} emails sent (before ${e.mtd.sends[1]}), ${n(e.mtd.reached[0])} reached (before ${n(e.mtd.reached[1])}), ${n(e.mtd.clicks[0])} clicks (before ${n(e.mtd.clicks[1])})${e.mtd.net[0] != null ? `, list ${e.mtd.net[0] > 0 ? "+" : ""}${n(e.mtd.net[0])} (before ${n(e.mtd.net[1])})` : ""}.`,
    );
  out.push(e.measures);
  return out.join("\n");
}
