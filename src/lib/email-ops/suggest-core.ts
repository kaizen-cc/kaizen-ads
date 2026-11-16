// Campaign suggestions for an email client, the plain parts: what past sends say worked (days, offers, audiences, subject
// styles), the moments coming up (holidays and seasons), what the client mentioned in Slack, email and calls, and how
// the AI's drafts become rows with a real quote and link (never one the AI wrote itself). Pure, so it is tested without
// a database or the AI.

import { subjectPatterns, type SubjectPattern } from "@/lib/kaizen-ai/email-insights";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);

/** The nth (1-based) weekday (0 = Sunday) of a month; n = -1 is the last one */
function nthWeekday(y: number, m: number, dow: number, n: number): number {
  if (n > 0) {
    const first = new Date(at(y, m, 1)).getUTCDay();
    return at(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
  }
  const last = new Date(at(y, m + 1, 0)).getUTCDay();
  return at(y, m + 1, 0) - ((last - dow + 7) % 7) * DAY;
}

/** Easter Sunday (the anonymous Gregorian algorithm) */
function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return at(y, month, day);
}

export type Moment = { key: string; name: string; date: string; /** How many days ahead a campaign for it is worth planning */ lead: number; note: string };

/** The US moments a retail or service brand sends around, in a given year */
function momentsOf(y: number): Moment[] {
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  const m = (key: string, name: string, t: number, lead: number, note: string): Moment => ({ key, name, date: iso(t), lead, note });
  return [
    m("new_year", "New Year", at(y, 1, 1), 14, "Fresh start, resolutions, year-end clearance"),
    m("valentines", "Valentine's Day", at(y, 2, 14), 21, "Gifting; shipping cutoffs matter"),
    m("easter", "Easter", easter(y), 21, "Spring offers, family and gifting"),
    m("mothers_day", "Mother's Day", nthWeekday(y, 5, 0, 2), 28, "A top gifting moment; shipping cutoffs"),
    m("memorial_day", "Memorial Day", nthWeekday(y, 5, 1, -1), 14, "Start-of-summer sales"),
    m("fathers_day", "Father's Day", nthWeekday(y, 6, 0, 3), 21, "Gifting"),
    m("july_4", "Fourth of July", at(y, 7, 4), 14, "Summer sales"),
    m("back_to_school", "Back to school", at(y, 8, 10), 21, "Families, students, new routines"),
    m("labor_day", "Labor Day", nthWeekday(y, 9, 1, 1), 14, "End-of-summer sales"),
    m("halloween", "Halloween", at(y, 10, 31), 21, "Seasonal themes and offers"),
    m("black_friday", "Black Friday", thanksgiving + DAY, 28, "The biggest send of the year for most stores: teaser, early access, the day, last chance"),
    m("cyber_monday", "Cyber Monday", thanksgiving + 4 * DAY, 28, "Follows Black Friday; online-first offers"),
    m("giving_tuesday", "Giving Tuesday", thanksgiving + 5 * DAY, 14, "Causes and community messaging"),
    m("holiday_shipping", "Holiday shipping cutoffs", at(y, 12, 12), 21, "Last days to order for Christmas"),
    m("christmas", "Christmas", at(y, 12, 25), 28, "Gifting and holiday messaging"),
    m("new_years_eve", "New Year's Eve", at(y, 12, 31), 10, "Year-end sales and last chance"),
  ];
}

/** The moments inside their planning window from `today` (or in the last 2 days), nearest first */
export function upcomingMoments(today: string, horizonDays = 60): Moment[] {
  const t = Date.parse(`${today}T12:00:00Z`);
  const y = new Date(t).getUTCFullYear();
  return [...momentsOf(y), ...momentsOf(y + 1)]
    .map((m) => ({ m, days: Math.round((Date.parse(`${m.date}T12:00:00Z`) - t) / DAY) }))
    .filter(({ m, days }) => days >= -2 && days <= Math.min(horizonDays, Math.max(m.lead, 0) + 14))
    .sort((a, b) => a.days - b.days)
    .map(({ m }) => m);
}

// ─── What past sends say ───────────────────────────────────────────────────

export type SentCampaign = { subject: string | null; name: string; channel: string; sendTime: string | null; recipients: number; openRate: number | null; clickRate: number | null; revenue: number; audiences: string[] };

