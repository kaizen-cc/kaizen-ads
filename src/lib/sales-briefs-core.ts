// Sales call briefs: the plain rules (no server imports; tested in tests/sales-briefs.test.ts). Which calendar
// meetings are sales calls, who runs each one, when its brief is due, when it changed, and how its item reads.
// The classification follows the calls run's order (docs/kyle-scheduled-runs.md, step 1): a current client first
// (their contacts' emails or company domain, or their name in the title), then internal-only meetings, then vendors,
// platform reps, candidates and partners; everything else external is a sales call. A Calendly "Discovery Call"
// confirms one but never decides alone: clients book that link too.

export type BriefEvent = {
  id: string;
  iCalUID?: string | null;
  summary?: string | null;
  description?: string | null;
  status?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  organizer?: { email?: string | null; displayName?: string | null; self?: boolean | null } | null;
  attendees?: { email?: string | null; displayName?: string | null; self?: boolean | null; responseStatus?: string | null; resource?: boolean | null }[] | null;
  htmlLink?: string | null;
  created?: string | null;
  updated?: string | null;
};
export type ClientRef = { id: string; name: string; emails: readonly string[]; domains: readonly string[] };
export type Kind = "sales" | "client" | "internal" | "other" | "skip";

export const OWN_DOMAIN = "kaizenmarketing.agency";
export const BRIEF_LEAD_HOURS = 18;
export const GENERIC_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|icloud|aol|live|msn|me|mac|proton(mail)?|pm|gmx|zoho|comcast|att|verizon|sbcglobal)\./;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** The meeting's identity across everyone's calendars (the same meeting has one iCalUID) */
export const eventKey = (ev: BriefEvent) => (ev.iCalUID || ev.id || "").trim();

export const startOf = (ev: BriefEvent) => ev.start?.dateTime ?? null;

/** The people on it from outside Kaizen (not rooms, not Kaizen addresses) */
export function externalsOf(ev: BriefEvent, ownDomain = OWN_DOMAIN): { email: string; name: string | null }[] {
  const out = new Map<string, string | null>();
  for (const a of [...(ev.attendees ?? []), ...(ev.organizer ? [ev.organizer] : [])]) {
    const e = lower(a.email);
    if (!e || !e.includes("@") || e.endsWith(`@${ownDomain}`) || e.endsWith("resource.calendar.google.com") || e.endsWith("group.calendar.google.com") || (a as { resource?: boolean | null }).resource) continue;
    if (/^(no-?reply|notifications?|calendar|calendly)@/.test(e) || e.endsWith("@calendly.com")) continue;
    if (!out.has(e)) out.set(e, (a.displayName ?? null) || null);
  }
  return [...out].map(([email, name]) => ({ email, name }));
}

/** Kaizen people on it (organizer and attendees), lower-case emails */
export function kaizenOf(ev: BriefEvent, ownDomain = OWN_DOMAIN): string[] {
  return [...new Set([ev.organizer?.email, ...(ev.attendees ?? []).map((a) => a.email)].map(lower).filter((e) => e.endsWith(`@${ownDomain}`)))];
}

const VENDOR = /\b(?:meta|facebook|google|tiktok|klaviyo|shopify|hubspot|gohighlevel|ghl|linkedin|snap(?:chat)?|pinterest|amazon)\s+(?:rep|team|partner(?:ship)?s?|account manager|support|onboarding)\b|\b(?:interview|candidate|recruit\w*|hiring|applicant|accountant|bookkeep\w*|cpa review|payroll|legal|lawyer|attorney|insurance|vendor|podcast|referral partner|partnership call|investor|bank(?:ing)?|1:1|one on one|internal|standup|stand-up|all hands|team meeting|sync)\b/i;
const SALES_HINT = /\b(?:discovery|intro(?:ductory)?|consult(?:ation)?|strategy session|free audit|marketing audit|growth call|sales call|demo|kaizen marketing|kaizen)\b/i;

