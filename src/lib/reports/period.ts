// A report's period: the one source of truth for the dates every page of a report shows. Picked from a preset (last
// week Mon to Sun, the last 7, 14 or 30 days, this month, last month) or set by hand, always in the client's time zone
// (New York unless they have their own), and always over: data runs through yesterday. The comparison is the period of
// the same length just before it. Plain functions, no server code, so the studio, the AI chat and the tests share them.

export type PeriodKey = "lastWeek" | "last7" | "last14" | "last30" | "thisMonth" | "lastMonth" | "custom";
export type Range = { start: string; end: string };
export type ReportPeriod = Range & { key: PeriodKey; label: string };

export const DEFAULT_TZ = "America/New_York";

export const PERIOD_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: "lastWeek", label: "Last week (Mon to Sun)" },
  { key: "last7", label: "Last 7 days" },
  { key: "last14", label: "Last 14 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "custom", label: "Custom dates" },
];
export const isPeriodKey = (k: unknown): k is PeriodKey => PERIOD_PRESETS.some((p) => p.key === k);
export const presetLabel = (k: PeriodKey) => PERIOD_PRESETS.find((p) => p.key === k)?.label ?? "Custom dates";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === "string" && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** Today's date (YYYY-MM-DD) where the client is */
export function todayIn(tz: string = DEFAULT_TZ, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
}

export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysIn = (r: Range) => Math.round((Date.parse(`${r.end}T12:00:00Z`) - Date.parse(`${r.start}T12:00:00Z`)) / 86_400_000) + 1;
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const fmt = (day: string, year = false) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

/** "Nov 2 – Nov 8", with the year when it isn't this one ("Dec 29, 2025 – Jan 4, 2026") */
export function rangeLabel(r: Range, today?: string) {
  const year = Boolean(today && (r.start.slice(0, 4) !== today.slice(0, 4) || r.end.slice(0, 4) !== today.slice(0, 4)));
  return `${fmt(r.start, year)} – ${fmt(r.end, year)}`;
}

/** The week (Mon to Sun) before the one `today` is in: on a Monday, the seven days that just ended */
export function lastFullWeek(today: string): Range {
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const end = shiftDay(today, -(dow + 1));
  return { start: shiftDay(end, -6), end };
}

/** A preset (or custom dates) as dates, as of `today` where the client is. Null when custom dates aren't usable. */
export function resolvePeriod(key: PeriodKey, today: string, custom?: Partial<Range> | null): ReportPeriod | null {
  const yesterday = shiftDay(today, -1);
  const made = (r: Range): ReportPeriod => ({ key, label: presetLabel(key), ...r });
  if (key === "lastWeek") return made(lastFullWeek(today));
  if (key === "last7") return made({ start: shiftDay(yesterday, -6), end: yesterday });
  if (key === "last14") return made({ start: shiftDay(yesterday, -13), end: yesterday });
  if (key === "last30") return made({ start: shiftDay(yesterday, -29), end: yesterday });
  if (key === "thisMonth") {
    // On the 1st there's nothing this month yet: the month that just ended
    const start = monthStart(today);
    return made(start > yesterday ? { start: monthStart(yesterday), end: yesterday } : { start, end: yesterday });
  }
  if (key === "lastMonth") {
    const end = shiftDay(monthStart(today), -1);
    return made({ start: monthStart(end), end });
  }
  if (!custom || !isDay(custom.start) || !isDay(custom.end) || custom.start > custom.end || custom.start > yesterday) return null;
  const end = custom.end > yesterday ? yesterday : custom.end;
  if (daysIn({ start: custom.start, end }) > 400) return null;
  return made({ start: custom.start, end });
}

/** The comparison: the same number of days just before */
export function previousPeriod(r: Range): Range {
  const end = shiftDay(r.start, -1);
  return { start: shiftDay(end, -(daysIn(r) - 1)), end };
}

/** The period after this one, the same length ("Duplicate for next week"), as far as the data goes; null if not over */
export function nextPeriod(r: Range, today: string): Range | null {
  const start = shiftDay(r.end, 1);
  const yesterday = shiftDay(today, -1);
  if (start > yesterday) return null;
  const end = shiftDay(start, daysIn(r) - 1);
  return { start, end: end > yesterday ? yesterday : end };
}

/** Which preset gives exactly these dates today (for the picker), else custom */
export function matchPreset(r: Range, today: string): PeriodKey {
  for (const p of PERIOD_PRESETS) {
    if (p.key === "custom") continue;
    const x = resolvePeriod(p.key, today);
    if (x && x.start === r.start && x.end === r.end) return p.key;
  }
  return "custom";
}

/**
 * The pieces of a report that don't show its period (numbers drawn for other dates, a comparison that isn't the
 * period just before, a trend chart that ends elsewhere): every page must follow the report's dates, so a report with
 * any of these is redrawn before it can go out. Empty when everything lines up.
 */