type Group = { label: string; campaigns: number; open_rate_pct: number | null; click_rate_pct: number | null; revenue_per_recipient: number | null };
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function roll(label: string, rows: SentCampaign[]): Group {
  const sent = rows.reduce((s, c) => s + c.recipients, 0);
  const w = (get: (c: SentCampaign) => number | null) => {
    const have = rows.filter((c) => get(c) != null);
    const tot = have.reduce((s, c) => s + c.recipients, 0);
    return tot ? have.reduce((s, c) => s + (get(c) as number) * c.recipients, 0) / tot : null;
  };
  const open = w((c) => c.openRate);
  const click = w((c) => c.clickRate);
  return { label, campaigns: rows.length, open_rate_pct: open == null ? null : round(open * 100), click_rate_pct: click == null ? null : round(click * 100, 2), revenue_per_recipient: sent ? round(rows.reduce((s, c) => s + c.revenue, 0) / sent, 3) : null };
}

const OFFERS: { label: string; test: RegExp }[] = [
  { label: "a percentage or dollar discount", test: /\d+\s?%|\$\s?\d+\s?off|\bsave\b|\bdiscount\b/i },
  { label: "free shipping", test: /free ship/i },
  { label: "a gift or bonus", test: /\bfree gift\b|\bbonus\b|\bgift with\b|\bBOGO\b|buy one/i },
  { label: "new arrivals or a launch", test: /\bnew\b|\blaunch|\bintroducing\b|\bjust dropped\b/i },
  { label: "back in stock or low stock", test: /restock|back in stock|\bselling out\b|\blast chance\b|almost gone/i },
  { label: "early access or members only", test: /early access|\bvip\b|members? only|exclusive/i },
];

const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" });

export type PerformanceFacts = {
  /** Sends read (email campaigns with a real audience in the window) */
  sends: number;
  baseline: Group | null;
  subjects: SubjectPattern[];
  byWeekday: Group[];
  offers: Group[];
  audiences: Group[];
  best: { sent: string; subject: string; recipients: number; open_rate_pct: number | null; revenue: number }[];
};

/** What past email campaigns say worked, by subject style, send day, offer type and audience (groups under `min` sends are noise and left out) */
export function performanceFacts(campaigns: readonly SentCampaign[], min = 3): PerformanceFacts {
  const emails = campaigns.filter((c) => c.channel !== "sms" && c.sendTime && c.recipients > 0);
  const groups = (key: (c: SentCampaign) => string[]) => {
    const by = new Map<string, SentCampaign[]>();
    for (const c of emails) for (const k of key(c)) by.set(k, [...(by.get(k) ?? []), c]);
    return [...by].filter(([, rows]) => rows.length >= min).map(([label, rows]) => roll(label, rows)).sort((a, b) => (b.revenue_per_recipient ?? 0) - (a.revenue_per_recipient ?? 0));
  };
  return {
    sends: emails.length,
    baseline: emails.length >= min ? roll("all email campaigns", emails) : null,
    subjects: subjectPatterns(emails.map((c) => ({ subject: c.subject, channel: c.channel, recipients: c.recipients, openRate: c.openRate, clickRate: c.clickRate, revenue: c.revenue })), min),
    byWeekday: groups((c) => [dayOf(c.sendTime as string)]),
    offers: groups((c) => OFFERS.filter((o) => o.test.test(`${c.subject ?? ""} ${c.name}`)).map((o) => o.label)),
    audiences: groups((c) => c.audiences),
    best: [...emails]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map((c) => ({ sent: (c.sendTime as string).slice(0, 10), subject: c.subject ?? c.name, recipients: c.recipients, open_rate_pct: c.openRate == null ? null : round(c.openRate * 100), revenue: Math.round(c.revenue) })),
  };
}

export function performanceText(f: PerformanceFacts): string {
  if (!f.baseline) return "Not enough past sends to read patterns yet (fewer than 3 email campaigns).";
  const line = (g: Group) => `- ${g.label}: ${g.campaigns} sends, open ${g.open_rate_pct ?? "n/a"}%, click ${g.click_rate_pct ?? "n/a"}%, revenue per recipient ${g.revenue_per_recipient == null ? "n/a" : `$${g.revenue_per_recipient}`}`;
  return [
    `Baseline: ${line(f.baseline).slice(2)}`,
    "Subject styles:",
    ...f.subjects.map((s) => `- ${s.trait}: ${s.campaigns} sends, open ${s.open_rate_pct ?? "n/a"}%, click ${s.click_rate_pct ?? "n/a"}%, revenue per recipient ${s.revenue_per_recipient == null ? "n/a" : `$${s.revenue_per_recipient}`}`),
    "Send day:",
    ...f.byWeekday.map(line),
    "Offer types:",
    ...f.offers.map(line),
    "Audiences:",
    ...f.audiences.map(line),
    "Biggest earners:",
    ...f.best.map((b) => `- ${b.sent} "${b.subject}": ${b.recipients} recipients, open ${b.open_rate_pct ?? "n/a"}%, $${b.revenue}`),
  ].join("\n");
}

// ─── What the client mentioned ─────────────────────────────────────────────

