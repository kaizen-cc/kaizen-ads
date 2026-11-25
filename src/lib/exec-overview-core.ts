// The executive Overview and morning recap, the pure part (owner, Nov 23 2026; tested in tests/exec-overview.test.ts).
// An exec sees four tabs (the owner a fifth): what's on them personally (Needs me), what climbed past a lead (Escalated:
// rung 3 of the ladder, plus fires, which skip it), accounts in their focus off target with nothing in motion
// (Accounts), and a read-only Pulse; the owner also sees System. At most 5 cards a tab, the rest behind a tap. Nothing
// below rung 3 reaches an exec except a fire.

/** One line of an item's context: who said it, when, what (ours: the team's side) */
export type ItemContextLine = { from: string; at: string | null; text: string; ours: boolean };

export type ExecTab = "needs" | "escalated" | "accounts" | "asana" | "pulse" | "system";
export const EXEC_TABS: readonly ExecTab[] = ["needs", "escalated", "accounts", "asana", "pulse", "system"];
export const TAB_LABEL: Record<ExecTab, string> = { needs: "Needs me", escalated: "Escalated", accounts: "Accounts", asana: "Next for me in Asana", pulse: "Pulse", system: "System" };
export const isExecTab = (x: unknown): x is ExecTab => typeof x === "string" && (EXEC_TABS as readonly string[]).includes(x);
/** Cards shown on a tab before "N more" */
export const TAB_CAP = 5;

export type Severity = "fire" | "critical" | "high" | "normal";
const SEV_RANK: Record<Severity, number> = { fire: 3, critical: 2, high: 1, normal: 0 };

export type ExecCard = {
  /** Stable, for Done and Later (daily_items) */
  key: string;
  tab: ExecTab;
  kind: "owed" | "said" | "asana" | "mine" | "approval" | "taken" | "stuck" | "team" | "fire" | "account" | "pulse" | "system" | "draft" | "todo";
  client: string | null;
  clientId: string | null;
  clientSlug?: string | null;
  /** One line: what it is */
  title: string;
  /** One line under it: how long, who has it, what's being done */
  detail: string;
  severity: Severity;
  /** When it's due (Needs me sorts by it) */
  due?: string | null;
  /** The main action */
  action: { label: string; href: string | null };
  /** Escalated: the ladder items behind the card, and the lead a nudge goes to */
  nudgeIds?: string[];
  lead?: { id: string; name: string; role: string } | null;
  /** Escalated: the message drafted for the exec to nudge the lead */
  draft?: string;
  /** Accounts: the line and the number that matters ("CPA $84 vs $50 target") */
  line?: string | null;
  stat?: string | null;
  /** An email drafted for this person to send about it: the item's main action is Open draft */
  emailDraft?: { id: string; client: string; kind: string; subject: string; body: string; to: string[]; reason: string | null; opened: boolean; files?: { id: string; name: string }[] } | null;
  /** Enough to act without leaving: the conversation (their messages and ours, oldest first) or the exact words promised */
  context?: ItemContextLine[] | null;
  /** A teammate to call about it (Accounts: the buyer) */
  callee?: { id: string; name: string } | null;
  /** A group's own items, each reviewed on its own (each flagged call, each reminder saved from a call) */
  subs?: SubItem[] | null;
  /** How a group card's title counts what's left ("5 reminders you saved...", "1 call safety review..."), redone as they close */
  subsTitle?: SubsTitle | null;
  /** Where it came from (a task asked on a call or in a chat; the Slack thread or email a stuck item was said in) */
  source?: { label: string; href?: string | null; transcriptCallId?: string | null } | null;
  /** The recommended move, said plainly (Escalated: what Nudge does and to whom) */
  hint?: string | null;
  /** Escalated with one item: the item itself (its key on the owner's day), for Reassign */
  itemKey?: string | null;
};

/** Address parameters that open something on the Overview (a sheet, a composer, a filtered list): a real destination */
const OPENERS = ["item", "nudge", "task", "draft", "sent", "client", "cl", "stepins", "sub", "edit"];

