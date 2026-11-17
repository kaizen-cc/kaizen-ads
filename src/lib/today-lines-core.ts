import type { TodayDraft } from "@/lib/today";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { LINE_SEAT_ROLES, EARLY_DAYS, QUIET_AFTER, moneyShort, pctText, type Line } from "@/lib/channel-kpis/calc";
import { lineOfTeam } from "@/lib/roles";
import { providerName } from "@/lib/email-providers/core";

// The email and organic social side of the daily recap, as plain functions (no database), so who gets what and how it
// is ordered is tested on its own. src/lib/today-lines.ts reads the rows and hands them here.
//
// Who gets which line:
//   an exec          both lines, every client that buys them
//   the line's head  their line, every client that buys it (plus whatever is theirs personally, like a report they own)
//   anyone else      a line only where they hold one of its seats (an email strategist, a social media manager, or an
//                    ads person who also holds one), only those clients, and only the kinds of item their seat acts on
// Nothing here is about ads: no ad accounts, allotments or buyer alerts.

export type LineKind =
  | "email-score"
  | "email-pace"
  | "email-quiet"
  | "email-connect"
  | "email-audit"
  | "email-sprint"
  | "email-idea"
  | "email-location"
  | "email-ticket"
  | "social-target"
  | "social-drop"
  | "social-quiet"
  | "social-connect";

/** Which seats each kind of item needs (a seat holder sees a kind only when they hold one of these on the client) */
export const KIND_SEATS: Record<LineKind, readonly string[]> = {
  "email-score": ["email_strategist"],
  "email-pace": ["email_strategist"],
  "email-quiet": ["email_strategist", "email_builder"],
  "email-connect": ["email_strategist"],
  "email-audit": ["email_strategist"],
  "email-sprint": ["email_strategist", "email_designer", "email_builder"],
  "email-idea": ["email_strategist", "email_designer"],
  "email-location": ["email_strategist"],
  "email-ticket": ["email_strategist", "email_designer", "email_builder"],
  "social-target": ["social_manager"],
  "social-drop": ["social_manager"],
  "social-quiet": ["social_manager", "social_creative"],
  "social-connect": ["social_manager"],
};

/** The seats that look after who gets our emails on a client (a client's request to change it waits on one of them) */
export const CONTACT_SEATS: readonly string[] = ["coordinator", "email_strategist", "social_manager", "meta_buyer", "google_buyer"];

export type Person = { id: string; role: string; isExec: boolean; isCoordinator?: boolean };
export type Seat = { client_id: string; role: string };

/** One line of a person's day: every client on it (all), or the clients they're seated on with the seats they hold */
export type LineScope = { line: Line; all: boolean; seats: Map<string, string[]> };

const HEAD_OF: Record<Line, string> = { email: "head_of_email", social: "head_of_social" };
export const isLineHead = (me: Pick<Person, "role">, line: Line) => me.role === HEAD_OF[line];

/** The lines this person's day covers and which clients on each (see the top of the file) */
export function lineScopes(me: Person, seats: Seat[]): LineScope[] {
  const out: LineScope[] = [];
  for (const line of ["email", "social"] as Line[]) {
    if (me.isExec || isLineHead(me, line)) {
      out.push({ line, all: true, seats: seatMap(seats, line) });
      continue;
    }
    const mine = seatMap(seats, line);
    if (mine.size) out.push({ line, all: false, seats: mine });
  }
  return out;
}

function seatMap(seats: Seat[], line: Line): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of seats) if (LINE_SEAT_ROLES[line].includes(s.role)) m.set(s.client_id, [...(m.get(s.client_id) ?? []), s.role]);
  return m;
}

/** The client ids to read for a line: null for every client on it */
export const scopeIds = (s: LineScope): string[] | null => (s.all ? null : [...s.seats.keys()]);

