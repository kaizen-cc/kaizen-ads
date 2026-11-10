import { forClient } from "@/lib/reports/white-label";

// Client notifications and chasing on creative waiting for the client's review: the plain parts (no server code), shared
// by the runner, the client page and the tests.
//
// Business time is the business clock's (supabase/migrations/20261013000003_business_clock.sql): Monday to Friday,
// 8am to 6pm New York, minus holidays. "24h" and "48h" are 1 and 2 business days from the moment the client was told,
// clamped into business hours first: told Friday at 7pm, the clock starts Monday at 8am, so the first reminder is
// Tuesday at 8am and the second Wednesday at 8am. Told Friday at 5pm: Monday at 5pm, then Tuesday at 5pm.

export const TZ = "America/New_York";
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 18;
/** Minutes the newest item waits before the post goes, so a batch moving to the client together lands in one post */
export const SETTLE_MINUTES = 20;

export type NoticeKind = "ready" | "remind_24" | "remind_48" | "escalated" | "auto_approved";
export const AUTO_APPROVED_BY = "Approved automatically after 48 business hours (client opted in)";

// ─── Business time ──────────────────────────────────────────────────────────

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" });

/** A moment as New York wall time */
export function nyParts(d: Date) {
  const parts = fmt.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { y: Number(g("year")), m: Number(g("month")), d: Number(g("day")), h: Number(g("hour")) % 24, min: Number(g("minute")), s: Number(g("second")), ms: d.getUTCMilliseconds(), weekday: g("weekday") };
}