/**
 * Whether an item's main action would only land back on the Overview (or the recap) it's already on: nothing, "#",
 * /pipeline or /today, a block of it, an anchor in it (owner, Nov 24 2026: "Open it" showed "Opening..." and landed
 * back on the Overview). An address that opens something there (?item=, ?nudge=, ?task=...) is a destination.
 */
export function pointsAtOverview(href: string | null | undefined): boolean {
  const h = String(href ?? "").trim();
  if (!h || h === "#" || h.startsWith("#")) return true;
  if (/^https?:/i.test(h)) return false;
  const u = new URL(h, "https://os.local");
  if (u.pathname !== "/pipeline" && u.pathname !== "/today" && u.pathname !== "/") return false;
  return !OPENERS.some((p) => u.searchParams.has(p));
}

/** The item's own sheet on the Overview (?item=<key>, Back closes it), from anywhere (the recap opens it there) */
export const itemSheetHref = (c: { key: string; tab: string }) => `/pipeline?block=${encodeURIComponent(c.tab)}&item=${encodeURIComponent(c.key)}`;

/**
 * How a row in the Overview's list view opens its item (owner, Nov 25 2026: a click folded the list back up instead of
 * opening the task): one that only points at the Overview opens its own sheet in place (?item=, the list stays open),
 * another site in a new tab, a page of Kaizen OS in this one.
 */
export function rowOpens(href: string | null | undefined): "sheet" | "external" | "page" {
  if (pointsAtOverview(href)) return "sheet";
  return /^https?:/i.test(String(href).trim()) ? "external" : "page";
}

/** An item's main action: its real destination, else its own sheet (never the Overview it's on) */
export function primaryHref(c: { key: string; tab: string; action: { href: string | null } }): string {
  return pointsAtOverview(c.action.href) ? itemSheetHref(c) : (c.action.href as string);
}

export type SubsTitle = { one: string; many: string };

/**
 * One item inside a group card: opens on its own page, Done or Dismiss on its own. key: what closing it closes
 * ("safety:<call id>" resolves that call's review for every exec; "ask:<id>" closes that reminder or task).
 */
export type SubItem = {
  key: string;
  title: string;
  meta: string;
  detail?: string | null;
  href: string | null;
  /** The reminder a line belongs to ("3 follow-ups from your call"): lines of one reminder show under it */
  group?: string | null;
  /** Past its due date (the card counts what's overdue) */
  overdue?: boolean;
};

/**
 * A group card with some of its own items closed: what's left, its title and detail counted again, and nothing when
 * none are left (the card itself is done). A reminder whose lines are all closed goes with them. The Overview does this
 * the moment one closes, and a saved day does it on read, so the counts agree before the day is built again.
 */
export function subsLeft<C extends { title: string; detail?: string; story?: string; subs?: SubItem[] | null; subsTitle?: SubsTitle | null; stat?: { value: string; label: string } | string | null }>(c: C, closed: { has: (k: string) => boolean }): C | null {
  if (!c.subs?.length) return c;
  const left = c.subs.filter((s) => !closed.has(s.key) && !closed.has(s.key.split("#")[0]));
  if (left.length === c.subs.length) return c;
  if (!left.length) return null;
  const n = left.length;
  const late = left.filter((s) => s.overdue).length;
  const title = c.subsTitle ? `${n} ${n === 1 ? c.subsTitle.one : c.subsTitle.many}` : c.title;
  const recount = (t: string | undefined) => (t == null ? t : t.replace(/^\d+ overdue · /, late ? `${late} overdue · ` : ""));
  const stat = c.stat && typeof c.stat === "object" && /^\d+$/.test(c.stat.value) ? { ...c.stat, value: String(n) } : c.stat;
  return { ...c, subs: left, title, ...(c.detail != null ? { detail: recount(c.detail) } : {}), ...(c.story != null ? { story: recount(c.story) } : {}), ...(stat !== undefined ? { stat } : {}) };
}