/** Whether an item of this kind on this client is for this person */
export function needsMe(scope: LineScope, kind: LineKind, clientId: string): boolean {
  if (scope.all) return true;
  return (scope.seats.get(clientId) ?? []).some((r) => KIND_SEATS[kind].includes(r));
}

/** Whether a client's contact change request is this person's to confirm */
export function contactIsMine(me: Person, seatsOnClient: readonly string[], lineHeadOfClient: boolean): boolean {
  return me.isExec || Boolean(me.isCoordinator) || lineHeadOfClient || seatsOnClient.some((r) => CONTACT_SEATS.includes(r));
}

/** Whether this person opens a line's board (/kpis on that line): execs, leads and the line's own team; anyone else goes to the client page */
export const opensBoard = (me: { role: string; isExec: boolean; isLead?: boolean }, line: Line) => me.isExec || Boolean(me.isLead) || lineOfTeam(me.role) === line;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const LABEL: Record<Line, string> = { email: "Email", social: "Social" };

type RowCtx = {
  /** Day of the month (the pace isn't judged in the first few days) */
  dayOfMonth: number;
  /** Where the line's board opens for this person, else the client page */
  board: boolean;
};

const hrefs = (r: Pick<ChannelRow, "line" | "clientId" | "slug">, board: boolean) => {
  const client = `/clients/${r.slug}?service=${r.line}`;
  return { main: board ? `/kpis?p=${r.line}&open=${r.clientId}` : client, client };
};

const base = (r: ChannelRow, line: Line) => ({ topic: line, client: r.name, clientSlug: r.slug, clientId: r.clientId, evidence: [] as string[] });

/** An email client's own items: its score, its pace, its sends and its connection */
export function emailRowItems(r: ChannelRow, ctx: RowCtx): (TodayDraft & { kind: LineKind })[] {
  const out: (TodayDraft & { kind: LineKind })[] = [];
  const h = hrefs(r, ctx.board);
  const b = base(r, "email");
  const source = r.provider ? providerName(r.provider) : "their email provider";
  if (r.data === "failing" || r.data === "missing") {
    const failing = r.data === "failing";
    out.push({
      ...b,
      kind: "email-connect",
      key: `email-connect:${r.clientId}`,
      score: failing ? 76 : 60,
      stat: { value: failing ? "Failing" : "Not set up", label: failing ? `reading ${source}` : "no email numbers yet" },
      title: failing ? `${r.name}'s email numbers stopped coming in` : `${r.name} has no email provider connected`,
      story: failing
        ? `${r.problem?.message ?? `${source} refused the last read.`} Until it's fixed the score, the board and their report can't see what's happening.${r.problem?.fix ? ` ${r.problem.fix}` : ""}`
        : "They buy Email Marketing, but nothing is connected, so there's no score, no board and no report for them. Paste their Klaviyo, Brevo or Customer.io key in Team & setup.",
      why: failing ? "We can't see their numbers" : "Not measured yet",
      action: { label: failing ? "Fix the connection" : "Connect it", href: `/clients/${r.slug}?tab=team` },
      alt: { label: "Email board", href: h.main },
    });
    return out;
  }
  if (r.score && r.score.band !== "good") {
    const red = r.score.band === "bad";
    const drag = r.score.weighingDown.slice(0, 2).map((c) => c.label);
    out.push({
      ...b,
      kind: "email-score",
      key: `email-score:${r.clientId}`,
      score: red ? clamp(70 + (60 - r.score.score) / 3, 70, 90) : clamp(54 + (80 - r.score.score) / 3, 54, 62),
      stat: { value: String(r.score.score), label: red ? "email score, in the red" : "email score, yellow" },
      title: `${r.name}'s email account is ${red ? "in the red" : "slipping"}`,
      story: `Their email score is ${r.score.score} out of 100.${drag.length ? ` ${drag.join(" and ")} ${drag.length === 1 ? "is" : "are"} costing the most.` : ""}${red ? " A red account audits itself and opens a sprint; the moves still need doing." : ""}`,
      why: red ? "A red email account is a client at risk" : "Heading the wrong way",
      evidence: drag.length ? [`Biggest drag: ${drag[0]}`] : [],
      action: { label: "Open on the Email board", href: h.main },
      alt: { label: "Client page", href: h.client },
    });
  }
  const t = r.target ?? null;
  if (r.revenueMeasured !== false && t && t > 0 && r.projected != null && ctx.dayOfMonth > EARLY_DAYS) {
    const ratio = r.projected / t;
    if (ratio < 0.85)
      out.push({
        ...b,
        kind: "email-pace",
        key: `email-pace:${r.clientId}`,
        score: clamp(58 + (1 - ratio) * 40, 58, 78),
        stat: { value: `${Math.round((1 - ratio) * 100)}%`, label: "behind this month's revenue goal" },
        title: `${r.name}'s email revenue is behind pace`,
        story: `At this pace the month lands near ${moneyShort(r.projected, r.currency)} against a ${moneyShort(t, r.currency)} goal (${moneyShort(r.value ?? 0, r.currency)} so far).`,
        why: "Revenue behind where it should be",
        action: { label: "Open on the Email board", href: h.main },
        alt: { label: "Client page", href: h.client },
      });
  }
  if (r.quietDays != null && r.quietDays >= QUIET_AFTER.email)
    out.push({
      ...b,
      kind: "email-quiet",
      key: `email-quiet:${r.clientId}`,
      score: clamp(62 + (r.quietDays - QUIET_AFTER.email), 62, 78),
      stat: { value: String(r.quietDays), label: "days since their last campaign" },
      title: `No campaign has gone to ${r.name}'s list in ${r.quietDays} days`,
      story: r.email?.lastSendAt ? `The last one went out ${day(r.email.lastSendAt)}. A quiet list costs revenue and makes the client wonder what they're paying for.` : "Nothing has gone out in the last 60 days. A quiet list costs revenue and makes the client wonder what they're paying for.",
      why: "A quiet list is a client at risk",
      action: { label: "Open on the Email board", href: h.main },
      alt: { label: "Client page", href: h.client },
    });
  return out;
}

