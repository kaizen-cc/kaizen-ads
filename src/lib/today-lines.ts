import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { TodayDraft } from "@/lib/today";
import { loadChannelBoard } from "@/lib/channel-kpis/load";
import { etToday, monthOf, SERVICE, type Line } from "@/lib/channel-kpis/calc";
import { activeSprints, latestAudits, loadSuggestions } from "@/lib/email-ops/load";
import { locationPropsOf } from "@/lib/klaviyo/locations";
import { isLive } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { PAUSE_SERVICE } from "@/lib/account-watch/pauses-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  contactIsMine,
  contactItem,
  emailOpsItems,
  emailRowItems,
  emailTicketItems,
  ideaItem,
  isLineHead,
  lineScopes,
  locationItem,
  needsMe,
  opensBoard,
  reportItem,
  scopeIds,
  socialRowItems,
  type LineKind,
  type LineScope,
  type EmailTicketIn,
  type ReportIn,
  type Seat,
} from "@/lib/today-lines-core";

// The email and organic social part of the daily recap: the same kinds of points the ads side has (accounts at risk,
// reports to send, plans not moving, ideas, what the client asked for), for the people on those lines. Who gets which
// line and which clients is src/lib/today-lines-core.ts. Each line is read in parallel, a handful of queries per line
// whatever the number of clients, all through the person's own session (RLS) except the email connection's location
// setting, which only the server reads.

type Kinded = TodayDraft & { kind: LineKind };
const plain = (d: Kinded): TodayDraft => {
  const o: Partial<Kinded> = { ...d };
  delete o.kind;
  return o as TodayDraft;
};

const PLATFORM: Record<Line, string> = { email: "klaviyo", social: "social" };

/** Reports on a line nobody has sent, from the last 40 days (the in-scope clients are picked after) */
async function openReports(db: SupabaseClient, line: Line): Promise<ReportIn[]> {
  const since = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await db
    .from("reports")
    .select("id, client_id, kind, status, owner_id, period_end, viewed_at, clients(name, slug)")
    .eq("platform", PLATFORM[line])
    .in("status", ["draft", "failed"])
    .is("target_id", null)
    .is("hidden_at", null)
    .gte("period_end", since)
    .order("period_end")
    .limit(400);
  if (error) return [];
  return (data ?? []).map((r) => {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    return { id: r.id as string, clientId: r.client_id as string, client: c?.name ?? "Client", slug: c?.slug ?? "", line, kind: r.kind as string, status: r.status as string, ownerId: (r.owner_id as string | null) ?? null, periodEnd: r.period_end as string, viewedAt: (r.viewed_at as string | null) ?? null };
  });
}

/** Multi-location email clients with no location property picked (read with the server's rights, like the board's connection) */
async function locationGaps(ids: string[]): Promise<Set<string>> {
  if (!ids.length || !adminConfigured()) return new Set();
  const { data, error } = await createAdminClient().from("klaviyo_connections").select("client_id, location_props").in("client_id", ids).eq("multi_location", true);
  if (error) return new Set();
  return new Set((data ?? []).filter((c) => !Object.keys(locationPropsOf(c.location_props)).length).map((c) => c.client_id as string));
}

/** The Email Board's open tickets on these clients (empty before the board's tables exist) */
async function emailTickets(db: SupabaseClient, ids: string[]): Promise<EmailTicketIn[]> {
  const { emailStageInfo } = await import("@/lib/email-board-core");
  const { data, error } = await db.from("email_board").select("id, number, title, client_id, client_name, client_slug, stage, assignee_id, minutes_over, due_on").in("client_id", ids).neq("stage", "live").limit(400);
  if (error) return [];
  return (data ?? []).map((t) => ({
    id: t.id as string,
    number: t.number as number,
    title: t.title as string,
    clientId: t.client_id as string,
    client: (t.client_name as string) ?? "Client",
    slug: (t.client_slug as string) ?? "",
    stage: t.stage as string,
    stageLabel: emailStageInfo(t.stage as Parameters<typeof emailStageInfo>[0]).label,
    assigneeId: (t.assignee_id as string | null) ?? null,
    minutesOver: (t.minutes_over as number) ?? 0,
    dueOn: (t.due_on as string | null) ?? null,
  }));
}