/** "2026-11-10": the New York calendar day of a moment */
export function nyDay(d: Date) {
  const p = nyParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** New York wall time to the real moment (summer and winter time both) */
export function nyWall(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min, s, ms);
  const offsetAt = (t: number) => {
    const p = nyParts(new Date(t));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s, new Date(t).getUTCMilliseconds()) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

type Day = { y: number; m: number; d: number };
const dayKey = (x: Day) => `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
const nextDay = (x: Day): Day => {
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekdayOf = (x: Day) => new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();

/** Monday to Friday and not a holiday ("YYYY-MM-DD" days) */
export function isBusinessDay(x: Day, holidays: ReadonlySet<string> = new Set()) {
  const wd = weekdayOf(x);
  return wd !== 0 && wd !== 6 && !holidays.has(dayKey(x));
}

/** Inside business hours right now */
export function isBusinessTime(at: Date, holidays: ReadonlySet<string> = new Set()) {
  const p = nyParts(at);
  return isBusinessDay(p, holidays) && p.h >= OPEN_HOUR && p.h < CLOSE_HOUR;
}

/** The first moment at or after this one inside business hours */
export function businessClamp(at: Date, holidays: ReadonlySet<string> = new Set()) {
  const p = nyParts(at);
  if (isBusinessDay(p, holidays) && p.h >= OPEN_HOUR && p.h < CLOSE_HOUR) return at;
  if (isBusinessDay(p, holidays) && p.h < OPEN_HOUR) return nyWall(p.y, p.m, p.d, OPEN_HOUR);
  let x: Day = nextDay(p);
  for (let i = 0; i < 60 && !isBusinessDay(x, holidays); i++) x = nextDay(x);
  return nyWall(x.y, x.m, x.d, OPEN_HOUR);
}

/** A number of business days after a moment (clamped into business hours first), at the same time of day */
export function addBusinessDays(at: Date, days: number, holidays: ReadonlySet<string> = new Set()) {
  const start = businessClamp(at, holidays);
  const p = nyParts(start);
  let x: Day = p;
  for (let left = Math.max(0, days); left > 0; ) {
    x = nextDay(x);
    if (isBusinessDay(x, holidays)) left--;
  }
  return nyWall(x.y, x.m, x.d, p.h, p.min, p.s, p.ms);
}

/** When the first (24 business hours) and second (48) reminders fall, from the moment the client was told */
export const dueTimes = (told: Date, holidays: ReadonlySet<string> = new Set()) => ({ remind24: addBusinessDays(told, 1, holidays), remind48: addBusinessDays(told, 2, holidays) });

// ─── The plan for one client ────────────────────────────────────────────────

/** A ticket waiting on the client: this round of review began at roundAt */
export type Waiting = { requestId: string; number: number; title: string; roundAt: string; pieces: number };
/** What's been logged already: key → when (and whether it reached them) */
export type Logged = Map<string, { at: string; status: string }>;

/** Same round, same key, however the database wrote the time */
export const roundOf = (iso: string) => new Date(iso).toISOString();
export const noticeKey = (kind: NoticeKind, requestId: string, roundAt: string) => `${kind}:${requestId}:${roundOf(roundAt)}`;

export type Plan = {
  /** Announce these now in one post */
  announce: Waiting[];
  remind24: Waiting[];
  remind48: Waiting[];
  autoApprove: Waiting[];
  /** Into customer success's "Waiting on the client" queue (with a team notification) */
  escalate: Waiting[];
};

/**
 * What to do now for one client's items with the client. Switches: `reach` is every client-facing switch together (the
 * portal live, the outreach hold lifted, the client's own Client notifications); off, only the team side runs (the
 * customer success queue at 48 business hours from when it went to them). Auto-approval is only for opted-in clients,
 * and only for what the client was actually told about.
 */
export function planClient(o: { items: Waiting[]; logged: Logged; reach: boolean; optedIn: boolean; now: Date; holidays?: ReadonlySet<string> }): Plan {
  const holidays = o.holidays ?? new Set<string>();
  const out: Plan = { announce: [], remind24: [], remind48: [], autoApprove: [], escalate: [] };
  const has = (kind: NoticeKind, w: Waiting) => o.logged.has(noticeKey(kind, w.requestId, w.roundAt));
  const told = (w: Waiting) => {
    const r = o.logged.get(noticeKey("ready", w.requestId, w.roundAt));
    return r && r.status === "sent" ? new Date(r.at) : null;
  };
  const open = isBusinessTime(o.now, holidays);

  // The post: what's new, once the batch has settled, at most once a day, in business hours
  if (o.reach && open) {
    const fresh = o.items.filter((w) => !has("ready", w));
    const postedToday = postedOn(o.logged, nyDay(o.now));
    const newest = Math.max(0, ...fresh.map((w) => Date.parse(w.roundAt)));
    if (fresh.length && !postedToday && o.now.getTime() - newest >= SETTLE_MINUTES * 60_000) out.announce.push(...fresh);
  }

  for (const w of o.items) {
    const t = told(w);
    if (t && o.reach) {
      const due = dueTimes(t, holidays);
      if (o.now >= due.remind48) {
        if (o.optedIn) {
          if (!has("auto_approved", w)) out.autoApprove.push(w);
          continue;
        }
        if (!has("remind_48", w) && open) out.remind48.push(w);
      } else if (o.now >= due.remind24 && !has("remind_24", w) && open) out.remind24.push(w);
    }
    // Customer success: 48 business hours from when they were told (or, not told, from when it went to them)
    const since = t ?? new Date(w.roundAt);
    if (o.now >= addBusinessDays(since, 2, holidays) && !has("escalated", w) && !(t && o.reach && o.optedIn)) out.escalate.push(w);
  }
  return out;
}

/** Whether a client's ready post already went out today (New York), so a second batch waits for tomorrow */
export function postedOn(logged: Logged, day: string) {
  return [...logged.entries()].some(([k, v]) => k.startsWith("ready:") && v.status === "sent" && nyDay(new Date(v.at)) === day);
}

// ─── Who chases ─────────────────────────────────────────────────────────────

/** The customer success seat on the client (client_assignments role coordinator), primary first; none, the execs */
export function chasers(seats: readonly { profile_id: string; role: string; is_primary?: boolean | null }[], execs: readonly string[]) {
  const cs = [...seats]
    .filter((s) => s.role === "coordinator")
    .sort((a, b) => Number(b.is_primary !== false) - Number(a.is_primary !== false))
    .map((s) => s.profile_id);
  const list = cs.length ? cs : [...execs];
  return [...new Set(list.filter(Boolean))];
}

// ─── What the client reads ──────────────────────────────────────────────────

export type ClientMessage = { slack: string; subject: string; title: string; highlight?: string; lines: string[]; cta?: { label: string; url: string } };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The client's Slack post and email for each moment, short and friendly, with the portal link. A white label client's
 * never names the agency or links to its site: no link, and the scrub as the backstop.
 */
export function clientMessage(kind: "ready" | "remind_24" | "remind_48" | "auto_approved", o: { count: number; url: string; whiteLabel?: boolean }): ClientMessage {
  const n = Math.max(1, o.count);
  const creatives = `${n} ${plural(n, "creative", "creatives")}`;
  const isAre = plural(n, "is", "are");
  const wl = Boolean(o.whiteLabel);
  const link = (label: string) => (wl ? "" : ` <${o.url}|${label}>`);
  const cta = wl ? undefined : { label: kind === "auto_approved" ? "See them →" : "Review them →", url: o.url };
  let m: ClientMessage;
  if (kind === "ready")
    m = {
      slack: `Hi team! ${n} new ${plural(n, "creative is", "creatives are")} ready for your review.${link("Review them here")}${wl ? " You'll find them in your review portal." : ""} Swipe right to approve, left to ask for changes.`,
      subject: `${n} new ${plural(n, "creative is", "creatives are")} ready for your review`,
      title: `${n} new ${plural(n, "creative is", "creatives are")} ready for your review`,
      highlight: "your review",
      lines: ["Fresh work is in for you. Take a look whenever you have a few minutes.", "Swipe right to approve, or left to tell us what to change (pin a note right on the design)."],
      cta,
    };
  else if (kind === "remind_24")
    m = {
      slack: `Friendly reminder: ${creatives} ${isAre} still waiting for your review.${link("Review them here")}${wl ? " They're in your review portal." : ""} It only takes a few minutes.`,
      subject: `Reminder: ${creatives} waiting for your review`,
      title: `${creatives} ${isAre} waiting on you`,
      highlight: "waiting",
      lines: ["A quick nudge in case this got buried.", `${creatives} ${isAre} ready and waiting for your OK. It only takes a few minutes.`],
      cta,
    };
  else if (kind === "remind_48")
    m = {
      slack: `One more nudge: ${creatives} ${plural(n, "has", "have")} been waiting two business days for your review.${link("Review them here")}${wl ? " They're in your review portal." : ""} Questions? Reply here and we'll help.`,
      subject: `Still waiting: ${creatives} need your review`,
      title: `${creatives} still ${plural(n, "needs", "need")} your review`,
      highlight: "your review",
      lines: [`${creatives} ${plural(n, "has", "have")} been waiting two business days for your OK.`, "Approve what you like, or tell us what to change. If anything's unclear, just reply and we'll help."],
      cta,
    };
  else
    m = {
      slack: `As you asked, ${creatives} that waited two business days ${plural(n, "was", "were")} approved automatically and ${plural(n, "is", "are")} moving on to launch.${link("See them here")} Want a change anyway? Reply here and we'll take care of it.`,
      subject: `${creatives} approved automatically`,
      title: `${creatives} approved automatically`,
      highlight: "automatically",
      lines: [`As you asked, ${creatives} that waited two business days ${plural(n, "was", "were")} approved automatically and ${plural(n, "is", "are")} moving on to launch.`, "Want a change anyway? Just reply and we'll take care of it."],
      cta,
    };
  if (!wl) return m;
  return { ...m, slack: forClient(m.slack, true), subject: forClient(m.subject, true), title: forClient(m.title, true), lines: m.lines.map((l) => forClient(l, true)), cta: undefined };
}

/** The team's line on the ticket's timeline for each notice */
export function timelineLine(kind: NoticeKind, channels: string[]) {
  const where = channels.filter((c) => c !== "team").map((c) => (c === "slack" ? "their Slack channel" : "email")).join(" and ");
  if (kind === "ready") return `told the client it's ready for review${where ? ` (${where})` : ""}`;
  if (kind === "remind_24") return `reminded the client after 24 business hours${where ? ` (${where})` : ""}`;
  if (kind === "remind_48") return `reminded the client again after 48 business hours${where ? ` (${where})` : ""}`;
  if (kind === "escalated") return "moved it to customer success: waiting on the client 48 business hours";
  return "approved it automatically after 48 business hours (client opted in)";
}