/** A social client's own items: off target, engagement dropping, no posts, and the link to Meta */
export function socialRowItems(r: ChannelRow, ctx: RowCtx): (TodayDraft & { kind: LineKind })[] {
  const out: (TodayDraft & { kind: LineKind })[] = [];
  const h = hrefs(r, ctx.board);
  const b = base(r, "social");
  if (r.data === "failing" || r.data === "missing") {
    const failing = r.data === "failing";
    out.push({
      ...b,
      kind: "social-connect",
      key: `social-connect:${r.clientId}`,
      score: failing ? 74 : 58,
      stat: { value: failing ? "Failing" : "Not linked", label: failing ? "reading their Page and Instagram" : "no social numbers yet" },
      title: failing ? `${r.name}'s social numbers stopped coming in` : `${r.name}'s Page and Instagram aren't linked`,
      story: failing ? `${r.problem?.message ?? "Meta refused the last read."}${r.problem?.fix ? ` ${r.problem.fix}` : ""}` : "They buy Social Media, but no Page or Instagram account is linked, so there's no board and no report for them. Pick them on the client's Social tab.",
      why: failing ? "We can't see their numbers" : "Not measured yet",
      action: { label: failing ? "Fix it" : "Link them", href: h.client },
      alt: { label: "Social board", href: h.main },
    });
    return out;
  }
  if (r.status === "off" || r.status === "close") {
    const off = r.status === "off";
    const gap = r.ratio != null ? 1 - r.ratio : null;
    out.push({
      ...b,
      kind: "social-target",
      key: `social-target:${r.clientId}`,
      score: off ? clamp(66 + (gap ?? 0) * 30, 66, 84) : 52,
      stat: { value: pctText(r.value), label: `engagement against a ${pctText(r.target)} target` },
      title: `${r.name}'s social engagement is ${off ? "off" : "close to"} target`,
      story: `Engagement is ${pctText(r.value)} ${r.basis === "month" ? "this month" : "over the last 30 days"}, against a ${pctText(r.target)} target.${r.social?.posts != null ? ` ${r.social.posts} ${r.social.posts === 1 ? "post" : "posts"} in that time.` : ""}`,
      why: off ? "Off its social target" : "Close to its target",
      action: { label: "Open on the Social board", href: h.main },
      alt: { label: "Client page", href: h.client },
    });
  }
  if (r.value != null && r.prev != null && r.prev > 0 && r.value < r.prev * 0.75 && r.status !== "off") {
    const drop = 1 - r.value / r.prev;
    out.push({
      ...b,
      kind: "social-drop",
      key: `social-drop:${r.clientId}`,
      score: clamp(54 + drop * 30, 54, 70),
      stat: { value: `${Math.round(drop * 100)}%`, label: "less engagement than last month" },
      title: `${r.name}'s engagement dropped`,
      story: `Down to ${pctText(r.value)} from ${pctText(r.prev)} last month.${r.social?.topPost?.caption ? ` Their best post lately: "${r.social.topPost.caption.replace(/\s+/g, " ").slice(0, 90)}".` : ""}`,
      why: "Engagement falling",
      action: { label: "Open on the Social board", href: h.main },
      alt: { label: "Client page", href: h.client },
    });
  }
  if (r.quietDays != null && r.quietDays >= QUIET_AFTER.social)
    out.push({
      ...b,
      kind: "social-quiet",
      key: `social-quiet:${r.clientId}`,
      score: clamp(60 + (r.quietDays - QUIET_AFTER.social) * 2, 60, 80),
      stat: { value: String(r.quietDays), label: "days since their last post" },
      title: `Nothing posted for ${r.name} in ${r.quietDays} days`,
      story: r.social?.lastPostAt ? `The last post went up ${day(r.social.lastPostAt)}. A quiet feed is the first thing a client notices.` : "No post in the last 45 days. A quiet feed is the first thing a client notices.",
      why: "A quiet feed is a client at risk",
      action: { label: "Open on the Social board", href: h.main },
      alt: { label: "Client page", href: h.client },
    });
  return out;
}