/** Every line of one reminder closed: the reminder itself is done (its parent auto-completes) */
export function reminderDone(subs: readonly SubItem[], closed: { has: (k: string) => boolean }, askId: string): boolean {
  const lines = subs.filter((s) => s.key.startsWith(`ask:${askId}#`));
  return lines.length > 0 && lines.every((s) => closed.has(s.key));
}

const ROLE_WORD = (r: string | null | undefined) => (r ? r.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Someone");
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const shortWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : null);

/** One flagged call as its own item: the caller's role and name, when, what was flagged, how serious, the first moment */
export function safetySub(
  f: { call_id: string; severity: string | null; distress: boolean | null; categories: string[] | null; reviewed_at: string | null; moments?: { at_seconds: number; category: string; note: string }[] | null; summary?: string | null },
  call: { started_at: string; profiles: { full_name: string | null; role: string | null } | null } | null,
): SubItem {
  const who = [ROLE_WORD(call?.profiles?.role), call?.profiles?.full_name].filter(Boolean).join(" · ");
  const what = [...new Set(f.categories ?? [])].map((c) => c.replace(/_/g, " ")).join(", ") || "flagged";
  const sev = f.distress ? "distress" : f.severity ? `${f.severity} severity` : null;
  const first = [...(f.moments ?? [])].sort((a, b) => a.at_seconds - b.at_seconds)[0];
  return {
    key: `safety:${f.call_id}`,
    title: `${who}: ${what}`,
    meta: [shortWhen(call?.started_at ?? f.reviewed_at), sev].filter(Boolean).join(" · "),
    detail: first ? `At ${mmss(first.at_seconds)}: ${first.note}` : (f.summary ?? null),
    href: `/safety/${f.call_id}`,
  };
}

// ─── The ladder's third rung ────────────────────────────────────────────────

export const RUNG3_HOURS = 48;

/** The last movement on an item the ladder knows about: reaching the lead, the lead's nudge sent, any touch after */
export function lastMove(n: { createdAt: string; sentAt?: string | null; movedAt?: string | null }): number {
  return Math.max(...[n.createdAt, n.sentAt, n.movedAt].map((x) => (x ? Date.parse(x) : 0)).filter(Number.isFinite));
}

/**
 * Whether an item at the lead's rung has climbed to the execs: 48 hours with nothing moving since it reached the lead
 * (or since the last touch). Waiting on the client pauses it; a touch brings it back down.
 */
export function atRung3(n: { createdAt: string; sentAt?: string | null; movedAt?: string | null }, paused: boolean, now = new Date()): boolean {
  if (paused) return false;
  return now.getTime() - lastMove(n) >= RUNG3_HOURS * 3_600_000;
}

// ─── Escalated: one card per client ─────────────────────────────────────────

export type Rung3Row = {
  id: string;
  itemKey: string;
  clientId: string | null;
  client: string | null;
  clientSlug?: string | null;
  ownerId: string;
  owner: string;
  leadId: string;
  lead: string;
  leadRole: string;
  /** "Head of Email" */
  leadLabel: string;
  what: string;
  /** Since when nothing was done (the owner's clock) */
  since: string;
  /** When it reached the lead (rung 2) */
  reachedLead: string;
  line: string | null;
  href: string | null;
  /** The owner's role ("Lead video editor") */
  ownerLabel?: string | null;
  /** The actual words: the message waiting on a reply, the promise made, the task's title (who, when, what) */
  quote?: { from: string; at: string | null; text: string } | null;
  /** Where it was said: "Slack #sierra-dreams", "Email: Re: Next steps", with the link (opens in a new tab) */
  source?: { label: string; href: string | null } | null;
};

export type FireRow = { clientId: string; client: string; clientSlug?: string | null; why: string; href: string | null; line?: string | null; at?: string | null };

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const daysSince = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));

const TEAM_OF: Record<string, string> = { creative: "Creative", email: "Email", social: "Social", meta: "Meta", google: "Google" };