/** Which current client a meeting is with (their contact's email or company domain, else their name in the title) */
export function clientOf(ev: BriefEvent, clients: readonly ClientRef[], ownDomain = OWN_DOMAIN): ClientRef | null {
  const guests = externalsOf(ev, ownDomain).map((g) => g.email);
  for (const c of clients) {
    if (guests.some((g) => c.emails.includes(g))) return c;
    if (guests.some((g) => { const d = g.split("@")[1] ?? ""; return Boolean(d) && !GENERIC_MAIL.test(`${d}.`) && c.domains.includes(d); })) return c;
  }
  const title = fold(String(ev.summary ?? ""));
  const desc = fold(String(ev.description ?? "")).slice(0, 4000);
  const byLength = [...clients].filter((c) => fold(c.name).length >= 4).sort((a, b) => b.name.length - a.name.length);
  const named = (text: string) => byLength.find((c) => new RegExp(`(^|[^a-z0-9])${fold(c.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text)) ?? null;
  // The title names the client; a Calendly booking's answers naming the company count too ("Company: Crust Pizza")
  return named(title) ?? (/\b(?:company|business|brand)(?: name)?\s*[:?]/.test(desc) ? named(desc) : null);
}

/** What kind of meeting it is, and why (the calls run's order) */
export function classifyEvent(ev: BriefEvent, clients: readonly ClientRef[], ownDomain = OWN_DOMAIN): { kind: Kind; why: string; client?: ClientRef } {
  if (lower(ev.status) === "cancelled") return { kind: "skip", why: "cancelled" };
  if (!ev.start?.dateTime) return { kind: "skip", why: "all-day" };
  const me = (ev.attendees ?? []).find((a) => a.self);
  if (me && lower(me.responseStatus) === "declined") return { kind: "skip", why: "declined" };
  const ext = externalsOf(ev, ownDomain);
  const client = clientOf(ev, clients, ownDomain);
  if (client) return { kind: "client", why: `client: ${client.name}`, client };
  if (!ext.length) return { kind: "internal", why: "nobody outside Kaizen" };
  const title = String(ev.summary ?? "");
  if (VENDOR.test(title) && !SALES_HINT.test(title)) return { kind: "other", why: "vendor, rep, candidate or partner" };
  return { kind: "sales", why: SALES_HINT.test(`${title} ${String(ev.description ?? "").slice(0, 300)}`) ? "external, booked as a sales call" : "external, not a client" };
}

/** The brief is due 18 hours before the call; booked later than that, as soon as it's seen. Never once it's started. */
export function briefDue(startIso: string, now: Date = new Date()): boolean {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || start <= now.getTime()) return false;
  return start - now.getTime() <= BRIEF_LEAD_HOURS * 3_600_000;
}

/** A fingerprint of what matters in the event: a change makes the brief refresh */
export function eventHash(ev: BriefEvent): string {
  const people = [...(ev.attendees ?? []).map((a) => lower(a.email))].filter(Boolean).sort().join(",");
  const s = [startOf(ev) ?? "", ev.end?.dateTime ?? "", String(ev.summary ?? "").trim(), people, String(ev.description ?? "").replace(/\s+/g, " ").trim().slice(0, 3000)].join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Who runs the call: the organizer when they're on the team; else the Kaizen attendee who works sales (an exec or a
 * lead); else whoever's calendar it was found on.
 */
export function runnerOf(ev: BriefEvent, team: readonly { id: string; email: string; sells: boolean }[], foundOn: string): string | null {
  const byEmail = new Map(team.map((p) => [p.email.toLowerCase(), p]));
  const org = byEmail.get(lower(ev.organizer?.email));
  if (org) return org.id;
  const kaizen = kaizenOf(ev).map((e) => byEmail.get(e)).filter((p): p is (typeof team)[number] => Boolean(p));
  return (kaizen.find((p) => p.sells) ?? byEmail.get(foundOn.toLowerCase()) ?? kaizen[0] ?? null)?.id ?? null;
}

/** The event's description as plain text (Calendly and Google add HTML) */
export function plainDescription(d: string | null | undefined): string {
  return String(d ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A Calendly booking's questions and answers ("Question:\nAnswer" or "Question: Answer"), as pairs */
export function bookingAnswers(description: string | null | undefined): { q: string; a: string }[] {
  const text = plainDescription(description);
  const out: { q: string; a: string }[] = [];
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || /^(event name|location|invitee time zone|need to make changes|cancel|reschedule|powered by|https?:)/i.test(l)) continue;
    const inline = /^(.{3,140}?[?:])\s+(\S.{0,1200})$/.exec(l);
    if (inline && !/^https?:/i.test(inline[1])) {
      out.push({ q: inline[1].replace(/[:]$/, "").trim(), a: inline[2].trim() });
      continue;
    }
    // A question line ("…?" or "…:"), or Calendly's own prompt ("Please share anything that will help prepare for our meeting.")
    const asks = /[?:]$/.test(l) || /^(?:please (?:share|tell|let us know|describe|list)|tell us|share (?:anything|a bit)|anything else)\b.*\.$/i.test(l);
    if (asks && l.length <= 160 && lines[i + 1] && !/[?:]$/.test(lines[i + 1])) {
      out.push({ q: l.replace(/[:]$/, "").trim(), a: lines[i + 1] });
      i++;
    }
  }
  return out.slice(0, 20);
}

/** A website from the booking answers or the guests' company domain */
export function siteOf(ev: BriefEvent): string | null {
  const text = plainDescription(ev.description);
  const url = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/[^\s]*)?/gi;
  for (const m of text.matchAll(url)) {
    const d = m[1].toLowerCase();
    if (/(calendly|google|zoom|meet|teams|microsoft|kaizenmarketing|gmail|facebook\.com\/events)/.test(d)) continue;
    return `https://${d}`;
  }
  const dom = externalsOf(ev).map((g) => g.email.split("@")[1]).find((d) => d && !GENERIC_MAIL.test(`${d}.`));
  return dom ? `https://${dom}` : null;
}

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** The business's name: the booking's company answer, else from the event title, else the company domain, else the guest */
export function businessOf(ev: BriefEvent): string {
  const a = bookingAnswers(ev.description).find((x) => /\b(company|business|brand|organi[sz]ation)\b/i.test(x.q) && !/website|url|site/i.test(x.q));
  if (a && a.a.length <= 80) return a.a.replace(/[.]+$/, "").trim();
  const title = String(ev.summary ?? "");
  // "Discovery Call: Jane Smith (Glow Med Spa)", "Glow Med Spa <> Kaizen", "Kaizen x Glow Med Spa"
  const paren = /\(([^)]{3,60})\)/.exec(title)?.[1];
  if (paren && !/\b(?:kaizen|zoom|google meet)\b/i.test(paren)) return paren.trim();
  const pair = /^(.{3,60}?)\s*(?:<>|\bx\b|\/|\+|&)\s*(.{3,60})$/i.exec(title);
  if (pair) {
    const other = /kaizen/i.test(pair[1]) ? pair[2] : /kaizen/i.test(pair[2]) ? pair[1] : null;
    if (other) return other.replace(/\b(?:call|meeting|intro|discovery)\b/gi, "").trim() || other.trim();
  }
  const dom = externalsOf(ev).map((g) => g.email.split("@")[1]).find((d) => d && !GENERIC_MAIL.test(`${d}.`));
  if (dom) return titleCase(dom.split(".").slice(0, -1).join(" "));
  const guest = externalsOf(ev)[0];
  return guest?.name || guest?.email.split("@")[0] || String(ev.summary ?? "A prospect").slice(0, 60);
}