export type AuditIn = { id: string; status: "running" | "ready" | "failed"; score: number | null; band: "good" | "watch" | "bad" | null; headline: string | null; createdAt: string; actions: number; done: number };
export type SprintIn = { id: string; moves: number; done: number; nextCheckAt: string; score: number | null; baseline: number | null };

/** An email client's audit and sprint: an audit whose moves nobody started, one that didn't finish, a sprint whose moves aren't happening */
export function emailOpsItems(c: { clientId: string; name: string; slug: string }, audit: AuditIn | null, sprint: SprintIn | null, now = new Date()): (TodayDraft & { kind: LineKind })[] {
  const out: (TodayDraft & { kind: LineKind })[] = [];
  const b = { topic: "email" as const, client: c.name, clientSlug: c.slug, clientId: c.clientId, evidence: [] as string[] };
  const days = (iso: string) => Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  if (sprint && sprint.moves > 0 && sprint.done < sprint.moves && Date.parse(sprint.nextCheckAt) <= now.getTime()) {
    out.push({
      ...b,
      kind: "email-sprint",
      key: `email-sprint:${sprint.id}`,
      score: sprint.done === 0 ? 68 : 60,
      stat: { value: `${sprint.done}/${sprint.moves}`, label: "sprint moves done" },
      title: `${c.name}'s email sprint is due a check with moves still open`,
      story: `${sprint.done} of ${sprint.moves} moves are done and the check was due ${day(sprint.nextCheckAt)}.${sprint.baseline != null && sprint.score != null ? ` The score went from ${sprint.baseline} to ${sprint.score}.` : ""} The score only moves when the moves happen.`,
      why: sprint.done === 0 ? "No sprint move has happened" : "Moves not happening",
      action: { label: "Open the sprint", href: `/kpis/email-sprint/${sprint.id}` },
      alt: { label: "Client page", href: `/clients/${c.slug}?service=email` },
    });
    return out;
  }
  if (!audit || sprint) return out;
  if (audit.status === "failed" && days(audit.createdAt) <= 14)
    out.push({
      ...b,
      kind: "email-audit",
      key: `email-audit:${audit.id}`,
      score: 56,
      stat: { value: "Failed", label: `audit from ${day(audit.createdAt)}` },
      title: `${c.name}'s email audit didn't finish`,
      story: "Run it again from the client's Email tab. Until it finishes there's no plan for the account.",
      why: "No plan for the account",
      action: { label: "Open the audit", href: `/kpis/email-audit/${audit.id}` },
      alt: { label: "Client page", href: `/clients/${c.slug}?service=email` },
    });
  else if (audit.status === "ready" && audit.band && audit.band !== "good" && audit.actions > 0 && audit.done === 0 && days(audit.createdAt) >= 2)
    out.push({
      ...b,
      kind: "email-audit",
      key: `email-audit:${audit.id}`,
      score: audit.band === "bad" ? 70 : 58,
      stat: { value: String(days(audit.createdAt)), label: "days since the audit, no move started" },
      title: `${c.name}'s email audit is waiting on its first move`,
      story: `${audit.headline ? `${audit.headline} ` : ""}${audit.actions} ${audit.actions === 1 ? "move" : "moves"} in the plan, none ticked yet. Start a sprint to put them in motion.`,
      why: audit.band === "bad" ? "A red account with a plan nobody started" : "A plan nobody started",
      action: { label: "Open the audit", href: `/kpis/email-audit/${audit.id}` },
      alt: { label: "Client page", href: `/clients/${c.slug}?service=email` },
    });
  return out;
}