/** "with Mel 5d → Head of Email 3d": who had it and for how long, then the lead */
export function chainLabel(r: Pick<Rung3Row, "owner" | "since" | "leadLabel" | "reachedLead">, now = new Date()): string {
  return `with ${first(r.owner)} ${daysSince(r.since, now)}d → ${r.leadLabel} ${daysSince(r.reachedLead, now)}d`;
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** What it is, in plain words: "reply to Zach Osness", "the meta weekly report (period ended Oct 25)" */
export const plainWhat = (what: string) => what.replace(/^(a|an)\s+/i, "").trim();

/**
 * Who has it and how it climbed, in full (owner, Nov 24 2026: an exec couldn't tell what a stuck item was or who had
 * it): "Jazem (Lead video editor) had it 26 days, then Jesus (Head of Creative) 3 days, with nothing moving".
 */
export function ladderStory(r: Pick<Rung3Row, "owner" | "ownerLabel" | "since" | "lead" | "leadLabel" | "reachedLead">, now = new Date()): string {
  const owner = `${first(r.owner)}${r.ownerLabel ? ` (${r.ownerLabel})` : ""}`;
  return `${owner} had it ${days(Math.max(0, daysSince(r.since, now) - daysSince(r.reachedLead, now)))}, then ${first(r.lead)} (${r.leadLabel}) ${days(daysSince(r.reachedLead, now))}, with nothing moving`;
}

/** The recommended move, said plainly: what Nudge does and to whom */
export const nudgeHint = (lead: string, leadLabel: string) => `Recommended: nudge ${first(lead)} (${leadLabel}). Nudge shows a drafted message to edit, then sends it to them in Kaizen OS (their Overview and bell). Or take it yourself, or reassign it (under More).`;

/** The exec's message to the lead: short, about the stuck work and the people on it */
export function leadNudgeDraft(o: { lead: string; client?: string | null; n: number; owners: string[]; days: number }): string {
  const who = o.owners.length ? ` (${[...new Set(o.owners.map(first))].slice(0, 3).join(", ")})` : "";
  const what = o.client ? `${o.client} has ${o.n} ${o.n === 1 ? "thing" : "things"}` : `Your team has ${o.n} things`;
  return `Hey ${first(o.lead)}, ${what} stuck with the team${who}, nothing moving for ${Math.max(2, o.days)}+ days after it reached you. Can you get it moving today, or tell me what's blocking it?`;
}

/**
 * The Escalated tab: rung-3 items and fires, one card per client. A lead with more than 5 items at rung 3 becomes one
 * team card ("Email team: 9 stuck, 6 with Mel"). Fires lead; a client on fire with stuck work is one card.
 */
export function groupEscalated(rows: readonly Rung3Row[], fires: readonly FireRow[], now = new Date()): ExecCard[] {
  const cards: ExecCard[] = [];
  const byLead = new Map<string, Rung3Row[]>();
  for (const r of rows) byLead.set(r.leadId, [...(byLead.get(r.leadId) ?? []), r]);
  const teamed = new Set<string>();
  for (const [leadId, list] of byLead) {
    if (list.length <= TAB_CAP) continue;
    list.forEach((r) => teamed.add(r.id));
    const owners = new Map<string, number>();
    for (const r of list) owners.set(r.owner, (owners.get(r.owner) ?? 0) + 1);
    const [topOwner, topN] = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
    const oldest = [...list].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    const team = TEAM_OF[oldest.line ?? ""] ?? oldest.leadLabel.replace(/^Head of /, "");
    cards.push({
      key: `esc:team:${leadId}`,
      tab: "escalated",
      kind: "team",
      client: null,
      clientId: null,
      title: `${team} team: ${list.length} stuck, ${topN} with ${first(topOwner)}`,
      detail: `${first(oldest.lead)} (${oldest.leadLabel}) has had them up to ${days(daysSince(oldest.reachedLead, now))}; the oldest: ${oldest.client ?? "internal"} · ${plainWhat(oldest.what)}`,
      severity: "critical",
      action: { label: `Nudge ${first(oldest.lead)}`, href: null },
      hint: nudgeHint(oldest.lead, oldest.leadLabel),
      nudgeIds: list.map((r) => r.id),
      lead: { id: leadId, name: oldest.lead, role: oldest.leadRole },
      draft: leadNudgeDraft({ lead: oldest.lead, n: list.length, owners: list.map((r) => r.owner), days: daysSince(oldest.reachedLead, now) }),
    });
  }
  const byClient = new Map<string, Rung3Row[]>();
  for (const r of rows) {
    if (teamed.has(r.id)) continue;
    const k = r.clientId ?? `owner:${r.ownerId}`;
    byClient.set(k, [...(byClient.get(k) ?? []), r]);
  }
  const fireOf = new Map(fires.map((f) => [f.clientId, f]));
  for (const [k, list] of byClient) {
    const oldest = [...list].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    const fire = oldest.clientId ? fireOf.get(oldest.clientId) : undefined;
    if (fire) fireOf.delete(fire.clientId);
    const name = oldest.client ?? "Internal";
    const waited = daysSince(oldest.since, now);
    // Read like the item: "Sierra Dreams · reply to Zach Osness waiting 10 days" (several: the oldest, and how many more)
    const headline = list.length === 1 ? `${name} · ${plainWhat(oldest.what)} waiting ${days(waited)}` : `${name} · ${plainWhat(oldest.what)} waiting ${days(waited)}, and ${list.length - 1} more stuck`;
    // The actual words behind each (up to 3), oldest first, so nobody has to go looking to know what it is
    const context = [...list]
      .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
      .slice(0, 3)
      .map((r) => (r.quote ? { from: r.quote.from, at: r.quote.at, text: `${list.length > 1 ? `${plainWhat(r.what)}: ` : ""}${r.quote.text}`, ours: false } : { from: first(r.owner), at: r.since, text: plainWhat(r.what), ours: true }));
    cards.push({
      key: `esc:${k}`,
      tab: "escalated",
      kind: fire ? "fire" : "stuck",
      client: oldest.client,
      clientId: oldest.clientId,
      clientSlug: oldest.clientSlug ?? null,
      title: fire ? `${name} is on fire: ${fire.why}` : headline,
      detail: fire ? `${list.length} stuck too · ${ladderStory(oldest, now)}` : ladderStory(oldest, now),
      severity: fire ? "fire" : "critical",
      action: { label: fire ? "Open it" : `Nudge ${first(oldest.lead)}`, href: fire ? (fire.href ?? oldest.href) : oldest.href },
      context,
      source: oldest.source ?? (oldest.href ? { label: "Open the source", href: oldest.href } : null),
      hint: fire ? null : nudgeHint(oldest.lead, oldest.leadLabel),
      itemKey: list.length === 1 ? oldest.itemKey : null,
      nudgeIds: list.map((r) => r.id),
      lead: { id: oldest.leadId, name: oldest.lead, role: oldest.leadRole },
      draft: leadNudgeDraft({ lead: oldest.lead, client: oldest.client, n: list.length, owners: list.map((r) => r.owner), days: daysSince(oldest.reachedLead, now) }),
      line: oldest.line,
    });
  }
  for (const f of fireOf.values())
    cards.push({
      key: `esc:fire:${f.clientId}`,
      tab: "escalated",
      kind: "fire",
      client: f.client,
      clientId: f.clientId,
      clientSlug: f.clientSlug ?? null,
      title: `${f.client} is on fire: ${f.why}`,
      detail: "A fire skips the ladder: every exec sees it",
      severity: "fire",
      action: { label: "Open it", href: f.href ?? (f.clientSlug ? `/clients/${f.clientSlug}` : null) },
      line: f.line ?? null,
    });
  return sortCards(cards);
}

/** Most severe first, then the oldest (Escalated) or the soonest due (Needs me) */
export function sortCards(cards: readonly ExecCard[]): ExecCard[] {
  const t = (c: ExecCard) => (c.due ? Date.parse(c.due) : Number.POSITIVE_INFINITY);
  return [...cards].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || t(a) - t(b));
}