/** "tomorrow 10am", "today 3:30pm", "Thu 9am" (New York) */
export function whenLabel(startIso: string, now: Date = new Date()): string {
  const d = new Date(startIso);
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const label = day(d) === day(now) ? "today" : day(d) === day(tomorrow) ? "tomorrow" : d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return `${label} ${time}`;
}

/** The Needs me item's title */
export const briefTitle = (business: string, startIso: string, now: Date = new Date()) => `Sales call with ${business} ${whenLabel(startIso, now)}: brief ready`;

export type CallBrief = {
  who: string;
  they_want: string;
  booking: { q: string; a: string }[];
  prior_contact: string;
  fit: { score: number | null; why: string };
  services: { service: string; why: string; price: string }[];
  objections: { objection: string; answer: string }[];
  discovery_questions: string[];
  proof: string[];
  next_step: string;
  watch_outs: string[];
  pitch_ideas: string[];
  in_motion: string | null;
  /** The prospect was archived before this call was booked: why and when */
  archived: string | null;
};

const s = (v: unknown, n = 1500) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v: unknown, n = 8, len = 500) => (Array.isArray(v) ? v.map((x) => s(x, len)).filter(Boolean).slice(0, n) : []);

/** A brief as the model wrote it, made safe to keep and show */
export function cleanCallBrief(raw: unknown, extra: { booking?: { q: string; a: string }[]; in_motion?: string | null; archived?: string | null } = {}): CallBrief {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fit = (r.fit ?? {}) as Record<string, unknown>;
  const n = Number(fit.score);
  return {
    who: s(r.who),
    they_want: s(r.they_want),
    booking: extra.booking ?? (Array.isArray(r.booking) ? (r.booking as { q: string; a: string }[]).slice(0, 20) : []),
    prior_contact: s(r.prior_contact, 1200),
    fit: { score: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null, why: s(fit.why, 800) },
    services: (Array.isArray(r.services) ? r.services : []).slice(0, 6).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { service: s(o.service, 120), why: s(o.why, 400), price: s(o.price, 120) };
    }).filter((x) => x.service),
    objections: (Array.isArray(r.objections) ? r.objections : []).slice(0, 6).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { objection: s(o.objection, 300), answer: s(o.answer, 600) };
    }).filter((x) => x.objection),
    discovery_questions: list(r.discovery_questions, 5, 300),
    proof: list(r.proof, 5),
    next_step: s(r.next_step, 600),
    watch_outs: list(r.watch_outs, 5, 300),
    pitch_ideas: list(r.pitch_ideas, 10, 500),
    in_motion: extra.in_motion ?? (r.in_motion ? s(r.in_motion, 300) : null),
    archived: extra.archived ?? (r.archived ? s(r.archived, 400) : null),
  };
}