export type IdeaIn = { id: string; title: string; idea: string; why: string | null; sendOn: string | null };

/** Campaign ideas waiting on someone, one item per client (the soonest first): ideas, never alarms */
export function ideaItem(c: { clientId: string; name: string; slug: string }, ideas: IdeaIn[], today: string): (TodayDraft & { kind: LineKind }) | null {
  if (!ideas.length) return null;
  const sorted = [...ideas].sort((a, b) => (a.sendOn ?? "9999").localeCompare(b.sendOn ?? "9999"));
  const top = sorted[0];
  const soon = Boolean(top.sendOn && top.sendOn >= today && Date.parse(`${top.sendOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`) <= 7 * 86_400_000);
  return {
    topic: "email",
    client: c.name,
    clientSlug: c.slug,
    clientId: c.clientId,
    kind: "email-idea",
    key: `email-idea:${c.clientId}`,
    score: soon ? 56 : 50,
    stat: ideas.length > 1 ? { value: String(ideas.length), label: "campaign ideas waiting" } : { value: top.sendOn ? day(top.sendOn) : "Idea", label: top.sendOn ? "suggested send day" : "a campaign idea" },
    title: top.title,
    story: `${top.idea.replace(/\s+/g, " ").slice(0, 220)}${top.idea.length > 220 ? "…" : ""}`,
    why: soon ? "Its send day is this week" : "An idea for this client",
    evidence: sorted.slice(1, 3).map((i) => i.title),
    action: { label: "See the ideas", href: `/clients/${c.slug}?service=email` },
  };
}

export type ReportIn = { id: string; clientId: string; client: string; slug: string; line: Line; kind: string; status: string; ownerId: string | null; periodEnd: string; viewedAt: string | null };

/**
 * A channel report nobody has sent: its owner's always (theirs to send), and for the line's head and the execs anyone's
 * once it's a few days past its period (someone isn't sending it).
 */