export function periodMismatch(period: Range, m: { main: Range; compare: Range } | null | undefined, sections?: { stories?: { title?: string; points?: { end: string }[] }[] } | null): string[] {
  if (!m) return ["numbers"];
  const out: string[] = [];
  if (m.main.start !== period.start || m.main.end !== period.end) out.push("numbers");
  const prev = previousPeriod(period);
  if (m.compare.start !== prev.start || m.compare.end !== prev.end) out.push("comparison");
  (sections?.stories ?? []).forEach((st, i) => {
    const last = st.points?.at(-1)?.end;
    if (last && last !== period.end) out.push(`chart ${i + 1}${st.title ? ` (${st.title})` : ""}`);
  });
  return out;
}

// ─── Dates in what the buyer types ("Nov 2 to 8", "last week", "10/26 - 11/1") ────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const D = "(\\d{1,2})(?:st|nd|rd|th)?";
const Y = "(?:,?\\s*(\\d{4}))?";
const SEP = "\\s*(?:-|–|—|to|through|thru|until|till|and)\\s*";
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30 };
const COMPARE = /\b(compar\w*|vs\.?|versus|against|than)\b/i;

const monthOf = (s: string) => MONTHS[s.toLowerCase().slice(0, 3)];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return isDay(s) ? s : null;
};

export type ParsedDates = { ok: true; period: ReportPeriod; matched: string; compare: boolean } | { ok: false; error: string; matched: string; compare: boolean };

/**
 * The dates the buyer asked for, if they named any: explicit ("Nov 2 to 8", "Nov 2 - Nov 8, 2026", "10/26 to 11/1",
 * "2026-11-02 to 2026-11-08", "the week of Nov 2", "for October") or relative ("last week", "the last 14 days",
 * "this month"), read against today where the client is. A date without a year is the latest one that's already over.
 * `compare`: the dates are something to compare against, not the report's new period.
 */