export type ContextItem = { id: string; source: string; occurred_at: string; author: string | null; title: string | null; body: string | null; url: string | null };
export type Mention = { n: number; id: string; origin: "slack" | "email" | "call"; at: string; who: string | null; title: string | null; text: string; url: string | null };

const MENTION = /\b(sale|promo|promotion|launch(?:ing|es)?|new (?:product|collection|line|flavor|season|menu|service)|collection|drop|discount|coupon|code|bundle|giveaway|webinar|event|open house|grand opening|pre-?order|restock|limited edition|anniversary|black friday|cyber monday|holiday|mother'?s day|father'?s day|back to school|clearance|\d+\s?% off|free shipping|announce|rolling out|coming (?:soon|up)|next (?:week|month))\b/i;

/** Slack posts, emails and calls from the last 45 days that talk about a promotion, launch or event, newest first, numbered for the AI to cite */
export function pickMentions(items: readonly ContextItem[], now = Date.now(), max = 25): Mention[] {
  const since = now - 45 * DAY;
  const kept = items
    .filter((i) => Date.parse(i.occurred_at) >= since && (i.body || i.title) && MENTION.test(`${i.title ?? ""} ${i.body ?? ""}`))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, max);
  return kept.map((i, idx) => ({
    n: idx + 1,
    id: i.id,
    origin: i.source.startsWith("slack") ? "slack" : i.source === "gmail" ? "email" : "call",
    at: i.occurred_at,
    who: i.author,
    title: i.title,
    text: excerpt(`${i.title ? `${i.title}. ` : ""}${i.body ?? ""}`),
    url: i.url,
  }));
}

/** About 280 characters centred on the first promotion-like word, so the quote shows what was said */
export function excerpt(text: string, size = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= size) return t;
  const m = MENTION.exec(t);
  const from = Math.max(0, (m?.index ?? 0) - Math.floor(size / 3));
  const cut = t.slice(from, from + size).trim();
  return `${from > 0 ? "…" : ""}${cut}${from + size < t.length ? "…" : ""}`;
}

// ─── The AI's drafts become rows ───────────────────────────────────────────

export type Draft = { title: string; idea: string; why: string; origin: "performance" | "calendar" | "mention"; evidence: string[]; sendOn: string; momentKey: string; mention: number };

const S = { type: "string" } as const;
export const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: S,
          idea: S,
          why: S,
          origin: { type: "string", enum: ["performance", "calendar", "mention"] },
          evidence: { type: "array", items: S },
          sendOn: S,
          momentKey: S,
          mention: { type: "integer" },
        },
        required: ["title", "idea", "why", "origin", "evidence", "sendOn", "momentKey", "mention"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
} as const;

export type SuggestionRow = {
  origin: "performance" | "calendar" | "slack" | "email" | "call";
  title: string;
  idea: string;
  why: string | null;
  evidence: string[];
  send_on: string | null;
  source_quote: string | null;
  source_url: string | null;
  source_at: string | null;
  dedupe_key: string;
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Turns drafts into rows. The quote and link come from the mention the draft cites (never from the AI's own words); a
 * draft that cites a mention that does not exist is kept as a performance idea; a send day in the past or not a date is
 * dropped; and the same moment, mention or idea is never twice (dedupe_key), here or against `already`.
 */
export function toRows(drafts: readonly Draft[], mentions: readonly Mention[], moments: readonly Moment[], today: string, already: ReadonlySet<string> = new Set()): SuggestionRow[] {
  const seen = new Set(already);
  const out: SuggestionRow[] = [];
  for (const d of drafts) {
    const title = d.title.trim();
    const idea = d.idea.trim();
    if (!title || !idea) continue;
    const m = d.origin === "mention" ? mentions.find((x) => x.n === d.mention) : undefined;
    const moment = d.origin === "calendar" ? moments.find((x) => x.key === d.momentKey) : undefined;
    const origin: SuggestionRow["origin"] = m ? m.origin : moment ? "calendar" : "performance";
    const key = m ? `mention:${m.id}` : moment ? `moment:${moment.key}:${moment.date.slice(0, 4)}` : `perf:${slug(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(d.sendOn) && d.sendOn >= today ? d.sendOn : null;
    out.push({
      origin,
      title: title.slice(0, 160),
      idea: idea.slice(0, 1200),
      why: d.why.trim().slice(0, 600) || null,
      evidence: d.evidence.map((e) => e.trim()).filter(Boolean).slice(0, 5),
      send_on: day,
      source_quote: m ? m.text : moment ? `${moment.name} is on ${moment.date}. ${moment.note}.` : null,
      source_url: m?.url ?? null,
      source_at: m?.at ?? null,
      dedupe_key: key,
    });
  }
  return out;
}