export function reportItem(r: ReportIn, me: Person, scope: LineScope, today: string): TodayDraft | null {
  const mine = r.ownerId === me.id;
  const late = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r.periodEnd}T12:00:00Z`)) / 86_400_000) - 1);
  if (!mine && !(scope.all && late >= 3)) return null;
  const monthly = r.kind === "monthly";
  const failed = r.status === "failed";
  const what = monthly ? "monthly" : r.kind === "weekly" ? "weekly" : "";
  const score = failed ? 72 : monthly ? clamp(62 + late * 3, 62, 84) : clamp(56 + late * 4, 56, 80);
  return {
    topic: r.line,
    client: r.client,
    clientSlug: r.slug,
    clientId: r.clientId,
    key: `report:${r.id}`,
    score: mine ? score : Math.min(score, 70),
    stat: late ? { value: String(late), label: `${late === 1 ? "day" : "days"} since the period ended` } : { value: "Ready", label: "drafted and checked" },
    title: failed ? `${r.client}'s ${LABEL[r.line].toLowerCase()} ${what ? `${what} ` : ""}report didn't draft` : `${r.client}'s ${LABEL[r.line].toLowerCase()} ${what ? `${what} ` : ""}report is ready to send`,
    story: failed
      ? "Drafting it failed. Open it to try again, or write it from the numbers."
      : `It's drafted and checked${r.viewedAt ? "" : ", and nobody has opened it yet"}. ${monthly ? "Read it over and save it to the client's Drive." : "Read it over and send it."}${mine ? "" : " Its owner hasn't sent it."}`,
    why: mine ? (late >= 3 ? "Late going to the client" : "Yours to send") : "Not sent by its owner",
    evidence: [],
    action: { label: "Open the report", href: `/reports/${r.id}` },
    ...(mine ? { dismiss: "Already sent, or not needed" } : {}),
  };
}

export type ContactIn = { id: string; clientId: string; client: string; slug: string; fromName: string | null; fromEmail: string; receivedAt: string; quote: string | null; why: string | null; pending: number };

/** A client asked to change who gets our emails and it waits on us to confirm: the client asked, so it's on us */
export function contactItem(c: ContactIn, now = new Date()): TodayDraft {
  const waited = Math.max(0, Math.floor((now.getTime() - Date.parse(c.receivedAt)) / 86_400_000));
  return {
    topic: "promises",
    client: c.client,
    clientSlug: c.slug,
    clientId: c.clientId,
    key: `contact:${c.id}`,
    score: clamp(70 + waited * 3, 70, 86),
    stat: waited ? { value: String(waited), label: `${waited === 1 ? "day" : "days"} waiting on us to confirm` } : { value: "New", label: "waiting on us to confirm" },
    title: `${c.fromName ?? c.fromEmail} asked to change who gets our emails`,
    story: `${c.quote ? `"${c.quote.replace(/\s+/g, " ").slice(0, 200)}${c.quote.length > 200 ? "…" : ""}" ` : ""}${c.pending} ${c.pending === 1 ? "change waits" : "changes wait"} for someone to confirm${c.why ? ` (not applied on its own: ${c.why})` : ""}.`,
    why: "The client asked us for it",
    evidence: [],
    action: { label: "Confirm it", href: `/clients/${c.slug}?tab=team` },
  };
}

/** A multi-location email client with no location property picked: the report's location section is empty */
export function locationItem(c: { clientId: string; name: string; slug: string }): TodayDraft & { kind: LineKind } {
  return {
    topic: "email",
    client: c.name,
    clientSlug: c.slug,
    clientId: c.clientId,
    kind: "email-location",
    key: `email-location:${c.clientId}`,
    score: 52,
    stat: { value: "Locations", label: "no property picked" },
    title: `${c.name}'s location breakdown has nothing to read`,
    story: "The breakdown by location is on, but no event property is picked for the location, so the report's last section stays empty. Pick it on the Email board's account sheet.",
    why: "Their report is missing a section",
    evidence: [],
    action: { label: "Pick the property", href: `/kpis?p=email&open=${c.clientId}` },
    alt: { label: "Client page", href: `/clients/${c.slug}?service=email` },
  };
}

