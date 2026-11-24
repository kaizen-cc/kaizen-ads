import { THRESHOLDS } from "@/lib/line-review/core";

// The daily watchdogs, the pure part (no database, no keys): same-day checks that reach the account owner and the
// line's head as a notice in Kaizen OS (bell + Today), once per issue, until it's fixed. Never Slack: team work stays in
// the OS. The run (./run.ts) reads the accounts and turns these into account watch flags (src/lib/account-watch).

export const DOG_KINDS = [
  "client_changed",
  "admin_removal",
  "unapproved_change",
  "over_budget",
  "zero_results",
  "past_event",
  "special_category",
  "lead_no_crm",
  "access_lost",
  "integration_auth",
  "payment_issue",
  "delivery_issue",
  "quiet_channel",
  "creative_stuck",
  "big_date",
  "site_down",
  "site_check",
  "tracking_audit",
  "tracking_mismatch",
  "cvr_drop",
  "precall_sync",
] as const;
/** The tracking signals (the Tracking Specialist's Today reads these, plus zero_results and lead_no_crm) */
export const TRACKING_KINDS: readonly DogKind[] = ["tracking_audit", "tracking_mismatch", "cvr_drop", "zero_results", "lead_no_crm"];
export type DogKind = (typeof DOG_KINDS)[number];
export const isDogKind = (k: string): k is DogKind => (DOG_KINDS as readonly string[]).includes(k);

const DAY = 86_400_000;
const at = (day: string) => Date.parse(`${day.slice(0, 10)}T12:00:00Z`);
export const daysBetween = (from: string, to: string) => Math.floor((at(to) - at(from)) / DAY);
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10);

// ─── Dates that matter ─────────────────────────────────────────────────────

