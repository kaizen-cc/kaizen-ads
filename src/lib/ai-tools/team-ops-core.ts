import { googleTools, guideProgress, toolSettled, type Guide, type GuideHas } from "@/lib/onboarding-guide-types";

// The pure parts of the team tools in team-ops.ts (month windows, saving moments, notes that fit a memory row, the
// onboarding checklist and its email, the week's task list, Google Sheet links, a sheet's column summary, and what
// Meta's account states mean). No server or browser APIs, so tests/team-ops.test.ts runs them.

export const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const DAY = 86_400_000;
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ─── Monthly moments ─────────────────────────────────────────────────────────────────────────────────────────────────

export type MonthWindow = { month: string; start: string; end: string; label: string; year: number; startsInDays: number };

/** "2027-02", "February 2027" or "feb 2027" (the next month when none is given) as the days it covers */
export function monthWindow(input: unknown, today: string): MonthWindow | { error: string } {
  let y: number;
  let m: number;
  const raw = String(input ?? "").trim();
  if (!raw) {
    const d = new Date(`${today}T12:00:00Z`);
    y = d.getUTCFullYear() + (d.getUTCMonth() === 11 ? 1 : 0);
    m = ((d.getUTCMonth() + 1) % 12) + 1;
  } else {
    const iso = raw.match(/^(\d{4})-(\d{1,2})$/);
    const words = raw.match(/^([a-z]+)\.?\s+(\d{4})$/i);
    if (iso) {
      y = Number(iso[1]);
      m = Number(iso[2]);
    } else if (words) {
      const i = MONTHS.findIndex((n) => n.toLowerCase().startsWith(words[1].toLowerCase().slice(0, 3)));
      if (i < 0) return { error: `I don't know the month "${raw}". Give it as 2027-02 or February 2027.` };
      y = Number(words[2]);
      m = i + 1;
    } else return { error: `I don't know the month "${raw}". Give it as 2027-02 or February 2027.` };
  }
  if (m < 1 || m > 12 || y < 2020 || y > 2100) return { error: `That month isn't one I can plan for: "${raw}".` };
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const end = shiftDay(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1);
  return { month: start.slice(0, 7), start, end, label: `${MONTHS[m - 1]} ${y}`, year: y, startsInDays: Math.round((Date.parse(`${start}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY) };
}

export type MomentRow = { client_id: string; name: string; on_date: string; lead_days: number; angle: string; offer_idea: string; why: string; match_terms: string[]; vertical_id: string | null; business_model: string | null };

/** The moments the person picked, as rows for client_moments (a date that's passed, no name or a repeat is left out and said so) */
export function cleanMoments(raw: unknown, today: string, ctx: { clientId: string; verticalId: string | null; model: string | null }): { rows: MomentRow[]; skipped: string[] } {
  const rows: MomentRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(raw) ? raw.slice(0, 40) : []) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const name = clip(o.name, 120);
    if (!name) {
      skipped.push("A moment with no name");
      continue;
    }
    if (!isDay(o.on_date)) {
      skipped.push(`${name}: it needs a date as YYYY-MM-DD`);
      continue;
    }
    if (o.on_date <= today) {
      skipped.push(`${name}: ${o.on_date} has passed`);
      continue;
    }
    const key = `${name.toLowerCase()}|${o.on_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lead = Math.round(Number(o.lead_days));
    const terms = (Array.isArray(o.match_terms) ? o.match_terms : []).map((t) => String(t).toLowerCase().trim()).filter((t) => t.length >= 3);
    rows.push({
      client_id: ctx.clientId,
      name,
      on_date: o.on_date,
      lead_days: Number.isFinite(lead) ? Math.max(14, Math.min(90, lead)) : 42,
      angle: clip(o.angle, 300),
      offer_idea: clip(o.offer_idea, 400),
      why: clip(o.why, 400),
      match_terms: [...new Set(terms)].slice(0, 4),
      vertical_id: ctx.verticalId,
      business_model: ctx.model,
    });
  }
  return { rows, skipped };
}

// ─── Notes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Text split into notes that fit a client memory row (1,000 characters), each starting with what it is and the date
 * ("Onboarding research (background, 2026-11-17) 2/4: ..."), so it reads as time-bound background and never as a rule.
 */
export function memoryChunks(label: string, text: string, today: string, maxChunks = 14): string[] {
  const tag = (i: number, n: number) => `${label} (background, ${today})${n > 1 ? ` ${i + 1}/${n}` : ""}: `;
  const room = 1000 - tag(9, 99).length;
  const paras = text
    .replace(/\r/g, "")
    .split(/\n{2,}|\n(?=#{1,4} |[-*] )/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const p of paras) {
    let rest = p;
    while (rest.length > room) {
      const cut = Math.max(rest.lastIndexOf(". ", room), rest.lastIndexOf(" ", room));
      push();
      out.push(rest.slice(0, cut > room / 2 ? cut + 1 : room).trim());
      rest = rest.slice(cut > room / 2 ? cut + 1 : room).trim();
    }
    if (cur && cur.length + rest.length + 1 > room) push();
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  push();
  const kept = out.slice(0, maxChunks);
  return kept.map((c, i) => `${tag(i, kept.length)}${c}`.slice(0, 1000));
}

// ─── Onboarding ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type OnboardingItem = { key: string; label: string; state: "done" | "waiting" | "missing"; detail: string; ask?: string };
export type OnboardingFacts = {
  guide: Guide;
  has: GuideHas;
  welcomed: boolean;
  intake: { submitted: boolean; started: boolean };
  call: { booked: boolean; checked: boolean };
  /** Whether a Brand Bible has been built */
  bible: boolean;
};

/** What's done and what's missing in a new client's setup, step by step, with the line to ask the client for each missing one */
export function onboardingItems(f: OnboardingFacts): OnboardingItem[] {
  const { guide: g, has } = f;
  const out: OnboardingItem[] = [];
  const add = (i: OnboardingItem) => out.push(i);
  if (has.meta) {
    const s = g.meta.status;
    if (s === "verified") add({ key: "meta", label: "Meta access (Facebook and Instagram ads)", state: "done", detail: `We can see ${g.meta.accountName ?? "their ad account"}${g.meta.pageName ? ` and the Page ${g.meta.pageName}` : ""}` });
    else if (s === "done") add({ key: "meta", label: "Meta access (Facebook and Instagram ads)", state: "waiting", detail: `They say it's done; we haven't been able to see it yet${g.meta.note ? `: ${g.meta.note}` : ""}`, ask: "Please check that Kaizen is added as a partner on your ad account and your Facebook Page in your Business Manager. The setup step in your portal shows every click." });
    else if (s === "on_call") add({ key: "meta", label: "Meta access (Facebook and Instagram ads)", state: "waiting", detail: "Saved for the onboarding call" });
    else add({ key: "meta", label: "Meta access (Facebook and Instagram ads)", state: "missing", detail: g.meta.note ?? "Not started", ask: "Add Kaizen as a partner on your ad account and Facebook Page in your Business Manager (and your Instagram account if you have one). The setup step in your portal shows every click, and how to make a Business Manager if you don't have one yet." });
  }
  if (has.google) {
    const s = g.google.status;
    if (s === "verified") add({ key: "google", label: "Google Ads account", state: "done", detail: `Account ${g.google.account ?? ""} is under our manager account`.trim() });
    else if (s === "sent" || s === "invited") add({ key: "google", label: "Google Ads account", state: "waiting", detail: s === "invited" ? "We sent the link request; they need to accept it in Google Ads (Admin, Access and security, Managers)" : "They sent the ID; we're sending the link request", ask: s === "invited" ? "Please accept our link request in Google Ads (Admin, then Access and security, then Managers)." : undefined });
    else if (s === "on_call" || s === "none") add({ key: "google", label: "Google Ads account", state: "waiting", detail: s === "none" ? "They don't have an account yet: we set it up with them" : "Saved for the onboarding call" });
    else add({ key: "google", label: "Google Ads account", state: "missing", detail: "No account ID yet", ask: "Send us your Google Ads account ID (the 10 digit number at the top right of Google Ads). If you don't have an account yet, tell us and we'll set it up with you." });
  }
  for (const t of googleTools(g, has)) {
    const names = { ga4: "Google Analytics", gtm: "Google Tag Manager", gbp: "Google Business Profile", merchant: "Google Merchant Center" } as const;
    const s = g[t]?.status;
    if (s === "done" || s === "na") add({ key: t, label: names[t], state: "done", detail: s === "na" ? "Doesn't apply to them" : "Added" });
    else if (s === "on_call") add({ key: t, label: names[t], state: "waiting", detail: "Saved for the onboarding call" });
    else add({ key: t, label: names[t], state: "missing", detail: "Not shared yet", ask: `Add our team as an admin on your ${names[t]}. If you don't have one yet, say so and we'll set it up with you.` });
  }
  if (has.tracking) {
    const t = g.tracking;
    if (toolSettled(t)) add({ key: "tracking", label: "Where orders, bookings or leads live", state: t.status === "on_call" ? "waiting" : "done", detail: t.status === "on_call" ? "Saved for the onboarding call" : "Added" });
    else add({ key: "tracking", label: "Where orders, bookings or leads live", state: "missing", detail: "Not shared yet", ask: "Add our tech address as a user on the system where your orders, bookings or leads are recorded, so we can track what the ads produce." });
  }
  if (has.website) {
    if (toolSettled(g.website)) add({ key: "website", label: "Website access", state: g.website.status === "on_call" ? "waiting" : "done", detail: g.website.status === "on_call" ? "Saved for the onboarding call" : "Shared" });
    else add({ key: "website", label: "Website access", state: "missing", detail: "Not shared yet", ask: "Give us access to your website (Shopify, WordPress, Wix or whichever you use). The setup step shows exactly where." });
  }
  if (has.email) {
    if (toolSettled(g.email)) add({ key: "email", label: "Email platform access", state: g.email.status === "on_call" ? "waiting" : "done", detail: g.email.status === "on_call" ? "Saved for the onboarding call" : "Added" });
    else add({ key: "email", label: "Email platform access", state: "missing", detail: "Not shared yet", ask: "Add our team to your email platform (Klaviyo, Mailchimp or whichever you use)." });
  }
  const files = (g.assets.files ?? 0) + (g.assets.links ?? 0);
  if (files) add({ key: "assets", label: "Brand assets", state: "done", detail: `${g.assets.files ?? 0} files and ${g.assets.links ?? 0} links${g.assets.drive === "partly" ? " (some didn't copy into Drive)" : ""}` });
  else add({ key: "assets", label: "Brand assets", state: "missing", detail: "Nothing shared yet", ask: "Share your logo, photos, videos and brand guide, or a link to the folder that holds them." });
  if (has.looks) {
    if (g.style.styles?.length || g.style.pacing) add({ key: "style", label: "The look they want", state: "done", detail: `${(g.style.styles ?? []).length} styles picked${g.style.pacing ? `, ${g.style.pacing} pacing` : ""}` });
    else add({ key: "style", label: "The look they want", state: "missing", detail: "Not picked yet", ask: "Pick the styles and pacing you love, so your first ads feel like you." });
  }
  if (f.intake.submitted) add({ key: "intake", label: "Marketing intake", state: "done", detail: "Submitted" });
  else add({ key: "intake", label: "Marketing intake", state: f.intake.started ? "waiting" : "missing", detail: f.intake.started ? "Started, not submitted" : "Not started", ask: f.intake.started ? "Please finish and submit your intake (it keeps your answers, so you can pick up where you stopped)." : "Fill in your marketing intake: about ten minutes, with what we already know filled in for you to confirm." });
  if (f.call.checked) add({ key: "call", label: "Onboarding call", state: "done", detail: "Held and access checked again" });
  else if (f.call.booked) add({ key: "call", label: "Onboarding call", state: "waiting", detail: "Booked" });
  else add({ key: "call", label: "Onboarding call", state: "missing", detail: "Not booked yet", ask: "Book your onboarding call using the link in your portal (it's the last step, after your intake)." });
  return out;
}

/** "3 of 7 steps": the portal guide's own count of its access steps, for the summary line */
export const guideCount = (g: Guide, has: GuideHas) => guideProgress(g, has);

/** The email to the client asking for what's missing, in Kaizen's plain, warm voice. Nothing is sent from here. */
export function statusEmail(p: { brand: string; first: string | null; items: OnboardingItem[]; portal: string; goal?: string }): { subject: string; text: string } | null {
  const missing = p.items.filter((i) => i.state === "missing" && i.ask);
  const waiting = p.items.filter((i) => i.state === "waiting" && i.ask);
  const todo = [...missing, ...waiting];
  if (!todo.length) return null;
  const done = p.items.filter((i) => i.state === "done").map((i) => i.label.replace(/ \(.*\)$/, ""));
  const lines = [
    `Hi ${p.first ?? "there"},`,
    "",
    done.length ? `Thank you for getting ${done.length === 1 ? done[0] : "so much"} done already. ${todo.length === 1 ? "There's one thing" : `There are ${todo.length} things`} left so we can start ${p.goal ?? "building your ads"}:` : `We're ready to start ${p.goal ?? "building your ads"}, and there ${todo.length === 1 ? "is one thing" : `are ${todo.length} things`} we need from you:`,
    "",
    ...todo.map((i, n) => `${n + 1}. ${i.label}: ${i.ask}`),
    "",
    `Each step walks you through it in your portal: ${p.portal}`,
    "",
    "If anything is confusing, just reply and we'll do it with you on a quick call.",
    "",
    "Thank you,",
    "The Kaizen team",
  ];
  return { subject: `${p.brand}: ${todo.length === 1 ? "one last thing" : `${todo.length} quick things`} to get started`, text: lines.join("\n") };
}

// ─── The week's work ─────────────────────────────────────────────────────────────────────────────────────────────────

export type WorkItem = { kind: "ticket" | "asana" | "plan_task" | "reply"; title: string; client: string | null; due: string | null; status: string; href: string | null };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday to Sunday around a day */
export function weekOf(today: string) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = shiftDay(today, -((dow + 6) % 7));
  return { start, end: shiftDay(start, 6), days: Array.from({ length: 7 }, (_, i) => shiftDay(start, i)) };
}
export const dayName = (day: string) => DAY_NAMES[new Date(`${day}T12:00:00Z`).getUTCDay()];

export type WeekList = { week: { from: string; to: string }; overdue: WorkItem[]; days: { day: string; name: string; items: WorkItem[] }[]; later: WorkItem[]; noDate: WorkItem[]; counts: { total: number; overdue: number; thisWeek: number } };

/** Open work by due date: late first, then each day of this week, then later, then undated; each group by client */
export function groupWork(items: WorkItem[], today: string): WeekList {
  const w = weekOf(today);
  const byClient = (a: WorkItem, b: WorkItem) => (a.client ?? "~").localeCompare(b.client ?? "~") || a.title.localeCompare(b.title);
  const byDue = (a: WorkItem, b: WorkItem) => (a.due ?? "").localeCompare(b.due ?? "") || byClient(a, b);
  const overdue = items.filter((i) => i.due && i.due < today).sort(byDue);
  const days = w.days.map((day) => ({ day, name: dayName(day), items: items.filter((i) => i.due === day && i.due >= today).sort(byClient) }));
  const later = items.filter((i) => i.due && i.due > w.end).sort(byDue);
  const noDate = items.filter((i) => !i.due).sort(byClient);
  const thisWeek = days.reduce((n, d) => n + d.items.length, 0);
  return { week: { from: w.start, to: w.end }, overdue, days, later, noDate, counts: { total: items.length, overdue: overdue.length, thisWeek } };
}

// ─── Google Sheets and sheet data ────────────────────────────────────────────────────────────────────────────────────

/** The file id (and tab, when the link has one) in a Google Sheets or Drive link */
export function sheetLink(url: string): { id: string; gid: string | null } | null {
  const m = url.match(/\/(?:spreadsheets|file)\/d\/([\w-]{15,})/) ?? url.match(/[?&]id=([\w-]{15,})/);
  if (!m) return null;
  return { id: m[1], gid: url.match(/[#&?]gid=(\d+)/)?.[1] ?? null };
}

const letter = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A cell as a number ($1,234.50, 12%, (45), 1.2k not read), or null */
export function cellNumber(v: string): number | null {
  const s = v.trim();
  if (!s || s.length > 24) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const t = s.replace(/[()$€£,\s%x]/g, "").replace(/^-/, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export type ColumnSummary = { column: string; header: string; filled: number; kind: "number" | "text"; sum?: number; min?: number; max?: number; average?: number; top?: { value: string; count: number }[] };

/** Where the header is, how many rows of data, and what each column holds (sums for numbers, the most common values for text) */
export function summarizeSheet(rows: string[][]): { headerRow: number; dataRows: number; columns: ColumnSummary[] } {
  const at = Math.max(0, rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2));
  const header = rows[at] ?? [];
  const data = rows.slice(at + 1).filter((r) => r.some((c) => c.trim()));
  const width = Math.min(120, Math.max(header.length, ...data.slice(0, 200).map((r) => r.length), 0));
  const columns: ColumnSummary[] = [];
  for (let c = 0; c < width; c++) {
    const vals = data.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    const h = (header[c] ?? "").trim();
    if (!vals.length && !h) continue;
    const nums = vals.map(cellNumber);
    const numeric = vals.length > 0 && nums.filter((n) => n != null).length / vals.length >= 0.7;
    if (numeric) {
      const xs = nums.filter((n): n is number => n != null);
      const sum = xs.reduce((a, b) => a + b, 0);
      columns.push({ column: letter(c), header: h, filled: vals.length, kind: "number", sum: Math.round(sum * 100) / 100, min: Math.min(...xs), max: Math.max(...xs), average: Math.round((sum / xs.length) * 100) / 100 });
    } else {
      const count = new Map<string, number>();
      for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1);
      const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, n]) => ({ value: value.slice(0, 60), count: n }));
      columns.push({ column: letter(c), header: h, filled: vals.length, kind: "text", top: count.size < vals.length || count.size <= 8 ? top : undefined });
    }
  }
  return { headerRow: at + 1, dataRows: data.length, columns };
}

/** Rows as lines of text ("12 | a | b"), from a row number, up to a number of rows and characters */
export function rowsText(rows: string[][], from: number, maxRows: number, maxChars: number): { text: string; last: number; more: boolean } {
  const out: string[] = [];
  let chars = 0;
  let last = from - 1;
  for (let i = Math.max(1, from) - 1; i < rows.length && out.length < maxRows; i++) {
    const r = rows[i];
    if (!r.some((c) => c.trim())) {
      last = i + 1;
      continue;
    }
    const line = `${i + 1} | ${r.map((c) => c.replace(/\s+/g, " ").trim()).join(" | ")}`.replace(/(?: \|)+$/, "");
    if (chars + line.length > maxChars && out.length) return { text: out.join("\n"), last, more: true };
    out.push(line);
    chars += line.length + 1;
    last = i + 1;
  }
  return { text: out.join("\n"), last, more: last < rows.length };
}

// ─── Meta ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Meta's ad account status codes in plain words */
export function accountStatus(code: number | null | undefined): { label: string; bad: boolean } {
  const map: Record<number, [string, boolean]> = {
    1: ["Active", false],
    2: ["Disabled", true],
    3: ["Unsettled: a payment is overdue", true],
    7: ["In a risk review", true],
    8: ["Waiting for a payment to settle", true],
    9: ["In a grace period", true],
    100: ["Waiting to close", true],
    101: ["Closed", true],
  };
  const m = code == null ? null : map[code];
  return m ? { label: m[0], bad: m[1] } : { label: code == null ? "Unknown" : `Status ${code}`, bad: code != null && code !== 1 };
}

/** Why Meta says an ad account is disabled (its disable_reason code) */
export function disableReason(code: number | null | undefined): string | null {
  const map: Record<number, string> = {
    1: "Ads integrity policy: ads broke Meta's advertising policies",
    2: "Ads IP review: an intellectual property complaint",
    3: "Payment risk: Meta flagged the payment method",
    4: "Account shut down as a suspicious (gray) account",
    5: "Ads automated review (AFC): ad content or account behavior flagged",
    6: "Business integrity: the business is under review",
    7: "Permanently closed",
    8: "Unused reseller account",
    9: "Unused account closed",
    11: "Business Manager integrity policy",
    12: "Misrepresented ad account",
  };
  return code ? (map[code] ?? `Reason code ${code}`) : null;
}

export type MetaFacts = {
  configured: boolean;
  services: { meta: boolean };
  /** The ad account on file (digits) */
  account: string | null;
  /** Kaizen's Business Manager ID (Settings, onboarding access) */
  kaizenBm: string | null;
  live: null | {
    error?: string;
    status?: number | null;
    disable?: number | null;
    name?: string | null;
    business?: string | null;
    verification?: string | null;
    pixels?: { name: string; lastFired: string | null }[] | null;
    /** The businesses the account is shared with (partners), when Meta let us read them */
    partners?: string[] | null;
    pages?: number | null;
    instagram?: number | null;
  };
  guide: { status?: string; note?: string | null; accountName?: string | null; pageName?: string | null };
  social: null | { pageId: string | null; igId: string | null; state: string; error: { message: string; fix: string } | null; missing: string[] };
  bm: { ok: boolean; text: string }[];
  now: number;
};

export type Finding = { severity: "blocker" | "fix" | "watch"; problem: string; why: string; steps: string[] };

/** What's wrong with a client's Meta setup, from the facts read, each with the exact steps to fix it */
export function metaFindings(f: MetaFacts): Finding[] {
  const out: Finding[] = [];
  const bmId = f.kaizenBm ? `Kaizen's Business ID is ${f.kaizenBm}` : "Kaizen's Business ID is in Settings, onboarding access";
  if (!f.configured) out.push({ severity: "blocker", problem: "Kaizen's Meta connection isn't set up", why: "Without it nothing can be read from Meta for any client.", steps: ["Tell the head of the team or an executive: the Meta system user token is missing in Vercel (META_SYSTEM_USER_TOKEN)."] });
  if (f.services.meta && !f.account)
    out.push({
      severity: "blocker",
      problem: "No Meta ad account is on file for this client",
      why: "We can't read results, launch or check access until we know which ad account is theirs.",
      steps: ["Ask the client for their ad account ID (Meta Business Settings, Accounts, Ad accounts, the number under the account's name), or find it in the onboarding sheet.", "Put it on the client's page under Team and setup, or in the onboarding guide's Meta step.", `Ask them to add Kaizen as a partner on it (${bmId}).`],
    });
  const l = f.live;
  if (l?.error) out.push({ severity: "watch", problem: "Meta wouldn't show the ad account to Kaizen's system user", why: l.error.slice(0, 240), steps: ["Most often the client hasn't shared the ad account with Kaizen yet, or shared it as view only.", `In the client's Business Settings: Accounts, Ad accounts, pick the account, Add partner, enter Kaizen's Business ID (${f.kaizenBm ?? "see Settings"}), turn on Manage ad account.`, "Then check again here."] });
  if (l && !l.error) {
    const s = accountStatus(l.status);
    if (s.bad)
      out.push({
        severity: "blocker",
        problem: `The ad account is ${s.label.toLowerCase()}${disableReason(l.disable) ? ` (${disableReason(l.disable)})` : ""}`,
        why: "Ads can't run while it is in this state.",
        steps:
          l.status === 3 || l.status === 8 || l.status === 9
            ? ["The client opens Meta Billing & payments for the ad account and pays the outstanding balance or fixes the payment method.", "Once it settles, the account returns to active within a few hours.", "If it doesn't, open a support request from Business Support Home."]
            : l.status === 7
              ? ["Wait for the risk review to finish (usually a day or two) and don't change payment methods meanwhile.", "The client can check Account Quality in Business Settings for any open request."]
              : ["Open Account Quality in the client's Meta Business Suite (Business Settings, Security Center or Account Quality) and read what Meta says.", "If there's a Request review button, the client (a business admin) presses it and explains the business in a line.", "Don't create a replacement account or share payment details: that can extend the ban. Tell the head of the team."],
      });
    const v = (l.verification ?? "").toLowerCase();
    if (v && v !== "verified")
      out.push({ severity: "fix", problem: v.startsWith("pending") ? "The client's business verification with Meta is still pending" : "The client's business isn't verified with Meta", why: "Unverified businesses hit limits (fewer ad accounts, restricted features) and can lose access when Meta reviews them.", steps: v.startsWith("pending") ? ["Meta is still reviewing it: nothing to do unless Meta asked for more. The client's business admin can see the request in Business Settings, Security Center."] : ["The client's business admin opens Business Settings, Security Center, Business verification, and starts it.", "They upload the legal business name, address, phone and a document that shows them (registration, utility bill or bank statement).", "Meta confirms by email or phone code; it can take a few days."] });
    if (f.kaizenBm && l.partners && !l.partners.includes(f.kaizenBm))
      out.push({ severity: "blocker", problem: "Kaizen isn't a partner on this ad account", why: "We can see the account in some cases through another route, but partner access is what lets the whole team work on it.", steps: [`The client's business admin opens Business Settings, Accounts, Ad accounts, picks the account, Add partner.`, `They enter Kaizen's Business ID (${f.kaizenBm}) and turn on Manage ad account.`, "Check here again afterwards."] });
    if (l.pixels && !l.pixels.length) out.push({ severity: "fix", problem: "No pixel (dataset) is on the ad account", why: "Without one we can't track results or build audiences from the website.", steps: ["In Events Manager, create a dataset (pixel) for the ad account, then install it on the website (the website platform's Meta or Facebook integration, or Tag Manager).", "Add Conversions API through the website platform's own integration.", "Check that it fires with the Meta Pixel Helper."] });
    else if (l.pixels?.length && l.pixels.every((p) => !p.lastFired)) out.push({ severity: "fix", problem: "The pixel has never fired", why: "It's installed on nothing, or the install is broken, so no events reach Meta.", steps: ["Open the website with the Meta Pixel Helper on and look for the pixel ID.", "If it isn't there, install it through the website platform's Meta integration or Tag Manager.", "Visit a few pages and a checkout step, then look in Events Manager for the events."] });
    else if (l.pixels?.length && l.pixels.every((p) => p.lastFired && f.now - Date.parse(p.lastFired) > 7 * DAY)) out.push({ severity: "fix", problem: "The pixel hasn't fired in over a week", why: "Tracking stopped: a theme change, a removed app or a blocked script usually does it.", steps: ["Open the website with the Meta Pixel Helper and check it still loads.", "Ask the client whether the site, theme or checkout app changed recently.", "Reinstall it through the platform's Meta integration and test events in Events Manager."] });
  }
  const s = f.social;
  if (s) {
    if (s.missing.length) out.push({ severity: "fix", problem: `Kaizen's Meta connection is missing a permission (${s.missing.join(", ")})`, why: s.error?.message ?? "Organic numbers can't be read without it.", steps: ["This is on Kaizen's side, not the client's: tell the head of the team or an executive.", s.error?.fix ?? "Add the permission to the Meta system user's token and replace it in Vercel."] });
    else if (s.error) out.push({ severity: "fix", problem: s.error.message, why: "The Page and Instagram numbers aren't being read.", steps: [s.error.fix] });
    if (!s.pageId) out.push({ severity: "fix", problem: "No Facebook Page is linked to this client", why: "Organic numbers and Page based ads need the Page.", steps: [`The client's business admin opens Business Settings, Accounts, Pages, Add, and chooses "Give a partner access" with Kaizen's Business ID (${f.kaizenBm ?? "see Settings"}) and Manage Page (Full control) or at least Insights and Create content.`, "Then pick the Page on the client's Social tab."] });
    if (s.pageId && !s.igId) out.push({ severity: "watch", problem: "The Page has no Instagram account linked", why: "Instagram numbers and Instagram placements need the account connected to the Page and to the Business Manager.", steps: ["The client opens the Page's Settings, Linked accounts, Instagram, and connects the Instagram professional (business or creator) account.", "Then in Business Settings, Accounts, Instagram accounts, adds that account and shares it with Kaizen.", "Personal Instagram accounts can't be linked: switch it to professional first."] });
  }
  for (const b of f.bm) if (!b.ok) out.push({ severity: "watch", problem: "The client's chosen Business Manager token doesn't reach the ad account", why: b.text, steps: ["The head of the team checks the client's Business Manager in Team and setup, and the partner access of that Business Manager on the ad account."] });
  if (!out.length && f.guide.note) out.push({ severity: "watch", problem: "The onboarding guide has a note on Meta", why: f.guide.note, steps: ["Follow the note, then check again here."] });
  const order = { blocker: 0, fix: 1, watch: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ─── The national days library ───────────────────────────────────────────────────────────────────────────────────────

/** The title every national days library item starts with (knowledge on the Email Strategist's calendar skill) */
export const NATIONAL_DAYS_TITLE = "National days library";
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * One month's lines from the library (its "## <Month>" section), so monthly_moments offers the fun national days
 * alongside the big holidays. Month is 1 to 12. Empty when the library has no section for it.
 */
export function monthSection(markdown: string, month: number): string {
  const name = MONTH_NAMES[month - 1];
  if (!name) return "";
  const lines = markdown.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*${name}\\b`, "i").test(l.trim()));
  if (at < 0) return "";
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,4}\s/.test(l.trim())) break;
    if (l.trim()) out.push(l.trim());
  }
  return out.join("\n");
}