export type EmailTicketIn = { id: string; number: number; title: string; clientId: string; client: string; slug: string; stage: string; stageLabel: string; assigneeId: string | null; minutesOver: number; dueOn: string | null };

/**
 * Email Board tickets in someone's day: their own (assigned to them) when late, due today or past due, or waiting on
 * them to move it on; for an exec or the Head of Email, anyone's that are 12+ business hours over or past their send
 * day. With the client, a ticket waits on the client, not on us, so it only shows once its send day has passed.
 */
export function emailTicketItems(tickets: readonly EmailTicketIn[], me: Pick<Person, "id">, scope: LineScope, today: string): (TodayDraft & { kind: LineKind })[] {
  const out: (TodayDraft & { kind: LineKind })[] = [];
  for (const t of tickets) {
    const mine = t.assigneeId === me.id;
    const late = t.minutesOver > 12 * 60;
    const over = t.minutesOver > 0;
    const pastDue = Boolean(t.dueOn && t.dueOn < today);
    const dueToday = t.dueOn === today;
    const withClient = t.stage === "with_client";
    if (withClient && !pastDue) continue;
    if (mine ? !(over || pastDue || dueToday) : !(scope.all && (late || pastDue))) continue;
    const score = pastDue ? 78 : late ? 72 : dueToday ? 66 : 60;
    out.push({
      topic: "email",
      client: t.client,
      clientSlug: t.slug,
      clientId: t.clientId,
      kind: "email-ticket",
      key: `email-ticket:${t.id}`,
      score,
      stat: pastDue ? { value: day(t.dueOn!), label: "send day passed" } : dueToday ? { value: "Today", label: "sends or goes live" } : { value: `${Math.round(t.minutesOver / 60)}h`, label: "over its turnaround" },
      title: `E-${t.number} ${t.title}`,
      story: `${mine ? "Waiting on you" : "Sitting"} in ${t.stageLabel}${pastDue ? `, and its send day (${day(t.dueOn!)}) has passed` : dueToday ? ", and it should go out today" : ""}.`,
      why: pastDue ? "An email that should already be out" : late ? "Past its turnaround" : dueToday ? "Goes out today" : "Waiting on you",
      evidence: [],
      action: { label: "Open the ticket", href: `/board/email?t=${t.number}` },
      alt: { label: "Client page", href: `/clients/${t.slug}?service=email` },
    });
  }
  return out;
}

// ─── Ordering by retention risk ────────────────────────────────────────────

/** Items that are ideas, never alarms: they don't climb with their client's other trouble */
const CALM = ["brief:", "email-idea:"];

/**
 * The day ordered by how likely each client is to leave: a client in trouble on more than one front (an ad account off
 * target and a red email account, a promise late and a quiet feed) is a bigger risk than either alone, so each of its
 * pressing items climbs a little (3 points for each other front, up to 6). Ideas stay where they are. Sorted most
 * pressing first. Pure: the same items in, the same order out.
 */
export function byRetention<T extends Pick<TodayDraft, "key" | "topic" | "score" | "client" | "clientId">>(items: T[]): T[] {
  const who = (i: T) => i.clientId ?? (i.client ?? "").trim().toLowerCase();
  const fronts = new Map<string, Set<string>>();
  for (const i of items) {
    if (i.score < 60 || CALM.some((k) => i.key.startsWith(k)) || !who(i) || who(i) === "team") continue;
    const k = who(i);
    fronts.set(k, (fronts.get(k) ?? new Set()).add(i.topic));
  }
  return items
    .map((i) => {
      const n = fronts.get(who(i))?.size ?? 0;
      if (n < 2 || i.score < 60 || CALM.some((k) => i.key.startsWith(k))) return i;
      return { ...i, score: Math.min(98, i.score + Math.min(6, 3 * (n - 1))) };
    })
    .sort((a, b) => b.score - a.score);
}
