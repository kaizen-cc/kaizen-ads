import { servicesOf, type ServiceSlug } from "@/lib/services";

// Account watch, the pure part (no database): which service a Stripe line bills, whether a billed or listed service has
// gone quiet, when an account is neglected or touched too much, spend that jumps or stops, creative behind pace, and
// whose name is behind a change in the ad platforms. The daily run (./run.ts) reads the data and acts on these.

export type WatchLine = "meta" | "google" | "tiktok" | "creative" | "email" | "social" | "web" | "crm";

export const LINE_SERVICE: Record<WatchLine, ServiceSlug> = {
  meta: "facebook-ads",
  google: "google-ads",
  tiktok: "tiktok-ads",
  creative: "creative",
  email: "email-marketing",
  social: "social-media",
  web: "web-design",
  crm: "crm",
};
export const SERVICE_LINE = Object.fromEntries(Object.entries(LINE_SERVICE).map(([l, s]) => [s, l])) as Record<ServiceSlug, WatchLine>;
export const LINE_LABEL: Record<WatchLine, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", creative: "Creative", email: "Email", social: "Social", web: "Web", crm: "CRM" };

/** The lines with activity we can see (spend, deliveries, sends, posts). Web and CRM have none synced, so never flagged idle. */
export const WATCHED_LINES: readonly WatchLine[] = ["meta", "google", "tiktok", "creative", "email", "social"];

/** Days without activity before a billed or listed line is flagged */
export const IDLE_DAYS: Record<WatchLine, number> = { meta: 7, google: 7, tiktok: 7, creative: 7, email: 7, social: 7, web: 7, crm: 7 };

/** What counts as activity on each line, for the alert's words */
export const ACTIVITY_WORD: Record<WatchLine, string> = { meta: "spend", google: "spend", tiktok: "spend", creative: "creative delivered", email: "campaign sent", social: "post", web: "activity", crm: "activity" };

// ─── Stripe lines → services ────────────────────────────────────────────────

/** "1 × Google Advertising (at $875.00 / month)" → "Google Advertising" */
export const lineName = (d: string) => d.replace(/^\s*\d+\s*[×x]\s*/i, "").replace(/\s*\(at .*$/i, "").trim();

/**
 * The service a Stripe invoice line bills, as Kaizen Track keeps it, or null (a credit for unused time, SEO, anything
 * we don't run as a line). A content package is organic social, not the paid creative package; SMS is the email line.
 */
export function serviceOfLine(desc: string | null | undefined): ServiceSlug | null {
  const d = lineName(desc ?? "").toLowerCase();
  if (!d || /^(unused|remaining) time/.test(d)) return null;
  if (/creative package/.test(d)) return "creative";
  if (/content creation|content package|organic|social media/.test(d)) return "social-media";
  if (/tik ?tok/.test(d)) return "tiktok-ads";
  if (/google|ppc|youtube|search ads/.test(d)) return "google-ads";
  if (/\bmeta\b|facebook|instagram/.test(d)) return "facebook-ads";
  if (/e-?mail|\bsms\b|klaviyo/.test(d)) return "email-marketing";
  if (/website|web design|web development|landing page/.test(d)) return "web-design";
  if (/\bcrm\b|gohighlevel|hubspot/.test(d)) return "crm";
  return null;
}

export type Bill = { at: string; lines?: string | null; line_items?: { a?: number | null; d?: string | null }[] | null; memo?: string | null; amount?: number | null; refunded?: number | boolean | null; ignored?: boolean | null };
export type Billed = Partial<Record<ServiceSlug, { last: string; amount: number }>>;

/** Each line of a bill: the structured items when Track has them, else the "a · b" summary */
function itemsOf(b: Bill): { d: string; a: number | null }[] {
  if (Array.isArray(b.line_items) && b.line_items.length) return b.line_items.map((x) => ({ d: String(x?.d ?? ""), a: x?.a == null ? null : Number(x.a) }));
  return String(b.lines ?? "")
    .split(" · ")
    .map((d) => ({ d, a: null }));
}

/**
 * What a client is billed for: every service on a bill in the last `days` (paid and not refunded or set aside in Track,
 * or still open), with the latest day it was billed and that line's amount. A credit line (negative) never counts.
 */
export function billedServices(bills: readonly Bill[], now = new Date(), days = 45): Billed {
  const since = now.getTime() - days * 86_400_000;
  const out: Billed = {};
  for (const b of bills) {
    if (b.ignored) continue;
    if (typeof b.refunded === "boolean" ? b.refunded : b.refunded != null && b.amount != null && Number(b.refunded) >= Number(b.amount) && Number(b.amount) > 0) continue;
    const at = Date.parse(b.at);
    if (!Number.isFinite(at) || at < since) continue;
    const found: { s: ServiceSlug; a: number }[] = [];
    for (const it of itemsOf(b)) {
      if (it.a != null && it.a <= 0) continue;
      const s = serviceOfLine(it.d);
      if (s) found.push({ s, a: it.a ?? 0 });
    }
    // A creative package named only in the memo (some invoices are written that way)
    if (/creative package/i.test(b.memo ?? "") && !found.some((f) => f.s === "creative")) found.push({ s: "creative", a: 0 });
    const iso = new Date(at).toISOString();
    for (const f of found) {
      const cur = out[f.s];
      if (!cur || cur.last < iso) out[f.s] = { last: iso, amount: f.a };
    }
  }
  return out;
}

// ─── Billed but idle ────────────────────────────────────────────────────────

const DAY = 86_400_000;
/** Whole days from one day (YYYY-MM-DD or ISO) to another */
export const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / DAY);