/** The n-th weekday (0 Sunday) of a month; n = -1 is the last */
function nthWeekday(y: number, m: number, weekday: number, n: number) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1, 12)).getUTCDay();
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0, 12));
  return iso(y, m, lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7));
}
/** Easter Sunday (anonymous Gregorian computus) */
function easter(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return iso(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}

export type Holiday = { key: string; name: string; match: RegExp; date: (y: number) => string; /** Days after it still fine to run (sales that last a few days) */ grace: number };

export const HOLIDAYS: Holiday[] = [
  { key: "valentines", name: "Valentine's Day", match: /valentine/i, date: (y) => iso(y, 2, 14), grace: 1 },
  { key: "st_patricks", name: "St. Patrick's Day", match: /st\.? ?patrick|paddy'?s day/i, date: (y) => iso(y, 3, 17), grace: 1 },
  { key: "easter", name: "Easter", match: /\beaster\b/i, date: easter, grace: 1 },
  { key: "mothers_day", name: "Mother's Day", match: /mother'?s ?day/i, date: (y) => nthWeekday(y, 5, 0, 2), grace: 1 },
  { key: "memorial_day", name: "Memorial Day", match: /memorial ?day/i, date: (y) => nthWeekday(y, 5, 1, -1), grace: 2 },
  { key: "fathers_day", name: "Father's Day", match: /father'?s ?day/i, date: (y) => nthWeekday(y, 6, 0, 3), grace: 1 },
  { key: "july_4", name: "the 4th of July", match: /4th of july|fourth of july|july 4(?:th)?\b|independence day/i, date: (y) => iso(y, 7, 4), grace: 2 },
  { key: "labor_day", name: "Labor Day", match: /labou?r ?day/i, date: (y) => nthWeekday(y, 9, 1, 1), grace: 2 },
  { key: "halloween", name: "Halloween", match: /hallowe'?en|spooky season|trick[- ]or[- ]treat/i, date: (y) => iso(y, 10, 31), grace: 2 },
  { key: "thanksgiving", name: "Thanksgiving", match: /thanksgiving|friendsgiving/i, date: (y) => nthWeekday(y, 11, 4, 4), grace: 1 },
  { key: "black_friday", name: "Black Friday", match: /black ?friday|\bbfcm\b/i, date: (y) => iso(y, 11, Number(nthWeekday(y, 11, 4, 4).slice(8, 10)) + 1), grace: 4 },
  { key: "cyber_monday", name: "Cyber Monday", match: /cyber ?monday|cyber ?week/i, date: (y) => iso(y, 11, Number(nthWeekday(y, 11, 4, 4).slice(8, 10)) + 4), grace: 3 },
  { key: "christmas", name: "Christmas", match: /christmas|xmas/i, date: (y) => iso(y, 12, 25), grace: 1 },
  { key: "new_year", name: "New Year's", match: /new year'?s? (?:eve|day|sale)|\bnye\b/i, date: (y) => iso(y + 1, 1, 1), grace: 2 },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** An explicit day named in an ad ("Nov 15", "November 15th", "11/15") as YYYY-MM-DD in the year it most likely means */
function explicitDays(text: string, today: string): string[] {
  const y = Number(today.slice(0, 4));
  const out: string[] = [];
  const near = (m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    // The year that puts it closest to today (an ad in January about "Dec 31" means last year)
    const cands = [y - 1, y, y + 1].map((yy) => iso(yy, m, d)).sort((a, b) => Math.abs(daysBetween(a, today)) - Math.abs(daysBetween(b, today)));
    out.push(cands[0]);
  };
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) near(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) near(Number(m[1]), Number(m[2]));
  return out;
}

/**
 * An ad (its name and copy) still running after its event: a holiday whose day (plus a short grace for sales that run
 * on) has passed with the next one far off, or an explicit date more than two days ago. Halloween ads in November.
 */
export function pastEvent(text: string, today: string): { event: string; date: string } | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const y = Number(today.slice(0, 4));
  for (const h of HOLIDAYS) {
    if (!h.match.test(t)) continue;
    const last = [h.date(y), h.date(y - 1)].filter((d) => d <= today).sort().pop();
    const next = [h.date(y), h.date(y + 1)].filter((d) => d > today).sort()[0];
    if (!last) continue;
    const since = daysBetween(last, today);
    const until = next ? daysBetween(today, next) : Infinity;
    // Past by more than its grace, and not already the run-up to next year's
    if (since > h.grace && until > 45) return { event: h.name, date: last };
  }
  for (const d of explicitDays(t, today)) {
    const since = daysBetween(d, today);
    if (since > 2 && since < 120) return { event: `the ${d.slice(5).replace("-", "/")} date in it`, date: d };
  }
  return null;
}

// ─── Special ad categories ─────────────────────────────────────────────────

const SPECIAL: { category: "HOUSING" | "EMPLOYMENT" | "FINANCIAL_PRODUCTS_SERVICES"; label: string; match: RegExp }[] = [
  { category: "HOUSING", label: "housing", match: /\b(apartments?|for rent|rentals?|now leasing|leasing|homes? for sale|real estate|realtor|mortgages?|condos?|townhomes?|move[- ]in special|floor ?plans?)\b/i },
  { category: "EMPLOYMENT", label: "employment", match: /\b(now hiring|we'?re hiring|hiring|job openings?|careers? at|join our team|apply (?:today|now) (?:for|to) (?:the|a|our) (?:job|position|role)|recruiting)\b/i },
  { category: "FINANCIAL_PRODUCTS_SERVICES", label: "credit", match: /\b(credit cards?|personal loans?|business loans?|auto loans?|loans?|refinanc\w*|credit score|line of credit|apr\b|payday|lending|lender)\b/i },
];
/** Meta's older name for the credit category still counts */
const HAS = (cats: readonly string[], c: string) => cats.includes(c) || (c === "FINANCIAL_PRODUCTS_SERVICES" && cats.includes("CREDIT"));

/** A live campaign whose name or ads read as housing, employment or credit, without that special ad category */
export function missingSpecialCategory(text: string, categories: readonly string[] | null | undefined): { category: string; label: string } | null {
  const cats = (categories ?? []).map((c) => String(c).toUpperCase());
  for (const s of SPECIAL) if (s.match.test(text) && !HAS(cats, s.category)) return { category: s.category, label: s.label };
  return null;
}

// ─── Account status, payment, delivery ─────────────────────────────────────

/** Meta account_status: 1 active, 2 disabled, 3 unsettled, 7 risk review, 8 pending settlement, 9 grace period, 100/101 closing/closed */
export function accountStatusIssue(a: { account_status?: number | null; disable_reason?: number | null; funding_source?: string | null } | null, spending: boolean): { kind: "payment_issue" | "delivery_issue"; title: string; critical: boolean } | null {
  if (!a || a.account_status == null) return null;
  const s = Number(a.account_status);
  if (s === 3 || s === 8 || s === 9) return { kind: "payment_issue", title: s === 9 ? "Payment failed: the ad account is in its grace period" : "Payment failing: the ad account has an unsettled balance", critical: true };
  if (s === 2) return { kind: "delivery_issue", title: `Ad account disabled by Meta${a.disable_reason ? ` (reason ${a.disable_reason})` : ""}`, critical: true };
  if (s === 7) return { kind: "delivery_issue", title: "Ad account under Meta's risk review: delivery may stop", critical: true };
  if (s === 100 || s === 101) return { kind: "delivery_issue", title: "Ad account is closing or closed", critical: true };
  if (s === 1 && "funding_source" in a && !a.funding_source && spending) return { kind: "payment_issue", title: "No payment method on the ad account", critical: true };
  return null;
}

/** An ad account change that removes someone's access (where Meta shows it) */
export const isAccessRemoval = (what: string) => /remov\w* .{0,30}(admin|user|person|people|partner|access|permission|role)|(admin|role|access|permission)\w* .{0,20}(remov|revok)|revoked access|unassign/i.test(what);
/** An error that means we lost access (a page, an ad account, a social account) rather than a passing hiccup */
export const isAccessError = (error: string | null | undefined) => /permission|not authori[sz]ed|does not have|no access|access denied|cannot be loaded|unsupported get request|\(#10\)|\(#200\)|\(#100\).*missing|oauth|session has (?:expired|been invalidated)|token/i.test(String(error ?? ""));
/** An integration's error that means its authorization is gone (a revoked key, an expired grant) */
export const isAuthError = (error: string | null | undefined) => /unauthori[sz]ed|\b401\b|\b403\b|revoked|invalid (?:api )?key|expired|forbidden|authentication|not authenticated|reconnect/i.test(String(error ?? ""));

// ─── Spend with nothing to show ────────────────────────────────────────────

export type DayMetrics = { spend: number; linkClicks: number; landingPageViews: number; results: number };

/** Three days of spend ($75 or more) with no landing page views behind the clicks, or no results at all */
export function zeroOutcome(m: DayMetrics, opts: { expectsSite: boolean; minSpend?: number } = { expectsSite: true }): { kind: "no_lpv" | "no_results"; text: string } | null {
  const min = opts.minSpend ?? 75;
  if (m.spend < min) return null;
  if (opts.expectsSite && m.linkClicks >= 10 && m.landingPageViews === 0) return { kind: "no_lpv", text: `${m.linkClicks} link clicks and no landing page views: the pixel or the landing page is broken` };
  if (m.results === 0) return { kind: "no_results", text: "no results at all" };
  return null;
}

/** Meta's results: the campaign's lead, purchase or registration actions (whichever it has) */
export function resultsOf(actions: Record<string, number> | null | undefined): number {
  const a = actions ?? {};
  const keys = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "complete_registration", "omni_complete_registration", "contact", "schedule", "submit_application", "onsite_conversion.messaging_conversation_started_7d"];
  return Math.max(0, ...keys.map((k) => Number(a[k] ?? 0)));
}
export const leadsOf = (actions: Record<string, number> | null | undefined) => Math.max(Number(actions?.lead ?? 0), Number(actions?.["onsite_conversion.lead_grouped"] ?? 0), Number(actions?.["offsite_conversion.fb_pixel_lead"] ?? 0));

// ─── Silence, stuck creative, big dates ────────────────────────────────────

export const quietFor = (days: number | null) => days == null || days >= THRESHOLDS.silentDays;
/** A creative ticket sitting in one stage (or with one person) for 7 days or more (launched and done never count) */
export function stuckDays(stage: string, stageEnteredAt: string | null | undefined, today: string): number | null {
  if (!stageEnteredAt || ["launched", "done", "completed", "archived", "live"].includes(stage)) return null;
  const d = daysBetween(stageEnteredAt.slice(0, 10), today);
  return d >= THRESHOLDS.creativeStuckDays ? d : null;
}

/** The big selling dates that need email built ahead of time */
export const BIG_DATES = ["black_friday", "cyber_monday", "christmas", "valentines", "mothers_day"] as const;

/** Big dates 0–10 days out (BFCM emails not built 10 days ahead is late) */
export function bigDatesAhead(today: string, within = 10): { key: string; name: string; date: string; days: number; match: RegExp }[] {
  const y = Number(today.slice(0, 4));
  const out: { key: string; name: string; date: string; days: number; match: RegExp }[] = [];
  for (const h of HOLIDAYS.filter((x) => (BIG_DATES as readonly string[]).includes(x.key))) {
    for (const d of [h.date(y), h.date(y + 1)]) {
      const days = daysBetween(today, d);
      if (days >= 0 && days <= within) out.push({ key: h.key, name: h.name, date: d, days, match: h.match });
    }
  }
  return out;
}

// ─── Websites ──────────────────────────────────────────────────────────────

export type SiteResult = { ok: boolean; status: number | null; ms: number | null; error?: string | null };

/** Down for an alert: two failed checks in a row (one blip is noise) */
export function siteDown(recent: readonly SiteResult[]): boolean {
  return recent.length >= 2 && !recent[0].ok && !recent[1].ok;
}

/** A page's content problems, read from its HTML (the weekly check): an error page, a near-empty page, no title */
export function pageProblems(html: string, status: number): string[] {
  const out: string[] = [];
  const h = String(html ?? "");
  if (status >= 400) out.push(`answers ${status}`);
  const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (/error establishing a database connection|briefly unavailable for scheduled maintenance|there has been a critical error on this website|this site can.?t be reached|account suspended|domain (?:has )?expired|index of \//i.test(text)) out.push("shows an error or maintenance page");
  if (!/<title>[^<]{2,}<\/title>/i.test(h)) out.push("has no page title");
  if (text.length < 200 && status < 400) out.push("is nearly empty");
  if (/<img\b/i.test(h) === false && text.length < 600 && status < 400) out.push("has no images");
  return out;
}

// ─── Tracking ──────────────────────────────────────────────────────────────

const TRACKING_OK = /\b(tracking (?:is |looks )?(?:clean|healthy|solid|fine)|no tracking issues?|verified and firing|fires correctly)\b/i;
const TRACKING_BAD = /\b(not (?:verified|firing|tracked|passing|deduplicat\w*)|isn'?t|aren'?t|doesn'?t|no (?:server|conversions api|capi|utm|events?|purchase)|missing|broken|stopped|last fired|double[- ]?count\w*|mismatch\w*|under[- ]?match\w*|under[- ]?report\w*|over[- ]?report\w*|inflat\w*|duplicat\w*|off\b|\$1 default|default value|not trusted|reconcile|discrepan\w*|0 (?:viewcontent|initiatecheckout|purchase|events?))/i;

/** The tracking problems an audit found (its tracking section), leaving out lines that say tracking is fine */
export function trackingProblems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((x) => String(typeof x === "string" ? x : ((x as { text?: string; issue?: string })?.text ?? (x as { issue?: string })?.issue ?? ""))).filter((t) => t.trim() && !TRACKING_OK.test(t) && TRACKING_BAD.test(t));
}

/**
 * Platform conversions against the site's own orders (the store's count, read through Klaviyo), over the same days.
 * A platform claiming 30%+ more than the store saw is over-reporting; two platforms that each look fine but add up to
 * 30%+ more are counting the same orders twice; a platform seeing under a third of a busy store is under-tracking.
 */
export function conversionGap(i: { meta: number; google: number; store: number }): { kind: "over" | "double" | "under"; text: string } | null {
  const { meta, google, store } = i;
  if (store < 5 && meta + google < 5) return null;
  const over = (n: number) => n >= 5 && n > store * 1.3 + 2;
  if (over(meta)) return { kind: "over", text: `Meta claims ${Math.round(meta)} purchases, the store saw ${Math.round(store)} orders` };
  if (over(google)) return { kind: "over", text: `Google claims ${Math.round(google)} purchases, the store saw ${Math.round(store)} orders` };
  if (meta > 0 && google > 0 && over(meta + google)) return { kind: "double", text: `Meta (${Math.round(meta)}) and Google (${Math.round(google)}) add up to ${Math.round(meta + google)}, the store saw ${Math.round(store)}: they're counting the same orders` };
  if (store >= 15 && meta + google > 0 && meta + google < store / 3) return { kind: "under", text: `The store saw ${Math.round(store)} orders, the ad platforms see ${Math.round(meta + google)}: the pixel or Conversions API is missing most of them` };
  return null;
}

/**
 * Conversion rate dropping abnormally: the last 3 days' results per link click under half of the 28 days before, with
 * enough clicks on both sides to mean something (200 before, 60 now).
 */
export function cvrDrop(i: { recentClicks: number; recentResults: number; baseClicks: number; baseResults: number }): { recent: number; base: number } | null {
  if (i.baseClicks < 200 || i.recentClicks < 60 || i.baseResults < 5) return null;
  const base = i.baseResults / i.baseClicks;
  const recent = i.recentResults / i.recentClicks;
  return recent < base * 0.5 ? { recent, base } : null;
}