/** Lines the Sales agent saves onto a brief from a conversation (more talking points, pitch ideas…), deduplicated */
export const BRIEF_SECTIONS = ["pitch_ideas", "discovery_questions", "watch_outs", "proof"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];
export function addToBrief(b: CallBrief, section: BriefSection, lines: readonly string[]): CallBrief {
  const have = new Set(b[section].map((x) => x.toLowerCase()));
  const add = lines.map((x) => s(x, 500)).filter((x) => x && !have.has(x.toLowerCase()));
  return { ...b, [section]: [...b[section], ...add].slice(0, section === "pitch_ideas" ? 20 : 10) };
}

/** The brief as text (the assistant reads it out; the Sales agent gets it as context) */
export function callBriefText(business: string, when: string, b: CallBrief): string {
  const out = [`Sales call with ${business}, ${when}.`, b.archived && `Heads-up: ${b.archived}`, b.who && `Who they are: ${b.who}`, b.they_want && `What they said they want: ${b.they_want}`];
  if (b.booking.length) out.push(`Booking answers:\n${b.booking.map((x) => `- ${x.q}: ${x.a}`).join("\n")}`);
  if (b.prior_contact) out.push(`Prior contact: ${b.prior_contact}`);
  if (b.fit.why) out.push(`Fit${b.fit.score != null ? ` ${b.fit.score}/100` : ""}: ${b.fit.why}`);
  if (b.services.length) out.push(`Services that match:\n${b.services.map((x) => `- ${x.service}${x.price ? ` (${x.price})` : ""}: ${x.why}`).join("\n")}`);
  if (b.objections.length) out.push(`Likely objections:\n${b.objections.map((x) => `- "${x.objection}" → ${x.answer}`).join("\n")}`);
  if (b.discovery_questions.length) out.push(`Discovery questions:\n${b.discovery_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  if (b.proof.length) out.push(`Proof (internal: by industry, never by name):\n${b.proof.map((p) => `- ${p}`).join("\n")}`);
  if (b.next_step) out.push(`Suggested next step: ${b.next_step}`);
  if (b.pitch_ideas.length) out.push(`Pitch ideas:\n${b.pitch_ideas.map((p) => `- ${p}`).join("\n")}`);
  if (b.watch_outs.length) out.push(`Watch outs:\n${b.watch_outs.map((p) => `- ${p}`).join("\n")}`);
  if (b.in_motion) out.push(`Already in motion: ${b.in_motion}`);
  return out.filter(Boolean).join("\n\n");
}