export type IdleInput = {
  line: WatchLine;
  /** The last day with activity (YYYY-MM-DD or ISO), null when none on record */
  lastActivity: string | null;
  /** Today, YYYY-MM-DD (New York) */
  today: string;
  /** When the client started with us: a client newer than the window isn't idle yet */
  startedAt?: string | null;
  /** A lead or exec marked the line intentionally paused until this day (YYYY-MM-DD) */
  pausedUntil?: string | null;
  days?: number;
};
export type IdleState = { idle: boolean; paused: boolean; daysIdle: number | null };

/** Whether a billed or listed line has had no activity for the window (7 days), unless it's paused on purpose */
export function idleState(i: IdleInput): IdleState {
  const days = i.days ?? IDLE_DAYS[i.line];
  const paused = Boolean(i.pausedUntil && i.pausedUntil.slice(0, 10) >= i.today);
  const daysIdle = i.lastActivity ? daysBetween(i.lastActivity, i.today) : null;
  if (paused) return { idle: false, paused, daysIdle };
  if (daysIdle == null) {
    // Nothing on record: only once they've been with us longer than the window
    const age = i.startedAt ? daysBetween(i.startedAt, i.today) : Infinity;
    return { idle: age >= days, paused, daysIdle };
  }
  return { idle: daysIdle >= days, paused, daysIdle };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jun 6" for a YYYY-MM-DD or ISO day */
export const shortDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** "Billed for Google, no spend since Jun 6" / "On Email, no campaign sent on record" */
export function idleTitle(line: WatchLine, billed: boolean, lastActivity: string | null) {
  const what = ACTIVITY_WORD[line];
  return `${billed ? "Billed for" : "On"} ${LINE_LABEL[line]}, no ${what} ${lastActivity ? `since ${shortDay(lastActivity)}` : "on record"}`;
}

// ─── Neglected, overtouched, spend ──────────────────────────────────────────

/** Days without a change by our team before a spending account counts as neglected: bigger accounts sooner */
export function neglectDays(spend30: number) {
  if (spend30 >= 30_000) return 3;
  if (spend30 >= 10_000) return 5;
  return 7;
}
/** Then the buyer's head hears too, this many days later */
export const ESCALATE_AFTER = 3;

export type NeglectState = { neglected: boolean; escalate: boolean; days: number | null; threshold: number };

/** A spending account with no change from our team in its window; escalated to the head three days after */
export function neglectState(i: { lastTeamChange: string | null; spend7: number; spend30: number; today: string; since?: string | null }): NeglectState {
  const threshold = neglectDays(i.spend30);
  if (i.spend7 <= 0) return { neglected: false, escalate: false, days: null, threshold };
  // No change on record at all: counted from when we started watching (the history we keep), never from forever
  const from = i.lastTeamChange ?? i.since ?? null;
  if (!from) return { neglected: false, escalate: false, days: null, threshold };
  const days = daysBetween(from, i.today);
  return { neglected: days >= threshold, escalate: days >= threshold + ESCALATE_AFTER, days, threshold };
}

/** Edits that send a Meta ad set or a Google campaign back into learning */
export const LEARNING_RESET = /budget(?! scheduling)|\bbid|targeting|performance goal|optimi[sz]ation|targetroas|targetcpa|amountmicros|bidding|conversion goal/i;

export type Touch = { at: string; what: string; object: string | null };
/**
 * Too many learning-reset edits in a short window: 3 or more on one campaign or ad set within 72 hours, or 12 or more
 * across the account. Returns the busiest object and the count.
 */
export function overtouched(changes: readonly Touch[], now = new Date(), hours = 72): { hit: boolean; count: number; object: string | null; objectCount: number } {
  const since = now.getTime() - hours * 3_600_000;
  const recent = changes.filter((c) => Date.parse(c.at) >= since && LEARNING_RESET.test(c.what));
  const per = new Map<string, number>();
  for (const c of recent) if (c.object) per.set(c.object, (per.get(c.object) ?? 0) + 1);
  const [object, objectCount] = [...per.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { hit: objectCount >= 3 || recent.length >= 12, count: recent.length, object, objectCount };
}

export type SpendDay = { date: string; spend: number };
export type SpendAnomaly = { kind: "spike" | "drop" | "stopped"; day: string; spend: number; average: number } | null;

/**
 * Yesterday's spend against the 14 days before it: more than double (and at least $100 more) is a spike; under a third
 * of a $30+ average is a drop; nothing at all after spending is stopped. Days are summed per date first.
 */
export function spendAnomaly(days: readonly SpendDay[], yesterday: string): SpendAnomaly {
  const by = new Map<string, number>();
  for (const d of days) by.set(d.date, (by.get(d.date) ?? 0) + Number(d.spend || 0));
  const y = by.get(yesterday) ?? 0;
  const base: number[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.parse(`${yesterday}T12:00:00Z`) - i * DAY).toISOString().slice(0, 10);
    base.push(by.get(d) ?? 0);
  }
  const average = base.reduce((a, b) => a + b, 0) / base.length;
  if (average >= 30 && y === 0 && base.slice(0, 3).some((s) => s > 0)) return { kind: "stopped", day: yesterday, spend: 0, average };
  if (y > average * 2 && y - average >= 100) return { kind: "spike", day: yesterday, spend: y, average };
  if (average >= 30 && y > 0 && y < average / 3) return { kind: "drop", day: yesterday, spend: y, average };
  return null;
}

/** Month to date spend on course to beat the month's budget by more than 15% (or past it already) */
export function overspend(i: { mtd: number; budget: number | null; dayOfMonth: number; daysInMonth: number }): { over: boolean; projected: number } {
  if (!i.budget || i.budget <= 0 || i.dayOfMonth < 1) return { over: false, projected: 0 };
  const projected = (i.mtd / i.dayOfMonth) * i.daysInMonth;
  return { over: i.mtd > i.budget * 1.02 || (i.dayOfMonth >= 5 && projected > i.budget * 1.15), projected };
}

// ─── Creative ───────────────────────────────────────────────────────────────

/** Behind pace with a week or less left: under 60% of where the allotment should be by now */
export function creativeBehind(i: { cap: number; used: number; elapsed: number; daysLeft: number }) {
  if (i.cap <= 0 || i.daysLeft > 7 || i.used >= i.cap) return false;
  return i.used < i.cap * i.elapsed * 0.6;
}

/** Beating its KPI by 30% or more: worth a creative sprint. deviation is the 14-day gap to target, positive = worse */
export const beatingWide = (deviation: number | null | undefined) => deviation != null && deviation <= -0.3;

// ─── Names in the ad platforms ──────────────────────────────────────────────

/** "Fábio  Vinícius " → "fabio vinicius": no accents, case, punctuation or extra spaces */
export function normName(s: string | null | undefined) {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type Person = { id: string; full_name: string; display_name?: string | null; email?: string | null; platform_aliases?: string[] | null };

const tokens = (s: string) => normName(s).replace(/@.*$/, "").split(/[\s.]+/).filter(Boolean);

/**
 * The team member behind a change-history name: an alias they set, their full or display name, or their email, ignoring
 * accents and case; else the same first and last name ("Kyle J Barry" is Kyle Barry). Null when it's nobody on the team.
 */
export function matchActor<P extends Person>(who: string | null | undefined, people: readonly P[]): P | null {
  const n = normName(who);
  if (!n) return null;
  for (const p of people) {
    const names = [p.full_name, p.display_name, p.email, ...(p.platform_aliases ?? [])].map(normName).filter(Boolean);
    if (names.includes(n)) return p;
  }
  if (n.includes("@")) return null;
  const t = tokens(n);
  if (t.length < 2) return null;
  const hits = people.filter((p) => {
    const pt = tokens(p.full_name);
    return pt.length >= 2 && pt[0] === t[0] && pt[pt.length - 1] === t[t.length - 1];
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Automated or system actors: never a person to recognize */
export const isAutomated = (who: string | null | undefined) => /commandcenter|automated|\brule\b|^meta$|^google( ads)?$|system|api\b/i.test(who ?? "");

/** Our own domain: anyone with an @kaizenmarketing.agency address is the team, alias or not */
export const isKaizenEmail = (who: string | null | undefined) => /@kaizenmarketing\.agency$/i.test((who ?? "").trim());

// ─── Services vs Stripe ─────────────────────────────────────────────────────

const SERVICE_NAME: Record<ServiceSlug, string> = { "facebook-ads": "Meta Ads", "google-ads": "Google Ads", "tiktok-ads": "TikTok Ads", creative: "Creative", "email-marketing": "Email", "web-design": "Web", "social-media": "Social", crm: "CRM" };

export type Mismatch = {
  kind: "billed_not_listed" | "listed_not_billed" | "package_not_billed" | "creative_no_package" | "no_billing";
  service: ServiceSlug | null;
  text: string;
  /** The one-tap fix in Kaizen OS (Stripe is never changed): add or remove the service here, or clear the package */
  fix: "add" | "remove" | "clear_package" | null;
};

/**
 * Where Kaizen OS and Stripe disagree on what a client buys: billed but not listed, listed but not billed, a creative
 * package shown that isn't billed, creative billed with no package set. Nothing for a client Track hasn't billed-checked.
 */
export function serviceMismatches(c: { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null; billed_services?: Billed | null; billed_synced_at?: string | null; creative_package?: boolean | null }): Mismatch[] {
  if (!c.billed_synced_at) return [];
  const billed = c.billed_services ?? {};
  const listed = servicesOf(c);
  const billedSlugs = Object.keys(billed) as ServiceSlug[];
  const out: Mismatch[] = [];
  if (!billedSlugs.length) {
    if (listed.length || c.creative_package) out.push({ kind: "no_billing", service: null, text: "No Stripe bill in the last 45 days, yet services are listed here", fix: null });
    if (c.creative_package) out.push({ kind: "package_not_billed", service: "creative", text: "Creative package shown, but Stripe bills no creative package", fix: "clear_package" });
    return out;
  }
  for (const s of billedSlugs)
    if (!listed.includes(s)) out.push({ kind: "billed_not_listed", service: s, text: `Billed for ${SERVICE_NAME[s]} in Stripe, not listed here${(c.services_removed ?? []).includes(s) ? " (it was taken off)" : ""}`, fix: "add" });
  for (const s of listed) if (!billed[s] && !(s === "creative" && c.creative_package)) out.push({ kind: "listed_not_billed", service: s, text: `${SERVICE_NAME[s]} listed here, Stripe doesn't bill it`, fix: "remove" });
  if (c.creative_package && !billed.creative) out.push({ kind: "package_not_billed", service: "creative", text: "Creative package shown, but Stripe bills no creative package", fix: "clear_package" });
  if (billed.creative && !c.creative_package) out.push({ kind: "creative_no_package", service: "creative", text: "Stripe bills a creative package, none is set here (set it on the client page)", fix: null });
  return out;
}