export function parseDates(text: string, today: string): ParsedDates | null {
  const t = text.replace(/\s+/g, " ");
  const compare = COMPARE.test(t);
  const yesterday = shiftDay(today, -1);
  const year = Number(today.slice(0, 4));
  const done = (key: PeriodKey, r: Range | null, matched: string): ParsedDates | null => {
    if (!r) return null;
    if (r.start > yesterday) return { ok: false, error: `${rangeLabel(r, today)} isn't over yet: the data runs through yesterday (${fmt(yesterday)}).`, matched, compare };
    const p = key === "custom" ? resolvePeriod("custom", today, r) : resolvePeriod(key, today);
    return p ? { ok: true, period: p, matched, compare } : null;
  };
  // A month and day without a year: this year's, unless that's more than a month away (then last year's): "Nov 9 to
  // 15" asked on Nov 9 is this week (not over yet), "Dec 28 to Jan 3" asked in November is last winter
  const guess = (m: number, d: number, y?: number) => {
    if (y) return ymd(y, m, d);
    const now = ymd(year, m, d);
    return now && now <= shiftDay(today, 31) ? now : ymd(year - 1, m, d);
  };
  const span = (s: string | null, e: { m: number; d: number; y?: number }): Range | null => {
    if (!s) return null;
    const startYear = Number(s.slice(0, 4));
    let end = ymd(e.y ?? startYear, e.m, e.d);
    if (end && end < s && !e.y) end = ymd(startYear + 1, e.m, e.d);
    return end && end >= s ? { start: s, end } : null;
  };

  // ISO dates
  let m = t.match(new RegExp(`(\\d{4}-\\d{2}-\\d{2})${SEP}(\\d{4}-\\d{2}-\\d{2})`, "i"));
  if (m && isDay(m[1]) && isDay(m[2]) && m[1] <= m[2]) return done("custom", { start: m[1], end: m[2] }, m[0]);

  // "Nov 2 to 8", "Nov 2, 2026 - Nov 8, 2026", "Oct 26 to Nov 1"
  m = t.match(new RegExp(`\\b${MON}\\s+${D}${Y}${SEP}(?:${MON}\\s+)?${D}(?!\\d)${Y}`, "i"));
  if (m) {
    const [, m1, d1, y1, m2, d2, y2] = m;
    const yEnd = y2 ? Number(y2) : undefined;
    const yStart = y1 ? Number(y1) : yEnd;
    const sm = monthOf(m1);
    const em = m2 ? monthOf(m2) : sm;
    // A year given only at the end ("Dec 28 to Jan 3, 2026") belongs to the end
    const s = yStart && !y1 && em < sm ? guess(sm, Number(d1), yStart - 1) : guess(sm, Number(d1), yStart);
    return done("custom", span(s, { m: em, d: Number(d2), y: yEnd }), m[0]);
  }

  // "2 to 8 Nov", "26 Oct - 1 Nov 2026"
  m = t.match(new RegExp(`\\b${D}(?:\\s+${MON})?${SEP}${D}\\s+${MON}${Y}`, "i"));
  if (m) {
    const [, d1, m1, d2, m2, y2] = m;
    const em = monthOf(m2);
    const sm = m1 ? monthOf(m1) : em;
    const y = y2 ? Number(y2) : undefined;
    const s = guess(sm, Number(d1), y && sm > em ? y - 1 : y);
    return done("custom", span(s, { m: em, d: Number(d2), y }), m[0]);
  }

  // "10/26 to 11/1", "11/2/2026 - 11/8/2026"
  m = t.match(new RegExp(`\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?${SEP}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, "i"));
  if (m) {
    const full = (y?: string) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : undefined);
    const [, a, b, y1, c, d, y2] = m;
    const yEnd = full(y2);
    const s = guess(Number(a), Number(b), full(y1) ?? (yEnd && Number(c) < Number(a) ? yEnd - 1 : yEnd));
    return done("custom", span(s, { m: Number(c), d: Number(d), y: yEnd }), m[0]);
  }

  // "the week of Nov 2"
  m = t.match(new RegExp(`\\bweek of ${MON}\\s+${D}${Y}`, "i"));
  if (m) {
    const s = guess(monthOf(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    return done("custom", s ? { start: s, end: shiftDay(s, 6) } : null, m[0]);
  }

  // Relative
  m = t.match(/\b(?:the\s+)?(?:last|past|previous|prior)\s+(\d{1,3}|seven|fourteen|thirty|ten)\s+days\b/i);
  if (m) {
    const n = Number(m[1]) || NUM[m[1].toLowerCase()];
    if (n === 7) return done("last7", { start: shiftDay(yesterday, -6), end: yesterday }, m[0]);
    if (n === 14) return done("last14", { start: shiftDay(yesterday, -13), end: yesterday }, m[0]);
    if (n === 30) return done("last30", { start: shiftDay(yesterday, -29), end: yesterday }, m[0]);
    return n >= 1 && n <= 400 ? done("custom", { start: shiftDay(yesterday, -(n - 1)), end: yesterday }, m[0]) : null;
  }
  m = t.match(/\b(?:the\s+)?(?:last|past|previous)\s+(two|2|four|4)\s+weeks\b/i);
  if (m) {
    const n = /two|2/i.test(m[1]) ? 14 : 28;
    return done(n === 14 ? "last14" : "custom", { start: shiftDay(yesterday, -(n - 1)), end: yesterday }, m[0]);
  }
  // "last week" (not "last week's format", which is about an earlier report)
  m = t.match(/\b(?:last|previous|past)\s+week\b(?!['’]s)/i);
  if (m) return done("lastWeek", lastFullWeek(today), m[0]);
  m = t.match(/\bthis week\b(?!['’]s)/i);
  if (m) {
    const r = lastFullWeek(shiftDay(today, 7));
    return done("custom", { start: r.start, end: yesterday < r.start ? r.start : yesterday }, m[0]);
  }
  m = t.match(/\b(?:this month|month to date|mtd)\b(?!['’]s)/i);
  if (m) return done("thisMonth", { start: monthStart(today), end: yesterday }, m[0]);
  m = t.match(/\b(?:last|previous|past)\s+month\b(?!['’]s)/i);
  if (m) {
    const end = shiftDay(monthStart(today), -1);
    return done("lastMonth", { start: monthStart(end), end }, m[0]);
  }
  // "for October", "the month of October 2026"
  m = t.match(new RegExp(`\\b(?:for|in|of|cover(?:ing)?|month of)\\s+${MON}(?:\\s+(\\d{4}))?(?!\\s*\\d)\\b`, "i"));
  if (m) {
    const mm = monthOf(m[1]);
    const s = m[2] ? ymd(Number(m[2]), mm, 1) : guess(mm, 1);
    if (!s) return null;
    const end = shiftDay(monthStart(shiftDay(s, 32)), -1);
    return done("custom", { start: s, end }, m[0]);
  }
  return null;
}

/** What's left of the ask once its dates and the words about changing them are taken out: anything else to do too */
export function restOfAsk(text: string, matched: string) {
  const filler = /\b(hey|hi|ok|okay|thanks|thank|can|could|would|you|please|pls|change|update|set|move|switch|use|make|redo|regenerate|refresh|rerun|re-run|pull|show|run|it|this|that|the|a|report|reports|dates?|range|period|timeframe|time|frame|to|for|from|of|instead|me|all|every|slides?|pages?|numbers|data|with|weekly|week|and|cover|covering|should|be|is|i|want|need|fresh|new|on|in|so|just|only|over|whole|entire|now|again|it's|its|also|too|then)\b/gi;
  return text.replace(matched, " ").replace(filler, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