/** Needs me: by due date (overdue first), undated last, the most severe first among equals */
export function sortNeeds(cards: readonly ExecCard[]): ExecCard[] {
  const t = (c: ExecCard) => (c.due ? Date.parse(c.due) : Number.POSITIVE_INFINITY);
  return [...cards].sort((a, b) => t(a) - t(b) || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

/** A tab's first cards and how many more sit behind "N more" */
export function capTab<T>(cards: readonly T[], cap = TAB_CAP): { shown: T[]; more: number } {
  return { shown: cards.slice(0, cap), more: Math.max(0, cards.length - cap) };
}

export type HeaderPart = { tab: ExecTab; text: string; n: number };

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The one-line header, each part opening its tab: "3 need you · 2 stuck with leads · 1 account to step into" */
export function headerParts(c: { needs: number; fires: number; stuck: number; accounts: number }): HeaderPart[] {
  const parts: HeaderPart[] = [];
  if (c.fires) parts.push({ tab: "escalated", n: c.fires, text: `${c.fires} on fire` });
  if (c.needs) parts.push({ tab: "needs", n: c.needs, text: `${c.needs} ${s(c.needs, "needs", "need")} you` });
  if (c.stuck) parts.push({ tab: "escalated", n: c.stuck, text: `${c.stuck} stuck with leads` });
  if (c.accounts) parts.push({ tab: "accounts", n: c.accounts, text: `${c.accounts} ${s(c.accounts, "account", "accounts")} to step into` });
  return parts;
}

/** The tab an exec's Overview opens on: the one holding the most critical thing */
export function openingTab(tabs: Partial<Record<ExecTab, readonly ExecCard[]>>): ExecTab {
  const has = (t: ExecTab, sev?: Severity) => (tabs[t] ?? []).some((c) => !sev || c.severity === sev);
  if (has("escalated", "fire")) return "escalated";
  const overdue = (tabs.needs ?? []).some((c) => c.due && Date.parse(c.due) < Date.now());
  if (overdue || has("needs", "critical")) return "needs";
  if (has("escalated")) return "escalated";
  if (has("needs")) return "needs";
  if (has("accounts")) return "accounts";
  if (has("system", "critical")) return "system";
  return "needs";
}

// ─── Which exec hears about which line ──────────────────────────────────────

/** The focus lines a ladder line (or an account's line) belongs to */
export function focusOfLine(line: string | null | undefined): string[] {
  switch (String(line ?? "")) {
    case "meta":
    case "facebook-ads":
      return ["meta"];
    case "google":
    case "google-ads":
      return ["google"];
    case "tiktok":
    case "tiktok-ads":
      return ["tiktok"];
    case "creative":
      return ["creative"];
    case "email":
    case "email-marketing":
      return ["email"];
    case "social":
    case "social-media":
      return ["social"];
    default:
      return [];
  }
}

/** Whether an exec with this focus hears about a line (no focus set: every line) */
export function execHears(line: string | null | undefined, focus: readonly string[]): boolean {
  if (!focus.length) return true;
  const ls = focusOfLine(line);
  // A line nobody owns (a teammate's reply with no client line) reaches every exec
  if (!ls.length) return true;
  // Creative production (tickets late past the design and video leads) is the creative exec's, not creative performance
  return ls.some((l) => focus.includes(l));
}

// ─── Motion: an account the team is already handling ───────────────────────

const DAY = 86_400_000;

/**
 * Something in motion on an account, done by people: a sprint started in the last 7 days or with one of its actions
 * done by a person in the last 7 days, or an audit a person ran in the last 14 days. The system's own work (a sprint's
 * automatic check, an automatic audit) isn't the team handling it.
 */
export function inMotion(o: { sprints: readonly { status: string; startedAt?: string | null; lastActionAt?: string | null }[]; audits: readonly { createdAt: string; auto?: boolean | null }[] }, now = new Date()): string | null {
  const t = now.getTime();
  const s = o.sprints.find((x) => x.status === "active" && [x.lastActionAt, x.startedAt].some((d) => d && t - Date.parse(d) <= 7 * DAY));
  if (s) return "A sprint is running";
  const a = o.audits.find((x) => !x.auto && t - Date.parse(x.createdAt) <= 14 * DAY);
  if (a) return "Audited in the last 2 weeks";
  return null;
}