/** One line's items for this person */
async function lineItems(db: SupabaseClient, me: Staff, s: LineScope, today: string, dayOfMonth: number): Promise<TodayDraft[]> {
  const [board, reports] = await Promise.all([loadChannelBoard(db, s.line, me, scopeIds(s)).catch(() => null), openReports(db, s.line).catch(() => [] as ReportIn[])]);
  const rows = (board?.rows ?? []).filter((r) => s.all || s.seats.has(r.clientId));
  const out: TodayDraft[] = [];
  const keep = (d: Kinded | null) => {
    if (d && d.clientId && needsMe(s, d.kind, d.clientId)) out.push(plain(d));
  };
  const ctx = { dayOfMonth, board: opensBoard(me, s.line) };
  for (const r of rows) (s.line === "email" ? emailRowItems(r, ctx) : socialRowItems(r, ctx)).forEach(keep);

  // A lead or exec may pause the line for a client right from the item ("Paused: hide until...")
  const pausable = me.isExec || me.isLead;
  const ids = rows.map((r) => r.clientId);
  const inScope = new Set(ids);
  for (const r of reports) {
    if (!inScope.has(r.clientId)) continue;
    const d = reportItem(r, me, s, today);
    if (d) out.push(d);
  }

  if (s.line === "email" && ids.length) {
    const [audits, sprints, ideas, gaps] = await Promise.all([
      latestAudits(db, ids).catch(() => new Map()),
      activeSprints(db, ids).catch(() => new Map()),
      loadSuggestions(db, ids, Math.max(60, ids.length * 4)).catch(() => []),
      locationGaps(ids).catch(() => new Set<string>()),
    ]);
    // Email Board tickets: each person's own when they're late or due, the line head's and execs' when they're well over
    const tickets = await emailTickets(db, ids).catch(() => [] as EmailTicketIn[]);
    for (const d of emailTicketItems(tickets, me, s, today)) out.push(plain(d));
    for (const r of rows) {
      const c = { clientId: r.clientId, name: r.name, slug: r.slug };
      emailOpsItems(c, audits.get(r.clientId) ?? null, sprints.get(r.clientId) ?? null).forEach(keep);
      keep(ideaItem(c, ideas.filter((i) => i.clientId === r.clientId && i.status === "new"), today));
      if (gaps.has(r.clientId)) keep(locationItem(c));
    }
  }
  if (s.line === "social" && ids.length) {
    // The social audits and sprints, read the email way (src/lib/social-ops); quietly none before their migration
    const [audits, sprints] = await Promise.all([latestAudits(db, ids, "social").catch(() => new Map<string, never>()), activeSprints(db, ids, "social").catch(() => new Map<string, never>())]);
    for (const r of rows) emailOpsItems({ clientId: r.clientId, name: r.name, slug: r.slug }, audits.get(r.clientId) ?? null, sprints.get(r.clientId) ?? null, new Date(), "social").forEach(keep);
  }
  return pausable ? out.map((d) => (d.clientId && !d.pause ? { ...d, pause: { service: PAUSE_SERVICE[s.line] } } : d)) : out;
}

/** Clients' requests to change who gets our emails, waiting on us to confirm, for the people who look after them */
async function contactItems(db: SupabaseClient, me: Staff, seats: Seat[]): Promise<TodayDraft[]> {
  const { data, error } = await db
    .from("contact_change_requests")
    .select("id, client_id, from_name, from_email, received_at, quote, why, changes, clients(name, slug, status, archived_at, services, services_extra, services_removed, strategy_only)")
    .eq("status", "to_confirm")
    .order("received_at")
    .limit(60);
  if (error) return [];
  const seatsOn = new Map<string, string[]>();
  for (const s of seats) seatsOn.set(s.client_id, [...(seatsOn.get(s.client_id) ?? []), s.role]);
  const out: TodayDraft[] = [];
  for (const r of data ?? []) {
    const c = r.clients as unknown as { name: string; slug: string; status: string | null; archived_at: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null } | null;
    if (!c || !isLive(c) || !r.client_id) continue;
    const services = servicesOf(c) as string[];
    const head = (["email", "social"] as Line[]).some((l) => isLineHead(me, l) && services.includes(SERVICE[l]));
    if (!contactIsMine(me, seatsOn.get(r.client_id as string) ?? [], head)) continue;
    const changes = (r.changes ?? []) as { status?: string }[];
    out.push(
      contactItem({
        id: r.id as string,
        clientId: r.client_id as string,
        client: c.name,
        slug: c.slug,
        fromName: (r.from_name as string | null) ?? null,
        fromEmail: r.from_email as string,
        receivedAt: r.received_at as string,
        quote: (r.quote as string | null) ?? null,
        why: (r.why as string | null) ?? null,
        pending: changes.filter((x) => x.status === "pending").length || 1,
      }),
    );
  }
  return out;
}

/**
 * Everything on the email and social lines for this person today: each line they're on read in parallel, and the
 * contact changes waiting on them. Never throws: a line that can't be read leaves the rest of the day as it is.
 */
export async function gatherLines(db: SupabaseClient, me: Staff): Promise<TodayDraft[]> {
  const { data: seatRows } = await db.from("client_assignments").select("client_id, role").eq("profile_id", me.id);
  const seats = (seatRows ?? []) as Seat[];
  const scopes = lineScopes(me, seats);
  const today = etToday();
  const { dayOfMonth } = monthOf(today);
  const [lines, contacts] = await Promise.all([Promise.all(scopes.map((s) => lineItems(db, me, s, today, dayOfMonth).catch(() => [] as TodayDraft[]))), contactItems(db, me, seats).catch(() => [] as TodayDraft[])]);
  return [...lines.flat(), ...contacts];
}
