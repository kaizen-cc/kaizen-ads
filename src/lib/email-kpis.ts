import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleDays, verdictOf, type Headline, type Period, type Sendbacks, type TaskRef, type Tone } from "@/lib/creative-kpis";
import { emailStageInfo, handle, pickSeat, type EmailStage, type Route, type SeatRow } from "@/lib/email-board-core";
import type { EmailHistory, EmailTaskComment } from "@/lib/asana-email";
import { isEmailRole, roleLabel, type TeamRole } from "@/lib/roles";
import { matchPerson, membersOf, pct, replyStats, reportTimeliness, REQUEST_LEAD_DAYS, requestTimeliness, syncOf, teamOf, trendOf } from "@/lib/team-kpis-core";
import type { EmailErrorItem } from "@/lib/email-errors";
import { servicesOf } from "@/lib/services";
import { cleanTitle } from "@/lib/task-title";
import {
  baselines,
  BUILD_TARGET,
  buildPasses,
  buildReturns,
  holdTimes,
  isBottleneck,
  STRATEGIST_STAGES,
  CADENCE_ORDER,
  cadenceStatus,
  clientRounds,
  copyApprovals,
  countVerdict,
  DESIGN_TARGET,
  designerAt,
  designPasses,
  firstPasses,
  flowTrend,
  hitRate,
  isEmail,
  judge,
  LEVEL,
  liftOf,
  mean,
  metDue,
  pctOf,
  phaseOfColumn,
  pushes,
  r1,
  revisionTurns,
  scoreOf,
  sendbacksOf,
  severityOf,
  sittingDays,
  stintsOf,
  styleResults,
  toClient,
  writerAt,
  type CadenceStatus,
  type Phase,
  type Piece,
  type Sent,
  type Verdict,
} from "@/lib/email-kpis-core";

// The email team's KPIs for execs and the Head of Email, on the Email Board's two KPI tabs, built the way the creative
// team's are: Email design KPIs (speed, quality and volume against the period before, each designer's card and sheet,
// each client's sending pace this cycle, what's late, where changes come from, and the emails themselves: designs that
// out-click their account to build on and flows whose clicks are tiring) and Email copy KPIs (copy for review to
// approved, how often the AI's copy goes through first time, rewrites, each strategist, and subject lines judged on
// opens). Production comes from the Email Board's own history and, while the team moves over, the Asana email board's
// (moves, reassignments, due dates and comments); results from each client's email platform, each email against its
// own account's usual numbers.

const now = () => new Date().toISOString();
const ymdNY = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const fmtDay = (x: string) => new Date(x.length === 10 ? `${x}T12:00:00` : x).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const tone = (v: number | null, ok: (x: number) => boolean, warn: (x: number) => boolean): Tone => (v == null ? null : ok(v) ? "ok" : warn(v) ? "warn" : "bad");
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct1 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 10);
const pct2 = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 100);
const klaviyoUrl = (id: string) => `https://www.klaviyo.com/campaign/${encodeURIComponent(id)}/reports`;

export type EmailAction = { key: string; tone: "bad" | "warn"; title: string; detail: string; href: string };
export type LateTicket = { id: string; number: number; title: string; urgent: boolean; client: string; stage: string; hoursOver: number; assignee: string | null; due: string | null; kind: string; messages: number };

/** A real problem the AI's design review pinned before anyone else saw it */
export type FixItem = { id: string; quote: string; client: string | null; ticket: number | null; message: string | null; at: string };

/** A sent email, judged against its own account's usual numbers */
export type EmailResult = {
  key: string;
  clientId: string;
  client: string;
  slug: string;
  name: string;
  subject: string | null;
  preview: string | null;
  sent: string | null;
  recipients: number;
  openRate: number | null; // %
  clickRate: number | null; // %
  revenue: number;
  rpr: number | null; // revenue per recipient
  usualOpen: number | null; // %
  usualClick: number | null; // %
  clickLift: number | null; // % above or below their usual
  openLift: number | null;
  verdict: Verdict | null;
  image: string | null;
  href: string | null;
  /** linked: the Email Board ticket it came from; seat: the client's email designer (or strategist) at the time */
  how: "linked" | "seat";
  credit: string | null;
  creditId: string | null;
  ticket: number | null;
};

export type EmailMaker = {
  profileId: string;
  name: string;
  role: string;
  roleKey: "email_designer" | "email_builder" | "other";
  score: number | null;
  previous: number | null;
  level: string;
  pieces: number;
  turnaround: number | null;
  turnaroundTarget: number;
  firstPass: number | null;
  revisionTurnaround: number | null;
  onTime: number | null;
  sitting: number;
  open: number;
  late: number;
  messages: number;
  act: string | null;
  plate: TaskRef[];
  revisions: TaskRef[];
  sendbacks: { d45: Sendbacks; d90: Sendbacks };
  fixes: { d45: number; d90: number; items: FixItem[] };
  /** Real errors read from comments on their work (Asana and the Email Board), last 90 days */
  errors: { d45: number; d90: number; items: EmailErrorItem[] };
  briefToDone: number | null;
  metDue: { pct: number | null; of: number; missed: TaskRef[] };
  pushedBack: { pct: number | null; of: number; items: TaskRef[] };
  winners: EmailResult[];
};

export type Cadence = {
  id: string;
  name: string;
  slug: string;
  sent: number;
  usual: number;
  open: number;
  elapsed: number;
  resets: string | null;
  periodStart: string;
  status: CadenceStatus;
  dismissed: { reason: string | null; by: string | null; at: string } | null;
  /** Whether the client's email numbers are coming in: when they aren't, "sent" can't be trusted and the row says why */
  sync: { ok: boolean; provider: string | null; label: string; detail: string | null };
};

export type Workload = { profileId: string; name: string; role: string; roleKey: string; open: number; messages: number; late: number; asana: number; oldest: number };

/** An email builder's card: builds, how fast, what came back, real errors, due dates pushed, and their plate */
export type BuildMaker = {
  profileId: string;
  name: string;
  role: string;
  builds: number;
  turnaround: number | null;
  turnaroundTarget: number;
  onTime: number | null;
  returns: number;
  returnRate: number | null;
  returned: TaskRef[];
  errors: { d45: number; d90: number; items: EmailErrorItem[] };
  pushedBack: { pct: number | null; of: number; items: TaskRef[] };
  plate: TaskRef[];
  late: number;
  act: string | null;
};

/** A strategist's scorecard: their accounts, how early requests come in, how long work sits with them, replies, reports */
export type StrategistCard = {
  profileId: string;
  name: string;
  role: string;
  accounts: { n: number; scored: number; avg: number | null; before: number | null; since: string | null; trend: "up" | "down" | "flat" | null; lowest: { name: string; slug: string; score: number }[] };
  requests: { of: number; onTime: number | null; avgShort: number | null; late: TaskRef[] };
  response: { avgDays: number | null; target: number; stints: number; sitting: number; bottleneck: boolean; items: TaskRef[] };
  replies: { medianHours: number | null; answered: number; waiting: number; escalated: number };
  reports: { onTime: number; late: number; rate: number | null; lateItems: { client: string; kind: string; periodEnd: string; due: string; postedAt: string | null }[] };
  plate: TaskRef[];
  act: string | null;
};

export type TiringFlow = { key: string; clientId: string; client: string; slug: string; flow: string; flowId: string; severity: "tiring" | "tired"; before: number; now: number; change: number; recipients: number; revenue: number; refreshing: number | null };

export type EmailDesignKpis = {
  period: Period;
  days: number;
  headlines: Headline[];
  makers: EmailMaker[];
  cadence: Cadence[];
  workload: Workload[];
  revisionClients: { client: string; slug: string | null; perPiece: number; pieces: number; recent: TaskRef[] }[];
  slowClients: { client: string; slug: string | null; days: number; pieces: number }[];
  late: LateTicket[];
  teamAvg: { briefToDone: number | null; metDue: number | null; pushedBack: number | null; revisionTurnaround: number | null; winners: number };
  teamSendbacks: { d45: Sendbacks; d90: Sendbacks };
  fixes: { d45: number; d90: number };
  winners: EmailResult[];
  losers: EmailResult[];
  results: { judged: number; winners: number; losers: number; par: number; hitRate: number | null; previousHitRate: number | null };
  tiring: TiringFlow[];
  actions: EmailAction[];
  split: { copy: number; design: number };
  source: { asana: number; kaizen: number; linked: number };
  builders: BuildMaker[];
  strategists: StrategistCard[];
  /** Who's on each tab (by role and seat; execs and the Head of Email never are) */
  members: { design: string[]; build: string[]; copy: string[]; strategy: string[] };
  errorsUnsorted: number;
};

export type EmailStrategist = { id: string; name: string; role: string; approved: number; turnaround: number | null; firstPass: number | null; sendbacks: number; rewrites: number; openRate: number | null; subjects: number; open: number; late: number; weekly: number[]; act: string | null };
export type EmailCopyClient = { id: string; name: string; slug: string; tickets: number; copyBack: number; open: number; openRate: number | null; usualOpen: number | null; lastAsk: string | null };
export type EmailCopyKpis = {
  period: Period;
  days: number;
  headlines: Headline[];
  strategists: EmailStrategist[];
  clients: EmailCopyClient[];
  styles: { name: string; winners: number; judged: number; rate: number | null }[];
  subjects: { subject: string; client: string; slug: string; verdict: Verdict; openRate: number | null; lift: number | null }[];
  late: LateTicket[];
  rewrites: { note: string | null; client: string; slug: string; number: number | null; by: string | null; at: string }[];
  actions: EmailAction[];
  split: { copy: number; design: number };
  best: EmailResult[];
  worst: EmailResult[];
  opensTiring: TiringFlow[];
  openRate: { now: number | null; before: number | null; sends: number };
};

// ─── Reading everything once ──────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Every row of a query, a thousand at a time (the API caps a request there) */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/** Every row for a long list of ids, a hundred ids per request (each read in pages) */
async function chunked<T>(ids: string[], read: (part: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    out.push(...(await readAll<T>((a, b) => read(part, a, b))));
  }
  return out;
}

type World = {
  days: number;
  since: string;
  before: string;
  d45: string;
  d90: string;
  pieces: Piece[];
  rows: Map<string, Row>;
  people: { id: string; full_name: string; role: string; teams: string[] | null; also_designs_email: boolean | null; is_exec: boolean | null }[];
  nameOf: Map<string, string>;
  clients: Map<string, { id: string; name: string; slug: string; email: boolean }>;
  seats: Map<string, SeatRow[]>;
  messages: Row[];
  fixes: Row[];
  sent: Sent[];
  sentSource: Map<string, string>;
  flows: Row[];
  usage: { client_id: string; period_start: string | null; period_end: string | null }[];
  dismissals: Row[];
  /** Who put each Board ticket in (the strategist's request); Asana tasks don't say */
  requestedBy: Map<string, string | null>;
};

async function loadWorld(db: SupabaseClient, period: Period): Promise<World> {
  const { data: usage } = await db.from("client_allotment_usage").select("client_id, period_start, period_end");
  const usageRows = (usage ?? []) as World["usage"];
  const days = period === "cycle" ? cycleDays(usageRows) : Number(period);
  const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const since = at(days);
  const before = at(2 * days);
  const d45 = at(45);
  const d90 = at(90);
  const back = at(Math.max(180, 2 * days + 30));

  const [tickets, asana, { data: people }, { data: clientRows }, { data: seatRows }, campaigns, flows, dismissals] = await Promise.all([
    readAll<Row>((a, b) => db.from("email_board").select("id, number, title, client_id, client_name, client_slug, kind, stage, priority, assignee_id, assignee_name, due_on, created_at, created_by, live_at, minutes_over, stage_due_at, copy_status, updated_at").or(`stage.neq.live,created_at.gte.${back},live_at.gte.${back}`).order("number").range(a, b), 5),
    readAll<Row>((a, b) => db.from("email_asana_tasks").select("gid, name, url, client_id, open, section, stage, kind, due_on, assignee_name, profile_id, asana_created_at, completed_at, history, comments, clients(name, slug)").is("ticket_id", null).or(`open.eq.true,asana_modified_at.gte.${back}`).not("history_read_at", "is", null).order("gid").range(a, b), 5),
    db.from("profiles").select("id, full_name, role, teams, also_designs_email, is_exec").eq("is_active", true),
    db.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", ["active", "onboarding"]),
    db.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").in("role", ["email_strategist", "email_designer", "email_builder"]),
    readAll<Row>((a, b) => db.from("klaviyo_campaigns").select("client_id, campaign_id, name, channel, send_time, subject, preview_text, recipients, open_rate, click_rate, revenue, source").gte("send_time", back).order("send_time", { ascending: false }).order("campaign_id").range(a, b)),
    readAll<Row>((a, b) => db.from("klaviyo_flows").select("client_id, flow_id, name, status, recipients_30, recipients_90, open_rate_30, open_rate_90, click_rate_30, click_rate_90, revenue_30").order("client_id").order("flow_id").range(a, b), 5),
    // Set aside a client's cycle (a pause on their side, billing out of step): the table may not be there yet
    Promise.resolve(db.from("email_cadence_dismissals").select("client_id, period_start, reason, dismissed_at, profiles:dismissed_by(full_name)"))
      .then((r) => (r.error ? [] : ((r.data ?? []) as Row[])))
      .catch(() => [] as Row[]),
  ]);
  const team = (people ?? []) as World["people"];
  const nameOf = new Map(team.map((p) => [p.id, p.full_name]));
  // An Asana name to a teammate: first and last names must agree (accents aside), someone on the email team first, so
  // a designer's Asana name never lands on a video editor who shares the start of it
  const personFor = (name: string | null | undefined) => matchPerson(name, team, (p) => isEmailRole(p.role))?.id ?? null;
  const clients = new Map((clientRows ?? []).map((c) => [c.id as string, { id: c.id as string, name: c.name as string, slug: c.slug as string, email: (servicesOf(c) as string[]).includes("email-marketing") }]));
  const seats = new Map<string, SeatRow[]>();
  for (const s of (seatRows ?? []) as (SeatRow & { client_id: string })[]) seats.set(s.client_id, [...(seats.get(s.client_id) ?? []), s]);

  // ─── Kaizen tickets: their events, the client's comments, the AI's fixes, each message ───
  const ids = tickets.map((t) => t.id as string);
  const [events, comments, messages] = await Promise.all([
    chunked<Row>(ids, (part, a, b) => db.from("email_ticket_events").select("id, ticket_id, kind, from_stage, to_stage, actor_id, actor_name, body, data, created_at").in("ticket_id", part).in("kind", ["stage", "assign", "due", "design", "copy", "asana"]).order("created_at").order("id").range(a, b)),
    chunked<Row>(ids, (part, a, b) => db.from("email_comments").select("id, ticket_id, message_id, author_kind, body, route, severity, design_version, created_at").in("ticket_id", part).in("author_kind", ["client", "ai"]).order("id").range(a, b)),
    chunked<Row>(ids, (part, a, b) => db.from("email_messages").select("id, ticket_id, client_id, channel, name, subject, preheader, design_path, design_version, provider_ref, live_at, copy_approved_at, copy_approved_by").in("ticket_id", part).order("id").range(a, b)),
  ]);
  const evBy = new Map<string, Row[]>();
  for (const e of events) evBy.set(e.ticket_id as string, [...(evBy.get(e.ticket_id as string) ?? []), e]);
  const notesBy = new Map<string, Row[]>();
  for (const c of comments.filter((x) => x.author_kind === "client")) notesBy.set(c.ticket_id as string, [...(notesBy.get(c.ticket_id as string) ?? []), c]);
  const msgCount = new Map<string, number>();
  for (const m of messages) msgCount.set(m.ticket_id as string, (msgCount.get(m.ticket_id as string) ?? 0) + 1);

  const pieces: Piece[] = [];
  const rows = new Map<string, Row>();
  const requestedBy = new Map<string, string | null>();
  for (const r of tickets) {
    const ev = (evBy.get(r.id as string) ?? []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const asanaH = ev.filter((e) => e.kind === "asana").map((e) => ((e.data ?? {}) as { asana?: EmailHistory }).asana).filter((h): h is EmailHistory => Boolean(h));
    const firstAsanaMove = asanaH.find((h) => h.kind === "moved") as Extract<EmailHistory, { kind: "moved" }> | undefined;
    const moves: { at: string; to: Phase }[] = [
      ...asanaH.flatMap((h) => (h.kind === "moved" ? [{ at: h.at, to: phaseOfColumn(h.to) }] : [])).filter((m): m is { at: string; to: Phase } => m.to != null),
      ...ev.filter((e) => e.kind === "stage" && e.to_stage).map((e) => ({ at: e.created_at as string, to: e.to_stage as Phase })),
    ];
    const assigns = [
      ...asanaH.flatMap((h) => (h.kind === "assigned" ? [{ at: h.at, to: personFor(h.to) }] : [])),
      ...ev.filter((e) => e.kind === "assign").map((e) => {
        const d = (e.data ?? {}) as { from?: string | null; to?: string | null };
        return { at: e.created_at as string, from: d.from ?? null, to: d.to ?? null };
      }),
    ];
    // Due dates: Asana's changes (from and to), then the board's (each event carries the new date)
    const dues: Piece["dues"] = asanaH.flatMap((h) => (h.kind === "due" ? [{ at: h.at, from: h.from, to: h.to, by: personFor(h.by) }] : []));
    let lastDue = dues.at(-1)?.to ?? null;
    for (const e of ev.filter((x) => x.kind === "due")) {
      const to = /^\d{4}-\d{2}-\d{2}/.test(String(e.body ?? "")) ? String(e.body).slice(0, 10) : null;
      dues.push({ at: e.created_at as string, from: lastDue, to, by: (e.actor_id as string | null) ?? null });
      lastDue = to;
    }
    const copyEv = ev.filter((e) => e.kind === "copy");
    const approvals = copyEv.filter((e) => /^Approved/.test(String(e.body ?? "")));
    const leftCopy = ev.find((e) => e.kind === "stage" && e.from_stage === "copy_review")?.created_at as string | undefined;
    const approved = (leftCopy ? approvals.filter((e) => (e.created_at as string) <= new Date(Date.parse(leftCopy) + 60_000).toISOString()).at(-1) : approvals.at(-1)) ?? approvals.at(-1);
    const stage = r.stage as Phase;
    const open = stage !== "live";
    const holderNow = (r.assignee_id as string | null) ?? null;
    const createdAt = r.created_at as string;
    const p: Piece = {
      key: `k:${r.number}`,
      source: "kaizen",
      number: r.number as number,
      title: r.title as string,
      clientId: r.client_id as string,
      client: (r.client_name as string | null) ?? null,
      slug: (r.client_slug as string | null) ?? null,
      kind: (r.kind as "batch" | "flow") ?? "batch",
      createdAt,
      open,
      stage,
      href: `/board/email?t=${r.number}`,
      external: false,
      dueFirst: dues.length ? (dues[0].from ?? dues[0].to) : ((r.due_on as string | null) ?? null),
      dueNow: (r.due_on as string | null) ?? null,
      dues,
      stints: stintsOf(createdAt, (firstAsanaMove && phaseOfColumn(firstAsanaMove.from)) || "copy_review", moves, assigns, holderNow, open),
      uploads: ev.filter((e) => e.kind === "design").map((e) => {
        const d = (e.data ?? {}) as { messageId?: string; version?: number };
        return { at: e.created_at as string, by: (e.actor_id as string | null) ?? null, messageId: d.messageId ?? null, version: typeof d.version === "number" ? d.version : null };
      }),
      notes: (notesBy.get(r.id as string) ?? []).map((c) => ({ at: c.created_at as string, route: (c.route as Route | null) ?? null, text: String(c.body ?? "") })),
      rewrites: copyEv.filter((e) => /^Rewrote the copy/.test(String(e.body ?? ""))).map((e) => ({ at: e.created_at as string, note: String(e.body).replace(/^Rewrote the copy:?\s*/, "") || null })),
      drafted: (copyEv.find((e) => /^Wrote the copy/.test(String(e.body ?? "")))?.created_at as string | undefined) ?? null,
      copyApproved: approved ? { at: approved.created_at as string, by: (approved.actor_id as string | null) ?? null } : null,
      minutesOver: Number(r.minutes_over ?? 0),
      holderNow,
      messages: msgCount.get(r.id as string) ?? 0,
    };
    pieces.push(p);
    rows.set(p.key, r);
    requestedBy.set(p.key, (r.created_by as string | null) ?? null);
  }

  // ─── Asana email tasks not moved over yet (the moved ones are Kaizen tickets with this history already) ───
  for (const t of asana) {
    const history = ((t.history ?? []) as EmailHistory[]).slice().sort((a, b) => a.at.localeCompare(b.at));
    const createdAt = (t.asana_created_at as string) ?? now();
    const moved = history.filter((h): h is Extract<EmailHistory, { kind: "moved" }> => h.kind === "moved");
    const moves = moved.map((h) => ({ at: h.at, to: phaseOfColumn(h.to) })).filter((m): m is { at: string; to: Phase } => m.to != null);
    const open = Boolean(t.open);
    if (!open && t.completed_at && (moves.at(-1)?.to ?? null) !== "done") moves.push({ at: t.completed_at as string, to: "done" });
    const holderNow = (t.profile_id as string | null) ?? personFor(t.assignee_name as string | null);
    const dues = history.flatMap((h) => (h.kind === "due" ? [{ at: h.at, from: h.from, to: h.to, by: personFor(h.by) }] : []));
    const c = t.clients as unknown as { name: string; slug: string } | null;
    const title = cleanTitle(t.name as string).title;
    const stage = open ? ((t.stage as Phase | null) ?? phaseOfColumn(t.section as string | null) ?? "copy_review") : "done";
    const p: Piece = {
      key: `a:${t.gid}`,
      source: "asana",
      number: null,
      title,
      clientId: (t.client_id as string | null) ?? null,
      client: c?.name ?? null,
      slug: c?.slug ?? null,
      kind: (t.kind as "batch" | "flow" | null) ?? "batch",
      createdAt,
      open,
      stage,
      href: (t.url as string | null) ?? "#",
      external: true,
      dueFirst: dues[0]?.from ?? dues[0]?.to ?? ((t.due_on as string | null) ?? null),
      dueNow: (t.due_on as string | null) ?? null,
      dues,
      stints: stintsOf(createdAt, phaseOfColumn(moved[0]?.from ?? (t.section as string | null)) ?? "copy_review", moves, history.flatMap((h) => (h.kind === "assigned" ? [{ at: h.at, to: personFor(h.to) }] : [])), holderNow, open),
      uploads: [],
      notes: ((t.comments ?? []) as EmailTaskComment[]).map((m) => ({ at: m.at, route: null, text: m.text })),
      rewrites: [],
      drafted: null,
      copyApproved: null,
      minutesOver: 0,
      holderNow,
      messages: 0,
    };
    pieces.push(p);
    rows.set(p.key, t as Row);
  }

  const sentSource = new Map<string, string>();
  const sent: Sent[] = campaigns.map((c) => {
    sentSource.set(`${c.client_id}:${c.campaign_id}`, String(c.source ?? "klaviyo"));
    return {
      id: c.campaign_id as string,
      clientId: c.client_id as string,
      name: (c.name as string | null) ?? "",
      subject: (c.subject as string | null) ?? null,
      preview: (c.preview_text as string | null) ?? null,
      channel: (c.channel as string | null) ?? null,
      sendTime: (c.send_time as string | null) ?? null,
      recipients: Number(c.recipients ?? 0),
      openRate: c.open_rate == null ? null : Number(c.open_rate),
      clickRate: c.click_rate == null ? null : Number(c.click_rate),
      revenue: Number(c.revenue ?? 0),
    };
  });

  return { days, since, before, d45, d90, pieces, rows, people: team, nameOf, clients, seats, messages, fixes: comments.filter((c) => c.author_kind === "ai" && c.severity === "fix"), sent, sentSource, flows, usage: usageRows, dismissals: dismissals as Row[], requestedBy };
}

// ─── Shared pieces of both tabs ───────────────────────────────────────────────

const STAGE_NAME = (s: Phase) => (s === "done" ? "Done" : emailStageInfo(s as EmailStage).label);

function refOf(p: Piece, note: string | null = null, at: string | null = null): TaskRef {
  const today = ymdNY(new Date());
  const late = p.source === "kaizen" ? p.minutesOver > 0 && p.open : Boolean(p.open && p.dueNow && p.dueNow < today);
  const t = cleanTitle(p.title);
  return { key: `${p.key}:${at ?? ""}`, title: p.number ? `${handle(p.number)} ${t.title}` : t.title, urgent: t.urgent, client: p.client, stage: STAGE_NAME(p.stage), late, due: p.dueNow, href: p.href, external: p.external, note, at };
}

function lateTickets(w: World, filter: (p: Piece) => boolean): LateTicket[] {
  return w.pieces
    .filter((p) => p.source === "kaizen" && p.open && p.minutesOver > 0 && p.stage !== "with_client" && filter(p))
    .sort((a, b) => b.minutesOver - a.minutesOver)
    .slice(0, 8)
    .map((p) => {
      const r = w.rows.get(p.key)!;
      const t = cleanTitle(p.title);
      return { id: r.id as string, number: p.number!, title: t.title, urgent: t.urgent || r.priority === "urgent", client: p.client ?? "", stage: STAGE_NAME(p.stage), hoursOver: Math.round(p.minutesOver / 60), assignee: (r.assignee_name as string | null) ?? null, due: (r.stage_due_at as string | null) ?? null, kind: p.kind === "flow" ? "Flow" : "Campaign batch", messages: p.messages };
    });
}

/** Each sent email linked to the Email Board ticket it came from (the message's campaign id), with its designer and strategist */
function linksOf(w: World) {
  const ticketPiece = new Map(w.pieces.filter((p) => p.source === "kaizen").map((p) => [w.rows.get(p.key)!.id as string, p]));
  const out = new Map<string, { piece: Piece; designer: string | null; writer: string | null; design: string | null; designVersion: number }>();
  for (const m of w.messages) {
    if (!m.provider_ref) continue;
    const p = ticketPiece.get(m.ticket_id as string);
    if (!p) continue;
    const upload = p.uploads.filter((u) => u.messageId === m.id && u.by).at(-1);
    out.set(`${m.client_id}:${m.provider_ref}`, { piece: p, designer: upload?.by ?? designerAt(p, now()), writer: (m.copy_approved_by as string | null) ?? writerAt(p, now()), design: (m.design_path as string | null) ?? null, designVersion: Number(m.design_version ?? 0) });
  }
  return out;
}

async function picturesFor(db: SupabaseClient, rows: EmailResult[], designs: Map<string, string>) {
  // The design uploaded on the Board when there is one, else the email as it was drawn for the client's report
  const need = rows.filter((r) => !r.image);
  const paths = [...new Set([...designs.values()])];
  if (paths.length) {
    const { data } = await db.storage.from("creative").createSignedUrls(paths, 6 * 3600);
    const url = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
    for (const r of rows) {
      const p = designs.get(r.key);
      if (p && url.get(p)) r.image = url.get(p)!;
    }
  }
  const byClient = new Map<string, EmailResult[]>();
  for (const r of need.filter((x) => !x.image)) byClient.set(r.clientId, [...(byClient.get(r.clientId) ?? []), r]);
  if (!byClient.size) return;
  const { emailShotLinks } = await import("@/lib/channel-reports/email-shots");
  await Promise.all(
    [...byClient].map(async ([clientId, list]) => {
      const links = await emailShotLinks(db, clientId, list.map((r) => r.key.split(":")[1])).catch(() => ({}) as Record<string, string>);
      for (const r of list) r.image = links[r.key.split(":")[1]] ?? null;
    }),
  );
}

function flowTiring(w: World, rate: "click" | "open", openFlows: Piece[]): TiringFlow[] {
  const out: TiringFlow[] = [];
  for (const f of w.flows) {
    const c = w.clients.get(f.client_id as string);
    if (!c || !/live|active/i.test(String(f.status ?? ""))) continue;
    const t = flowTrend({ recipients30: Number(f.recipients_30 ?? 0), recipients90: Number(f.recipients_90 ?? 0), rate30: f[`${rate}_rate_30`] == null ? null : Number(f[`${rate}_rate_30`]), rate90: f[`${rate}_rate_90`] == null ? null : Number(f[`${rate}_rate_90`]) });
    const sev = t ? severityOf(t.change) : null;
    if (!t || !sev) continue;
    const name = String(f.name ?? "Flow");
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4 && x !== "flow");
    // A flow ticket open for the client that names the same flow is its refresh
    const refresh = openFlows.find((p) => p.clientId === c.id && p.kind === "flow" && words.some((x) => p.title.toLowerCase().includes(x)));
    out.push({ key: `${c.id}:${f.flow_id}`, clientId: c.id, client: c.name, slug: c.slug, flow: name, flowId: f.flow_id as string, severity: sev, before: pct2(t.before)!, now: pct2(t.now)!, change: Math.round(t.change * 100), recipients: Number(f.recipients_30 ?? 0), revenue: Math.round(Number(f.revenue_30 ?? 0)), refreshing: refresh?.number ?? null });
  }
  return out.sort((a, b) => Number(Boolean(a.refreshing)) - Number(Boolean(b.refreshing)) || a.change - b.change);
}

const blankSb = (): { d45: Sendbacks; d90: Sendbacks } => ({ d45: { internal: 0, client: 0, pieces: 0 }, d90: { internal: 0, client: 0, pieces: 0 } });

// ─── Email design KPIs ────────────────────────────────────────────────────────

export async function loadEmailDesignKpis(db: SupabaseClient, period: Period): Promise<EmailDesignKpis> {
  const w = await loadWorld(db, period);
  const { since, before, d45, d90, pieces } = w;
  const nowIso = new Date(Date.now() + 60_000).toISOString();
  const { loadEmailErrors } = await import("@/lib/email-errors");
  const errorsP = loadEmailErrors(db, d90).catch(() => ({ byPerson: new Map<string, EmailErrorItem[]>(), unsorted: 0 }));

  // ─── Who's on each tab: by role and seat, never by what was credited to them (execs and the Head of Email never) ───
  const allSeats = [...w.seats.values()].flat();
  const design = membersOf("email", "design", w.people, allSeats);
  const build = membersOf("email", "build", w.people, allSeats);
  const strategy = membersOf("email", "strategy", w.people, allSeats);
  const everyone = teamOf("email", w.people, allSeats);
  // Work credited to someone off the design tab (a head, an exec, anyone outside the line) never counts in its numbers
  const onDesign = <T extends { person: string | null }>(xs: T[]) => xs.filter((x) => !x.person || design.has(x.person));

  const passes = onDesign(designPasses(pieces, since, nowIso));
  const passesPrev = onDesign(designPasses(pieces, before, since));
  const fp = onDesign(firstPasses(pieces, since, nowIso));
  const fpPrev = onDesign(firstPasses(pieces, before, since));
  const reach = onDesign(toClient(pieces, since, nowIso));
  const reachPrev = onDesign(toClient(pieces, before, since));
  const revs = onDesign(revisionTurns(pieces, since, nowIso, "design"));
  const revsPrev = onDesign(revisionTurns(pieces, before, since, "design"));
  const backs = sendbacksOf(pieces, d90);
  const passes90 = onDesign(designPasses(pieces, d90, nowIso));

  // Pieces in front of the client in the window, and how many the client sent back at least once
  const clientRate = (from: string, to: string) => {
    const seen = new Set<string>();
    const back = new Set<string>();
    let rounds = 0;
    for (const p of pieces)
      for (const s of p.stints) {
        if (s.stage !== "with_client" || !s.to || s.to < from || s.to >= to) continue;
        seen.add(p.key);
        if (s.next === "revisions") {
          back.add(p.key);
          rounds++;
        }
      }
    return { rate: pctOf(back.size, seen.size), rounds, of: seen.size };
  };
  const cr = clientRate(since, nowIso);
  const crPrev = clientRate(before, since);

  // The AI's design review: real problems caught before anyone else looked (per design uploaded)
  const uploads = (from: string, to: string) => pieces.reduce((n, p) => n + p.uploads.filter((u) => u.at >= from && u.at < to).length, 0);
  const fixesIn = (from: string, to: string) => w.fixes.filter((f) => (f.created_at as string) >= from && (f.created_at as string) < to).length;
  const fixRate = (from: string, to: string) => {
    const u = uploads(from, to);
    return u ? r1(fixesIn(from, to) / u) : null;
  };

  // Results: each sent email against its own account's usual clicks
  const base = baselines(w.sent.filter((c) => c.sendTime && c.sendTime >= d90));
  const links = linksOf(w);
  const judged = (from: string, to: string) => w.sent.filter((c) => isEmail(c) && c.sendTime && c.sendTime >= from && c.sendTime < to && w.clients.get(c.clientId)?.email).map((c) => ({ c, v: judge(c, base.get(c.clientId), "click") }));
  const cur = judged(since, nowIso);
  const old = judged(before, since);
  const hr = hitRate(cur.map((x) => x.v));
  const hrOld = hitRate(old.map((x) => x.v));

  const avgDays = (xs: { days: number }[]) => r1(avg(xs.map((x) => x.days)));
  const onTimeOf = (xs: { onTime: boolean }[]) => pctOf(xs.filter((x) => x.onTime).length, xs.length);
  const fpOf = (xs: { pass: boolean }[]) => pctOf(xs.filter((x) => x.pass).length, xs.length);
  const draft = avgDays(reach);
  const draftPrev = avgDays(reachPrev);
  const fixNow = fixRate(since, nowIso);
  const fixPrev = fixRate(before, since);
  const headlines: Headline[] = [
    { key: "draft", label: "To the client", value: draft, unit: "d", previous: draftPrev, better: "down", tone: tone(draft, (x) => x <= 4, (x) => x <= 6), verdict: verdictOf("Request to the client", draft, draftPrev, "d", "down", "emails reached a client"), hint: `request → in front of the client · ${reach.length} tickets` },
    { key: "ontime", label: "Designs on time", value: onTimeOf(passes), unit: "%", previous: onTimeOf(passesPrev), better: "up", tone: tone(onTimeOf(passes), (x) => x >= 80, (x) => x >= 60), verdict: verdictOf("On-time design", onTimeOf(passes), onTimeOf(passesPrev), "%", "up", "designs passed on"), hint: `designed within ${DESIGN_TARGET} business days` },
    { key: "pass", label: "First-pass approval", value: fpOf(fp), unit: "%", previous: fpOf(fpPrev), better: "up", tone: tone(fpOf(fp), (x) => x >= 70, (x) => x >= 50), verdict: verdictOf("First-pass approval", fpOf(fp), fpOf(fpPrev), "%", "up", "designs passed on"), hint: "no design change asked, in review or by the client" },
    { key: "back", label: "Sent back by clients", value: cr.rate, unit: "%", previous: crPrev.rate, better: "down", tone: tone(cr.rate, (x) => x <= 25, (x) => x <= 45), verdict: verdictOf("Client revision rate", cr.rate, crPrev.rate, "%", "down", "tickets reached a client"), hint: `of ${cr.of} tickets, at least once · ${cr.rounds} rounds` },
    { key: "rev", label: "Revision turnaround", value: avgDays(revs), unit: "d", previous: avgDays(revsPrev), better: "down", tone: tone(avgDays(revs), (x) => x <= 1, (x) => x <= 2), verdict: verdictOf("Revision turnaround", avgDays(revs), avgDays(revsPrev), "d", "down", "design revisions"), hint: "client's design changes → back to them" },
    { key: "fixes", label: "AI fixes per design", value: fixNow, unit: "", previous: fixPrev, better: "down", tone: tone(fixNow, (x) => x <= 0.5, (x) => x <= 1.5), verdict: fixNow == null ? "No design uploaded in this period yet." : fixPrev == null ? `${fixNow} per design. Nothing to compare with yet.` : `${fixNow} per design (${fixPrev} the period before).`, hint: `${fixesIn(since, nowIso)} must-fix notes on ${uploads(since, nowIso)} uploads, caught before review` },
    { key: "volume", label: "Designs passed on", value: passes.length, unit: "", previous: passesPrev.length, better: "up", tone: null, verdict: countVerdict("Designs passed on", passes.length, passesPrev.length, "up"), hint: `${passes.filter((x) => x.piece.source === "asana").length} from the Asana board` },
    { key: "hit", label: "Emails that out-click", value: hr.rate, unit: "%", previous: hrOld.rate, better: "up", tone: tone(hr.rate, (x) => x >= 40, (x) => x >= 25), verdict: verdictOf("Hit rate", hr.rate, hrOld.rate, "%", "up", "sent emails judged"), hint: `beat their account's usual click rate, of ${hr.w + hr.l} judged` },
  ];

  // ─── The design tab's people: email designers, and builders who also design ───
  const roleOf = new Map(w.people.map((p) => [p.id, p.role]));
  const ids = design;

  const sbBy = new Map<string, { d45: Sendbacks; d90: Sendbacks; items: TaskRef[] }>();
  const bump = (id: string | null, at: string, field: keyof Sendbacks, item?: TaskRef) => {
    if (!id || at < d90) return;
    const b = sbBy.get(id) ?? { ...blankSb(), items: [] };
    b.d90[field]++;
    if (at >= d45) b.d45[field]++;
    if (item) b.items.push(item);
    sbBy.set(id, b);
  };
  for (const x of passes90) bump(x.person, x.at, "pieces");
  const recentByClient = new Map<string, TaskRef[]>();
  for (const b of backs.filter((x) => x.route === "design")) {
    const item = refOf(b.piece, b.note, b.at);
    bump(b.person, b.at, b.kind, item);
    if (b.kind === "client" && b.piece.slug) recentByClient.set(b.piece.slug, [...(recentByClient.get(b.piece.slug) ?? []), item]);
  }
  const teamSendbacks = blankSb();
  for (const b of [...sbBy].filter(([id]) => design.has(id)).map(([, x]) => x))
    for (const k of ["d45", "d90"] as const) {
      teamSendbacks[k].internal += b[k].internal;
      teamSendbacks[k].client += b[k].client;
      teamSendbacks[k].pieces += b[k].pieces;
    }

  // AI fixes, credited to whoever uploaded that version of that email
  const pieceByTicket = new Map(pieces.filter((p) => p.source === "kaizen").map((p) => [w.rows.get(p.key)!.id as string, p]));
  const msgName = new Map(w.messages.map((m) => [m.id as string, m.name as string]));
  const fixesBy = new Map<string, FixItem[]>();
  for (const f of w.fixes) {
    if ((f.created_at as string) < d90) continue;
    const p = pieceByTicket.get(f.ticket_id as string);
    if (!p) continue;
    const up = p.uploads.filter((u) => u.messageId === f.message_id && (f.design_version == null || u.version === f.design_version) && u.at <= (f.created_at as string)).at(-1);
    const who = up?.by ?? designerAt(p, f.created_at as string);
    if (!who) continue;
    fixesBy.set(who, [...(fixesBy.get(who) ?? []), { id: f.id as string, quote: String(f.body ?? "").slice(0, 400), client: p.client, ticket: p.number, message: msgName.get(f.message_id as string) ?? null, at: f.created_at as string }]);
  }

  // Due dates met and pushed, time to the client, the plate
  const reach90 = toClient(pieces, d90, nowIso);
  const metBy = new Map<string, { met: number; of: number; missed: TaskRef[] }>();
  const heldBy = new Map<string, Set<string>>();
  const pushedBy = new Map<string, Map<string, TaskRef>>();
  for (const p of pieces) {
    for (const s of p.stints) if (s.holder && (s.to ?? nowIso) >= d90 && s.stage !== "with_client" && s.stage !== "done") heldBy.set(s.holder, (heldBy.get(s.holder) ?? new Set()).add(p.key));
    const m = metDue(p);
    if (m && m.readyAt >= d90) {
      const who = designerAt(p, m.readyAt);
      if (who) {
        const b = metBy.get(who) ?? { met: 0, of: 0, missed: [] };
        b.of++;
        if (m.met) b.met++;
        else b.missed.push(refOf(p, `Ready to send ${fmtDay(m.readyAt)}, due ${fmtDay(m.due)}`, m.readyAt));
        metBy.set(who, b);
      }
    }
    for (const x of pushes(p, d90)) pushedBy.set(x.by, (pushedBy.get(x.by) ?? new Map()).set(p.key, refOf(p, `Due ${fmtDay(x.from)} → ${fmtDay(x.to)}`, x.at)));
  }
  const plateBy = new Map<string, { plate: TaskRef[]; late: number; messages: number; asana: number; oldest: number; sitting: number; kaizen: number }>();
  for (const p of pieces.filter((x) => x.open && x.holderNow && x.stage !== "done")) {
    const o = plateBy.get(p.holderNow!) ?? { plate: [], late: 0, messages: 0, asana: 0, oldest: 0, sitting: 0, kaizen: 0 };
    const ref = refOf(p);
    o.plate.push(ref);
    if (ref.late) o.late++;
    o.messages += p.messages;
    if (p.source === "asana") o.asana++;
    else o.kaizen++;
    const sit = sittingDays(p);
    o.oldest = Math.max(o.oldest, Math.round(sit));
    if (sit >= 2 && (p.stage === "ready_for_design" || p.stage === "revisions")) o.sitting++;
    plateBy.set(p.holderNow!, o);
  }

  // Sent emails credited to a designer: linked through the Board ticket, else the client's designer seat
  const resultOf = (c: Sent, v: Verdict | null, on: "click" | "open"): EmailResult => {
    const cl = w.clients.get(c.clientId)!;
    const b = base.get(c.clientId);
    const link = links.get(`${c.clientId}:${c.id}`);
    const seatPerson = pickSeat(w.seats.get(c.clientId) ?? [], on === "click" ? "email_designer" : "email_strategist");
    const creditId = (on === "click" ? link?.designer : link?.writer) ?? seatPerson;
    const src = w.sentSource.get(`${c.clientId}:${c.id}`) ?? "klaviyo";
    return {
      key: `${c.clientId}:${c.id}`,
      clientId: c.clientId,
      client: cl.name,
      slug: cl.slug,
      name: c.name,
      subject: c.subject,
      preview: c.preview,
      sent: c.sendTime,
      recipients: c.recipients,
      openRate: pct1(c.openRate),
      clickRate: pct2(c.clickRate),
      revenue: Math.round(c.revenue),
      rpr: c.recipients ? Math.round((c.revenue / c.recipients) * 1000) / 1000 : null,
      usualOpen: pct1(b?.open ?? null),
      usualClick: pct2(b?.click ?? null),
      clickLift: liftOf(c.clickRate, b?.click ?? null),
      openLift: liftOf(c.openRate, b?.open ?? null),
      verdict: v,
      image: null,
      href: src === "klaviyo" ? klaviyoUrl(c.id) : null,
      how: link ? "linked" : "seat",
      credit: creditId ? (w.nameOf.get(creditId) ?? null) : null,
      creditId: creditId ?? null,
      ticket: link?.piece.number ?? null,
    };
  };
  const judged90 = w.sent.filter((c) => isEmail(c) && c.sendTime && c.sendTime >= d90 && w.clients.get(c.clientId)?.email).map((c) => ({ c, v: judge(c, base.get(c.clientId), "click") }));
  const winsBy = new Map<string, EmailResult[]>();
  for (const x of judged90.filter((j) => j.v === "winner")) {
    const r = resultOf(x.c, x.v, "click");
    if (r.creditId) winsBy.set(r.creditId, [...(winsBy.get(r.creditId) ?? []), r]);
  }

  const loads = [...ids].map((id) => plateBy.get(id)?.plate.length ?? 0);
  const typical = avg(loads) ?? 0;
  const errs = await errorsP;
  const errorsOf = (id: string, area: EmailErrorItem["area"]) => {
    const list = (errs.byPerson.get(id) ?? []).filter((e) => e.area === area);
    return { d45: list.filter((e) => e.at >= d45).length, d90: list.length, items: list.slice(0, 12) };
  };
  const makers: EmailMaker[] = [...ids]
    .map((id): EmailMaker => {
      const mine = passes.filter((x) => x.person === id);
      const minePrev = passesPrev.filter((x) => x.person === id);
      const firstPass = fpOf(fp.filter((x) => x.person === id));
      const turnaround = avgDays(mine);
      const revisionTurnaround = avgDays(revs.filter((x) => x.person === id));
      const o = plateBy.get(id) ?? { plate: [], late: 0, messages: 0, asana: 0, oldest: 0, sitting: 0, kaizen: 0 };
      const score = scoreOf({ firstPass, turnaround, target: DESIGN_TARGET, revision: revisionTurnaround, sitting: o.sitting });
      const previous = scoreOf({ firstPass: fpOf(fpPrev.filter((x) => x.person === id)), turnaround: avgDays(minePrev), target: DESIGN_TARGET, revision: avgDays(revsPrev.filter((x) => x.person === id)), sitting: 0 });
      const load = o.plate.length;
      const act =
        o.sitting >= 3 || o.late >= 2
          ? `${Math.max(o.sitting, o.late)} emails waiting on them: clear the oldest first`
          : typical && load >= Math.max(6, typical * 1.6)
            ? `Carrying ${load} open tickets, well above the team's ${Math.round(typical)}: move some work`
            : firstPass != null && firstPass < 50
              ? "Half their designs come back for changes: look at the AI's notes and the client's feedback together"
              : turnaround != null && turnaround > DESIGN_TARGET * 1.5
                ? `Turnaround ${turnaround}d against a ${DESIGN_TARGET}d target`
                : null;
      const role = roleOf.get(id) ?? "email_designer";
      const b = sbBy.get(id) ?? { ...blankSb(), items: [] };
      const fx = (fixesBy.get(id) ?? []).sort((a, z) => z.at.localeCompare(a.at));
      const met = metBy.get(id);
      const held = heldBy.get(id)?.size ?? 0;
      const pushed = [...(pushedBy.get(id)?.values() ?? [])];
      return {
        profileId: id,
        name: w.nameOf.get(id) ?? "Someone",
        role: roleLabel(role as TeamRole),
        roleKey: role === "email_designer" ? "email_designer" : role === "email_builder" ? "email_builder" : "other",
        score,
        previous,
        level: LEVEL(score),
        pieces: mine.length,
        turnaround,
        turnaroundTarget: DESIGN_TARGET,
        firstPass,
        revisionTurnaround,
        onTime: onTimeOf(mine),
        sitting: o.sitting,
        open: o.kaizen,
        late: o.late,
        messages: o.messages,
        act,
        plate: o.plate.sort((a, z) => Number(z.late) - Number(a.late) || (a.due ?? "9").localeCompare(z.due ?? "9")),
        revisions: b.items.sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 12),
        sendbacks: { d45: b.d45, d90: b.d90 },
        fixes: { d45: fx.filter((f) => f.at >= d45).length, d90: fx.length, items: fx.slice(0, 12) },
        errors: errorsOf(id, "design"),
        briefToDone: avgDays(reach90.filter((x) => x.person === id)),
        metDue: { pct: met?.of ? Math.round((met.met / met.of) * 100) : null, of: met?.of ?? 0, missed: (met?.missed ?? []).sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 12) },
        pushedBack: { pct: held ? Math.round((pushed.length / held) * 100) : null, of: held, items: pushed.sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 12) },
        winners: (winsBy.get(id) ?? []).sort((a, z) => (z.clickLift ?? 0) - (a.clickLift ?? 0)),
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.pieces - a.pieces);

  const teamAvg = {
    briefToDone: mean(makers.map((m) => m.briefToDone)),
    metDue: mean(makers.map((m) => m.metDue.pct)),
    pushedBack: mean(makers.map((m) => m.pushedBack.pct)),
    revisionTurnaround: mean(makers.map((m) => m.revisionTurnaround)),
    winners: makers.reduce((n, m) => n + m.winners.length, 0),
  };

  // ─── Each email client's sending this cycle, against last cycle ───
  const startOf = new Map(w.usage.map((u) => [u.client_id, u]));
  const ny = ymdNY(new Date());
  const monthStart = `${ny.slice(0, 7)}-01`;
  const shiftMonth = (ymd: string, by: number) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 + by, d)).toISOString().slice(0, 10);
  };
  const dismissedOf = new Map(w.dismissals.map((d) => [`${d.client_id}:${String(d.period_start).slice(0, 10)}`, { reason: (d.reason as string | null) ?? null, by: (d.profiles as unknown as { full_name: string } | null)?.full_name ?? null, at: d.dismissed_at as string }]));
  const openFor = new Map<string, number>();
  for (const p of pieces.filter((x) => x.open && x.clientId)) openFor.set(p.clientId!, (openFor.get(p.clientId!) ?? 0) + 1);
  // Each email client's platform: when it isn't reading, the row says so instead of showing nothing sent
  const emailIds = [...w.clients.values()].filter((c) => c.email).map((c) => c.id);
  const [{ emailConnections }, { emailClientState, providerName }] = await Promise.all([import("@/lib/email-providers/which"), import("@/lib/email-providers/core")]);
  const conns = await emailConnections(db, emailIds).catch(() => null);
  const syncFor = (clientId: string): Cadence["sync"] => {
    // The connections couldn't be read at all: say nothing rather than guess
    if (!conns) return { ok: true, provider: null, label: "", detail: null };
    const c = conns.get(clientId) ?? null;
    const name = providerName(c?.provider);
    const st = emailClientState(c?.provider ?? "klaviyo", c ? { status: c.status, lastSyncedAt: c.lastSyncedAt, error: c.lastError } : null);
    const s = syncOf(st.state, name, c?.lastSyncedAt ?? null, st.error ? `${st.error.message}${st.error.fix ? ` ${st.error.fix}` : ""}` : null);
    return { ...s, provider: c ? name : null };
  };
  const liveKaizen = (clientId: string, from: string, to: string) => w.messages.filter((m) => m.client_id === clientId && m.live_at && (m.live_at as string) >= from && (m.live_at as string) < to && !m.provider_ref).length;
  const cadence: Cadence[] = [...w.clients.values()]
    .filter((c) => c.email)
    .map((c) => {
      const u = startOf.get(c.id);
      const start = u?.period_start ?? monthStart;
      const end = u?.period_end ?? shiftMonth(monthStart, 1);
      const prevStart = shiftMonth(start, -1);
      const sentIn = (from: string, to: string) => w.sent.filter((s) => s.clientId === c.id && s.sendTime && s.sendTime.slice(0, 10) >= from && s.sendTime.slice(0, 10) < to).length + liveKaizen(c.id, `${from}T00:00:00`, `${to}T00:00:00`);
      const tomorrow = ymdNY(new Date(Date.now() + 86_400_000));
      const sent = sentIn(start, tomorrow < end ? tomorrow : end);
      const usual = sentIn(prevStart, start);
      const span = Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`);
      const elapsed = span > 0 ? Math.max(0, Math.min(1, (Date.now() - Date.parse(`${start}T00:00:00`)) / span)) : 0;
      const open = openFor.get(c.id) ?? 0;
      return { id: c.id, name: c.name, slug: c.slug, sent, usual, open, elapsed, resets: end, periodStart: start, status: cadenceStatus({ sent, usual, open, elapsed }), dismissed: dismissedOf.get(`${c.id}:${start}`) ?? null, sync: syncFor(c.id) };
    })
    .sort((a, b) => Number(Boolean(a.dismissed)) - Number(Boolean(b.dismissed)) || Number(a.sync.ok) - Number(b.sync.ok) || CADENCE_ORDER[a.status] - CADENCE_ORDER[b.status] || a.name.localeCompare(b.name));

  // ─── Workload: each designer's open tickets and emails ───
  // Everyone on the email team (designers, builders and strategists), each once, with what they hold right now
  const workload: Workload[] = [...everyone]
    .map((id) => {
      const o = plateBy.get(id);
      const role = roleOf.get(id) ?? "email_designer";
      return { profileId: id, name: w.nameOf.get(id) ?? "Someone", role: roleLabel(role as TeamRole), roleKey: role, open: o?.plate.length ?? 0, messages: o?.messages ?? 0, late: o?.late ?? 0, asana: o?.asana ?? 0, oldest: o?.oldest ?? 0 };
    })
    .sort((a, b) => b.late - a.late || b.open - a.open || a.name.localeCompare(b.name));

  // ─── Builders: builds, turnaround, what came back, real errors, due dates pushed ───
  const builds = buildPasses(pieces, since, nowIso);
  const returns = buildReturns(pieces, since);
  const builders: BuildMaker[] = [...build]
    .map((id): BuildMaker => {
      const mine = builds.filter((x) => x.person === id);
      const back = returns.filter((x) => x.person === id);
      const o = plateBy.get(id) ?? { plate: [], late: 0, messages: 0, asana: 0, oldest: 0, sitting: 0, kaizen: 0 };
      const held = heldBy.get(id)?.size ?? 0;
      const pushed = [...(pushedBy.get(id)?.values() ?? [])];
      const turnaround = avgDays(mine);
      const returnRate = pct(back.length, mine.length);
      const act =
        o.late >= 2
          ? `${o.late} builds late: clear the oldest first`
          : returnRate != null && returnRate >= 30
            ? `${returnRate}% of builds came back: check links, images and send settings before passing on`
            : turnaround != null && turnaround > BUILD_TARGET * 1.5
              ? `Turnaround ${turnaround}d against a ${BUILD_TARGET}d target`
              : null;
      return {
        profileId: id,
        name: w.nameOf.get(id) ?? "Someone",
        role: roleLabel((roleOf.get(id) ?? "email_builder") as TeamRole),
        builds: mine.length,
        turnaround,
        turnaroundTarget: BUILD_TARGET,
        onTime: onTimeOf(mine),
        returns: back.length,
        returnRate,
        returned: back.map((x) => refOf(x.piece, "Came back to build", x.at)).sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 12),
        errors: errorsOf(id, "build"),
        pushedBack: { pct: held ? Math.round((pushed.length / held) * 100) : null, of: held, items: pushed.sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 12) },
        plate: o.plate.slice().sort((a, z) => Number(z.late) - Number(a.late) || (a.due ?? "9").localeCompare(z.due ?? "9")),
        late: o.late,
        act,
      };
    })
    .sort((a, b) => b.builds - a.builds || a.name.localeCompare(b.name));

  // ─── Strategists: their accounts, requests, how long work sits with them, replies, reports ───
  const strategists = await strategistCards(db, w, strategy, plateBy, since, nowIso);

  // ─── Where changes come from, and the clients sending the most back ───
  const rounds = clientRounds(pieces, since, nowIso);
  const perClient = new Map<string, { client: string; slug: string | null; pieces: Set<string>; back: number; days: number[] }>();
  for (const p of pieces) {
    if (!p.client) continue;
    const k = p.slug ?? p.client;
    for (const s of p.stints) {
      if (s.stage !== "with_client" || !s.to || s.to < since) continue;
      const b = perClient.get(k) ?? { client: p.client, slug: p.slug, pieces: new Set(), back: 0, days: [] };
      b.pieces.add(p.key);
      if (s.next === "revisions") b.back++;
      perClient.set(k, b);
    }
  }
  for (const x of reach) {
    if (!x.piece.client) continue;
    const k = x.piece.slug ?? x.piece.client;
    const b = perClient.get(k) ?? { client: x.piece.client, slug: x.piece.slug, pieces: new Set(), back: 0, days: [] };
    b.days.push(x.days);
    perClient.set(k, b);
  }
  const revisionClients = [...perClient.values()]
    .filter((b) => b.back > 0)
    .map((b) => ({ client: b.client, slug: b.slug, perPiece: Math.round((b.back / Math.max(1, b.pieces.size)) * 10) / 10, pieces: b.pieces.size, recent: (recentByClient.get(b.slug ?? "") ?? []).sort((a, z) => (z.at ?? "").localeCompare(a.at ?? "")).slice(0, 5) }))
    .sort((a, b) => b.perPiece - a.perPiece || b.pieces - a.pieces);
  const slowClients = [...perClient.values()]
    .filter((b) => b.days.length >= 2)
    .map((b) => ({ client: b.client, slug: b.slug, days: r1(avg(b.days)) ?? 0, pieces: b.days.length }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 6);

  // ─── The emails: best and worst designs this period, tiring flows ───
  const scored = cur.filter((x) => x.v);
  const winners = scored
    .filter((x) => x.v === "winner")
    .sort((a, b) => (b.c.clickRate ?? 0) / (base.get(b.c.clientId)?.click || 1) - (a.c.clickRate ?? 0) / (base.get(a.c.clientId)?.click || 1))
    .slice(0, 6)
    .map((x) => resultOf(x.c, x.v, "click"));
  const losers = scored
    .filter((x) => x.v === "loser")
    .sort((a, b) => (a.c.clickRate ?? 0) / (base.get(a.c.clientId)?.click || 1) - (b.c.clickRate ?? 0) / (base.get(b.c.clientId)?.click || 1))
    .slice(0, 3)
    .map((x) => resultOf(x.c, x.v, "click"));
  const designs = new Map<string, string>();
  for (const [k, l] of links) if (l.design) designs.set(k, l.design);
  const credited = makers.flatMap((m) => m.winners).slice(0, 60);
  await picturesFor(db, [...winners, ...losers, ...credited], designs).catch(() => null);
  const openFlows = pieces.filter((p) => p.open && p.source === "kaizen");
  const tiring = flowTiring(w, "click", openFlows);

  // ─── Act on this first ───
  const late = lateTickets(w, () => true);
  const actions: EmailAction[] = [];
  const counted = cadence.filter((c) => !c.dismissed);
  // A client whose platform isn't reading can't be judged on sends: it's flagged as not syncing instead
  const blind = counted.filter((c) => !c.sync.ok);
  const none = counted.filter((c) => c.sync.ok && c.status === "none");
  const behind = counted.filter((c) => c.sync.ok && c.status === "behind");
  if (blind.length) actions.push({ key: "sync", tone: "bad", title: `${blind.length} email ${blind.length === 1 ? "client's numbers aren't" : "clients' numbers aren't"} syncing, so their sends can't be counted`, detail: blind.slice(0, 3).map((c) => `${c.name}: ${c.sync.label}`).join(" · "), href: "/board/email?view=kpis&tab=design&cadence=all#cadence" });
  if (none.length) actions.push({ key: "none", tone: "bad", title: `${none.length} email ${none.length === 1 ? "client has" : "clients have"} nothing sent and nothing in the works this cycle`, detail: none.slice(0, 3).map((c) => c.name).join(", "), href: "/board/email?view=kpis&cadence=critical#cadence" });
  if (late.length) actions.push({ key: "late", tone: late.length >= 5 ? "bad" : "warn", title: `${late.length} ${late.length === 1 ? "ticket is" : "tickets are"} late on the Email Board`, detail: `Oldest: ${handle(late[0].number)} ${late[0].title} (${late[0].hoursOver}h over)`, href: `/board/email?t=${late[0].number}` });
  if (behind.length) actions.push({ key: "behind", tone: "warn", title: `${behind.length} ${behind.length === 1 ? "client is" : "clients are"} sending behind last cycle's pace`, detail: behind.slice(0, 3).map((c) => `${c.name} ${c.sent} of ${c.usual}`).join(" · "), href: "/board/email?view=kpis&cadence=critical#cadence" });
  for (const m of makers.filter((x) => x.act && /open tickets|waiting on them/.test(x.act)).slice(0, 2)) actions.push({ key: `load-${m.profileId}`, tone: "warn", title: `${m.name}: ${m.act}`, detail: `${m.plate.length} on their plate, ${m.late} late`, href: `/board/email?view=kpis&person=${m.profileId}` });
  if (cr.rate != null && crPrev.rate != null && cr.rate - crPrev.rate >= 10)
    actions.push({ key: "revspike", tone: "warn", title: `Client revisions jumped to ${cr.rate}% (from ${crPrev.rate}%)`, detail: revisionClients[0] ? `Most from ${revisionClients[0].client} (${revisionClients[0].perPiece} per ticket)` : "Look at what clients are asking to change", href: revisionClients[0]?.slug ? `/clients/${revisionClients[0].slug}` : "/board/email" });
  else if (revisionClients[0] && revisionClients[0].perPiece >= 1.5) actions.push({ key: "revclient", tone: "warn", title: `${revisionClients[0].client} sends back ${revisionClients[0].perPiece} rounds per ticket`, detail: "Check the brief and their Brand Bible's dos and don'ts before the next design", href: revisionClients[0].slug ? `/clients/${revisionClients[0].slug}` : "/board/email" });
  const waiting = tiring.filter((t) => !t.refreshing);
  if (waiting.length >= 2) actions.push({ key: "tiring", tone: "warn", title: `${waiting.length} flows are clicking less with no refresh in the works`, detail: waiting.slice(0, 3).map((t) => `${t.client}: ${t.flow}`).join(" · "), href: "/board/email?view=kpis#tiring" });

  return {
    period,
    days: w.days,
    headlines,
    makers,
    cadence,
    workload,
    revisionClients: revisionClients.slice(0, 8),
    slowClients,
    late,
    teamAvg,
    teamSendbacks,
    fixes: { d45: fixesIn(d45, nowIso), d90: fixesIn(d90, nowIso) },
    winners,
    losers,
    results: { judged: hr.w + hr.l + hr.par, winners: hr.w, losers: hr.l, par: hr.par, hitRate: hr.rate, previousHitRate: hrOld.rate },
    tiring: tiring.slice(0, 9),
    actions: actions.slice(0, 6),
    split: { copy: rounds.copy, design: rounds.design },
    source: { asana: pieces.filter((p) => p.source === "asana").length, kaizen: pieces.filter((p) => p.source === "kaizen").length, linked: links.size },
    builders,
    strategists,
    members: { design: [...design], build: [...build], copy: [...membersOf("email", "copy", w.people, allSeats)], strategy: [...strategy] },
    errorsUnsorted: errs.unsorted,
  };
}

type Plate = { plate: TaskRef[]; late: number; messages: number; asana: number; oldest: number; sitting: number; kaizen: number };

/** The strategists' scorecards (the Strategy tab) */
async function strategistCards(db: SupabaseClient, w: World, ids: Set<string>, plateBy: Map<string, Plate>, since: string, nowIso: string): Promise<StrategistCard[]> {
  if (!ids.size) return [];
  const list = [...ids];
  const today = ymdNY(new Date());
  // Their accounts: every client they hold the strategist seat on
  const accountsOf = new Map<string, string[]>();
  for (const [clientId, seats] of w.seats) for (const s of seats) if (s.role === "email_strategist" && ids.has(s.profile_id) && w.clients.get(clientId)?.email) accountsOf.set(s.profile_id, [...new Set([...(accountsOf.get(s.profile_id) ?? []), clientId])]);
  const accountIds = [...new Set([...accountsOf.values()].flat())];
  const seatStrategist = (clientId: string | null) => (clientId ? pickSeat(w.seats.get(clientId) ?? [], "email_strategist") : null);
  const monthAgo = ymdNY(new Date(Date.now() - 30 * 86_400_000));
  const sinceDay = since.slice(0, 10);
  const [{ loadEmailScores }, owed, reports, pastScores] = await Promise.all([
    import("@/lib/email-score-load"),
    readAll<Row>((a, b) => db.from("owed_replies").select("target_id, asked_at, answered_at, status").in("target_id", list).gte("asked_at", since).order("asked_at").range(a, b), 5).catch(() => [] as Row[]),
    readAll<Row>((a, b) => db.from("reports").select("client_id, owner_id, kind, period_end, posted_at, status").eq("platform", "klaviyo").in("kind", ["weekly", "monthly"]).is("target_id", null).gte("period_end", sinceDay).order("period_end").range(a, b), 5).catch(() => [] as Row[]),
    // The scores kept a day at a time: the oldest within the last month is the trend's starting point
    accountIds.length
      ? Promise.resolve(db.from("email_score_days").select("client_id, day, score").in("client_id", accountIds).gte("day", monthAgo).order("day")).then((r) => (r.error ? [] : ((r.data ?? []) as Row[]))).catch(() => [] as Row[])
      : Promise.resolve([] as Row[]),
  ]);
  const scores = accountIds.length ? await loadEmailScores(db, accountIds).catch(() => new Map<string, { score: number }>()) : new Map<string, { score: number }>();
  // Today's scores kept for the trend (once a day per client; a table not there yet is skipped)
  if (scores.size) await db.from("email_score_days").upsert([...scores].map(([client_id, s]) => ({ client_id, day: today, score: Math.round(s.score) })), { onConflict: "client_id,day", ignoreDuplicates: true }).then(() => null, () => null);
  const firstScore = new Map<string, { day: string; score: number }>();
  for (const r of pastScores) if (!firstScore.has(r.client_id as string) && String(r.day) < today) firstScore.set(r.client_id as string, { day: String(r.day), score: Number(r.score) });

  const holds = holdTimes(w.pieces, STRATEGIST_STAGES, since, nowIso);
  return list
    .map((id): StrategistCard => {
      // Accounts
      const mine = accountsOf.get(id) ?? [];
      const scored = mine.filter((c) => scores.has(c));
      const now = scored.length ? Math.round(scored.reduce((n, c) => n + scores.get(c)!.score, 0) / scored.length) : null;
      const withPast = scored.filter((c) => firstScore.has(c));
      const before = withPast.length ? Math.round(withPast.reduce((n, c) => n + firstScore.get(c)!.score, 0) / withPast.length) : null;
      const nowSame = withPast.length ? Math.round(withPast.reduce((n, c) => n + scores.get(c)!.score, 0) / withPast.length) : null;
      const sinceDayOf = withPast.map((c) => firstScore.get(c)!.day).sort()[0] ?? null;
      const lowest = scored
        .map((c) => ({ name: w.clients.get(c)!.name, slug: w.clients.get(c)!.slug, score: Math.round(scores.get(c)!.score) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 3);
      // Requests: theirs on the Board (who put the ticket in), else the client's strategist seat for Asana tasks
      const asked = w.pieces.filter((p) => p.createdAt >= since && (w.requestedBy.get(p.key) ?? seatStrategist(p.clientId)) === id);
      const timed = asked.map((p) => ({ p, t: requestTimeliness(p.createdAt, p.dueFirst) })).filter((x): x is { p: Piece; t: NonNullable<ReturnType<typeof requestTimeliness>> } => x.t != null);
      const lateAsks = timed.filter((x) => !x.t.onTime);
      // Work sitting with them: finished stints in their stages, and what's past target on their plate now
      const theirs = holds.filter((h) => h.person === id);
      const over = theirs.length ? theirs.reduce((n, h) => n + h.days / Math.max(0.5, h.target), 0) / theirs.length : null;
      const sittingNow = w.pieces.filter((p) => p.open && p.holderNow === id && STRATEGIST_STAGES.includes(p.stage) && sittingDays(p) > (p.stage === "done" ? 0 : emailStageInfo(p.stage as EmailStage).days));
      const replies = replyStats(owed.filter((o) => o.target_id === id).map((o) => ({ asked_at: o.asked_at as string, answered_at: (o.answered_at as string | null) ?? null, status: String(o.status) })));
      const theirReports = reports.filter((r) => ((r.owner_id as string | null) ?? seatStrategist(r.client_id as string)) === id);
      const rep = reportTimeliness(theirReports.map((r) => ({ kind: String(r.kind), periodEnd: String(r.period_end), postedAt: (r.posted_at as string | null) ?? null, status: (r.status as string | null) ?? null })), today);
      const lateReports = theirReports.filter((r) => rep.lateItems.some((l) => l.kind === r.kind && l.periodEnd === String(r.period_end)));
      const bottleneck = isBottleneck(over == null ? null : r1(over), sittingNow.length);
      const avgDays = theirs.length ? r1(theirs.reduce((n, h) => n + h.days, 0) / theirs.length) : null;
      const act = bottleneck
        ? `${sittingNow.length || theirs.length} items waiting on them past target: they're the bottleneck right now`
        : replies.escalated
          ? `${replies.escalated} ${replies.escalated === 1 ? "reply is" : "replies are"} escalated: answer first`
          : rep.late >= 2
            ? `${rep.late} client reports went out late`
            : lateAsks.length >= 3
              ? `${lateAsks.length} requests came in under the ${REQUEST_LEAD_DAYS} business days a send needs: plan sends earlier`
              : null;
      return {
        profileId: id,
        name: w.nameOf.get(id) ?? "Someone",
        role: roleLabel((w.people.find((p) => p.id === id)?.role ?? "email_strategist") as TeamRole),
        accounts: { n: mine.length, scored: scored.length, avg: now, before, since: sinceDayOf, trend: trendOf(nowSame, before, 2), lowest },
        requests: { of: timed.length, onTime: pct(timed.length - lateAsks.length, timed.length), avgShort: lateAsks.length ? r1(lateAsks.reduce((n, x) => n + x.t.short, 0) / lateAsks.length) : null, late: lateAsks.map((x) => refOf(x.p, `Asked ${x.t.lead} business days before send (needs ${x.t.lead + x.t.short})`, x.p.createdAt)).slice(0, 12) },
        response: { avgDays, target: 1, stints: theirs.length, sitting: sittingNow.length, bottleneck, items: sittingNow.map((p) => refOf(p, `With them ${r1(sittingDays(p))} business days`)).slice(0, 12) },
        replies,
        reports: { onTime: rep.onTime, late: rep.late, rate: rep.rate, lateItems: lateReports.map((r) => { const l = rep.lateItems.find((x) => x.kind === r.kind && x.periodEnd === String(r.period_end))!; return { client: w.clients.get(r.client_id as string)?.name ?? "A client", ...l }; }).slice(0, 12) },
        plate: (plateBy.get(id)?.plate ?? []).slice().sort((a, z) => Number(z.late) - Number(a.late) || (a.due ?? "9").localeCompare(z.due ?? "9")),
        act,
      };
    })
    .sort((a, b) => Number(b.response.bottleneck) - Number(a.response.bottleneck) || (a.accounts.avg ?? 101) - (b.accounts.avg ?? 101) || a.name.localeCompare(b.name));
}

// ─── Email copy KPIs ──────────────────────────────────────────────────────────

export async function loadEmailCopyKpis(db: SupabaseClient, period: Period): Promise<EmailCopyKpis> {
  const w = await loadWorld(db, period);
  const { since, before, pieces } = w;
  const nowIso = new Date(Date.now() + 60_000).toISOString();
  const appr = copyApprovals(pieces, since, nowIso);
  const apprPrev = copyApprovals(pieces, before, since);
  const rounds = clientRounds(pieces, since, nowIso);
  const roundsPrev = clientRounds(pieces, before, since);
  const avgOf = (xs: (number | null)[]) => r1(avg(xs.filter((x): x is number => x != null)));
  const fpOf = (xs: { firstPass: boolean | null }[]) => {
    const k = xs.filter((x) => x.firstPass != null);
    return pctOf(k.filter((x) => x.firstPass).length, k.length);
  };
  const rewritesPer = (xs: { rewrites: number; piece: Piece }[]) => {
    const k = xs.filter((x) => x.piece.source === "kaizen");
    return k.length ? r1(k.reduce((n, x) => n + x.rewrites, 0) / k.length) : null;
  };
  const clientPass = (r: { reviewed: number; copyBack: Piece[] }) => (r.reviewed ? Math.round(((r.reviewed - r.copyBack.length) / r.reviewed) * 100) : null);

  // Subject lines judged on opens, against each account's usual
  const base = baselines(w.sent.filter((c) => c.sendTime && c.sendTime >= w.d90));
  const judged = (from: string, to: string) => w.sent.filter((c) => isEmail(c) && c.sendTime && c.sendTime >= from && c.sendTime < to && w.clients.get(c.clientId)?.email).map((c) => ({ c, v: judge(c, base.get(c.clientId), "open") }));
  const cur = judged(since, nowIso);
  const old = judged(before, since);
  const hr = hitRate(cur.map((x) => x.v));
  const hrOld = hitRate(old.map((x) => x.v));
  const weighted = (xs: { c: Sent }[]) => {
    const have = xs.filter((x) => x.c.openRate != null && x.c.recipients > 0);
    const n = have.reduce((a, x) => a + x.c.recipients, 0);
    return n ? pct1(have.reduce((a, x) => a + (x.c.openRate as number) * x.c.recipients, 0) / n) : null;
  };
  const openNow = weighted(cur);
  const openBefore = weighted(old);
  const share = (r: { copy: number; design: number }) => (r.copy + r.design ? Math.round((r.copy / (r.copy + r.design)) * 100) : null);

  const turn = avgOf(appr.map((x) => x.days));
  const turnPrev = avgOf(apprPrev.map((x) => x.days));
  const draftH = avgOf(appr.map((x) => x.draftHours));
  const headlines: Headline[] = [
    { key: "total", label: "Copy for review → approved", value: turn, unit: "d", previous: turnPrev, better: "down", tone: tone(turn, (x) => x <= 1, (x) => x <= 2), verdict: verdictOf("Copy turnaround", turn, turnPrev, "d", "down", "copy approved"), hint: `AI copy in ${draftH == null ? "—" : `${draftH}h`} · ${appr.length} tickets approved` },
    { key: "pass", label: "AI copy approved first time", value: fpOf(appr), unit: "%", previous: fpOf(apprPrev), better: "up", tone: tone(fpOf(appr), (x) => x >= 70, (x) => x >= 50), verdict: verdictOf("AI first pass", fpOf(appr), fpOf(apprPrev), "%", "up", "copy approved"), hint: "approved with no rewrite asked" },
    { key: "client", label: "Approved first time (client)", value: clientPass(rounds), unit: "%", previous: clientPass(roundsPrev), better: "up", tone: tone(clientPass(rounds), (x) => x >= 80, (x) => x >= 60), verdict: verdictOf("Client first pass", clientPass(rounds), clientPass(roundsPrev), "%", "up", "tickets the client reviewed"), hint: `no copy change asked · ${rounds.reviewed} reviewed` },
    { key: "rewrites", label: "Rewrites per ticket", value: rewritesPer(appr), unit: "", previous: rewritesPer(apprPrev), better: "down", tone: tone(rewritesPer(appr), (x) => x <= 0.3, (x) => x <= 0.8), verdict: rewritesPer(appr) == null ? "No copy approved on the Board in this period yet." : rewritesPer(apprPrev) == null ? `${rewritesPer(appr)} per ticket. Nothing to compare with yet.` : `${rewritesPer(appr)} per ticket (${rewritesPer(apprPrev)} the period before).`, hint: "times the strategist sent the AI back to write again" },
    { key: "subjects", label: "Subjects that out-open", value: hr.rate, unit: "%", previous: hrOld.rate, better: "up", tone: tone(hr.rate, (x) => x >= 40, (x) => x >= 25), verdict: verdictOf("Subject hit rate", hr.rate, hrOld.rate, "%", "up", "subject lines judged"), hint: `opens ${openNow == null ? "—" : `${openNow}%`} send-weighted · ${hr.w + hr.l} judged` },
    { key: "share", label: "Client changes that are copy", value: share(rounds), unit: "%", previous: share(roundsPrev), better: "down", tone: null, verdict: rounds.copy + rounds.design ? `${rounds.copy} copy changes against ${rounds.design} design changes.` : "No client changes in this period.", hint: "of everything clients asked to change" },
  ];

  // ─── Strategists ───
  const roleOf = new Map(w.people.map((p) => [p.id, p.role]));
  // The Copy tab: strategists only (by role; never a designer, a head or an exec who approved some copy)
  const ids = membersOf("email", "copy", w.people, [...w.seats.values()].flat());
  const backs = sendbacksOf(pieces, since).filter((b) => b.route === "copy" && b.kind === "client");
  const links = linksOf(w);
  const seatWriter = (clientId: string) => pickSeat(w.seats.get(clientId) ?? [], "email_strategist");
  const writerOfSent = (c: Sent) => links.get(`${c.clientId}:${c.id}`)?.writer ?? seatWriter(c.clientId);
  const strategists: EmailStrategist[] = [...ids]
    .map((id) => {
      const mine = appr.filter((x) => x.person === id);
      const openCopy = pieces.filter((p) => p.open && p.stage === "copy_review" && p.holderNow === id);
      const late = openCopy.filter((p) => p.minutesOver > 0).length;
      const rewrites = pieces.reduce((n, p) => n + p.rewrites.filter((r) => r.at >= since && writerAt(p, r.at) === id).length, 0);
      const theirSends = cur.filter((x) => writerOfSent(x.c) === id);
      const firstPass = fpOf(mine);
      const sendbacks = backs.filter((b) => b.person === id).length;
      const weeks = Math.max(2, Math.min(13, Math.ceil(w.days / 7)));
      const weekly = Array.from({ length: weeks }, (_, i) => {
        const end = Date.now() - (weeks - 1 - i) * 7 * 86_400_000;
        return appr.filter((x) => x.person === id && Date.parse(x.at) <= end && Date.parse(x.at) > end - 7 * 86_400_000).length;
      });
      const act = late
        ? `${late} ${late === 1 ? "ticket's copy is" : "tickets' copy is"} late: clear the oldest first`
        : openCopy.length >= 6
          ? `${openCopy.length} tickets waiting on their copy review: share the load`
          : firstPass != null && firstPass < 50
            ? "Most AI copy gets rewritten: put what changes in the client's Brand Bible so the AI writes it right first time"
            : sendbacks >= 3
              ? `${sendbacks} tickets came back from clients for copy: check their dos and don'ts`
              : null;
      return { id, name: w.nameOf.get(id) ?? "Someone", role: roleLabel((roleOf.get(id) ?? "email_strategist") as TeamRole), approved: mine.length, turnaround: avgOf(mine.map((x) => x.days)), firstPass, sendbacks, rewrites, openRate: weighted(theirSends), subjects: theirSends.length, open: openCopy.length, late, weekly, act };
    })
    .sort((a, b) => b.approved - a.approved || b.subjects - a.subjects);

  // ─── Clients ───
  const perClient = new Map<string, EmailCopyClient>();
  const slot = (id: string) => {
    const c = w.clients.get(id);
    if (!c) return null;
    const b = perClient.get(id) ?? { id, name: c.name, slug: c.slug, tickets: 0, copyBack: 0, open: 0, openRate: null, usualOpen: pct1(base.get(id)?.open ?? null), lastAsk: null };
    perClient.set(id, b);
    return b;
  };
  for (const x of appr) if (x.piece.clientId) slot(x.piece.clientId)!.tickets++;
  for (const p of rounds.copyBack) if (p.clientId) slot(p.clientId)!.copyBack++;
  for (const p of pieces.filter((x) => x.open && x.stage === "copy_review" && x.clientId)) {
    const b = slot(p.clientId!);
    if (b) b.open++;
  }
  const askedAt = new Map<string, string>();
  for (const p of pieces.filter((x) => x.clientId && x.source === "kaizen")) {
    const ask = p.notes.filter((n) => n.at >= since && n.route === "copy").at(-1);
    if (!ask || (askedAt.get(p.clientId!) ?? "") > ask.at) continue;
    const b = slot(p.clientId!);
    if (!b) continue;
    b.lastAsk = ask.text.slice(0, 140);
    askedAt.set(p.clientId!, ask.at);
  }
  for (const [id, b] of perClient) b.openRate = weighted(cur.filter((x) => x.c.clientId === id));
  const clients = [...perClient.values()].filter((c) => c.tickets || c.open || c.copyBack).sort((a, b) => b.copyBack - a.copyBack || b.open - a.open || b.tickets - a.tickets).slice(0, 14);

  // ─── Subject lines: by style, judged, the best and worst ───
  const judged90 = w.sent.filter((c) => isEmail(c) && c.sendTime && c.sendTime >= w.d90 && w.clients.get(c.clientId)?.email).map((c) => ({ c, v: judge(c, base.get(c.clientId), "open") }));
  const styles = styleResults(judged90.map((x) => ({ subject: x.c.subject, verdict: x.v }))).slice(0, 8);
  const subjects = cur
    .filter((x): x is { c: Sent; v: Verdict } => x.v === "winner" || x.v === "loser")
    .filter((x) => x.c.subject)
    .sort((a, b) => Number(b.v === "winner") - Number(a.v === "winner") || Math.abs(liftOf(b.c.openRate, base.get(b.c.clientId)?.open ?? null) ?? 0) - Math.abs(liftOf(a.c.openRate, base.get(a.c.clientId)?.open ?? null) ?? 0))
    .slice(0, 8)
    .map((x) => ({ subject: x.c.subject!, client: w.clients.get(x.c.clientId)!.name, slug: w.clients.get(x.c.clientId)!.slug, verdict: x.v, openRate: pct1(x.c.openRate), lift: liftOf(x.c.openRate, base.get(x.c.clientId)?.open ?? null) }));
  const asResult = (c: Sent, v: Verdict | null): EmailResult => {
    const cl = w.clients.get(c.clientId)!;
    const b = base.get(c.clientId);
    const link = links.get(`${c.clientId}:${c.id}`);
    const creditId = link?.writer ?? seatWriter(c.clientId);
    return {
      key: `${c.clientId}:${c.id}`,
      clientId: c.clientId,
      client: cl.name,
      slug: cl.slug,
      name: c.name,
      subject: c.subject,
      preview: c.preview,
      sent: c.sendTime,
      recipients: c.recipients,
      openRate: pct1(c.openRate),
      clickRate: pct2(c.clickRate),
      revenue: Math.round(c.revenue),
      rpr: c.recipients ? Math.round((c.revenue / c.recipients) * 1000) / 1000 : null,
      usualOpen: pct1(b?.open ?? null),
      usualClick: pct2(b?.click ?? null),
      clickLift: liftOf(c.clickRate, b?.click ?? null),
      openLift: liftOf(c.openRate, b?.open ?? null),
      verdict: v,
      image: null,
      href: (w.sentSource.get(`${c.clientId}:${c.id}`) ?? "klaviyo") === "klaviyo" ? klaviyoUrl(c.id) : null,
      how: link ? "linked" : "seat",
      credit: creditId ? (w.nameOf.get(creditId) ?? null) : null,
      creditId: creditId ?? null,
      ticket: link?.piece.number ?? null,
    };
  };
  const byLift = (a: { c: Sent }, b: { c: Sent }) => (liftOf(b.c.openRate, base.get(b.c.clientId)?.open ?? null) ?? 0) - (liftOf(a.c.openRate, base.get(a.c.clientId)?.open ?? null) ?? 0);
  const best = cur.filter((x) => x.v === "winner" && x.c.subject).sort(byLift).slice(0, 6).map((x) => asResult(x.c, x.v));
  const worst = cur.filter((x) => x.v === "loser" && x.c.subject).sort((a, b) => byLift(b, a)).slice(0, 3).map((x) => asResult(x.c, x.v));

  // ─── Late copy, rewrites asked, and what to act on ───
  const late = lateTickets(w, (p) => p.stage === "copy_review");
  const rewrites = pieces
    .flatMap((p) => p.rewrites.filter((r) => r.at >= since).map((r) => ({ note: r.note, client: p.client ?? "", slug: p.slug ?? "", number: p.number, by: (() => { const id = writerAt(p, r.at); return id ? (w.nameOf.get(id) ?? null) : null; })(), at: r.at })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);
  const failed = pieces.filter((p) => p.open && p.source === "kaizen" && w.rows.get(p.key)?.copy_status === "failed");
  const actions: EmailAction[] = [];
  if (late.length) actions.push({ key: "late", tone: late.length >= 4 ? "bad" : "warn", title: `${late.length} ${late.length === 1 ? "ticket's copy is" : "tickets' copy is"} late`, detail: `Oldest: ${handle(late[0].number)} ${late[0].title} (${late[0].hoursOver}h over)`, href: `/board/email?t=${late[0].number}` });
  if (failed.length) actions.push({ key: "failed", tone: "bad", title: `The AI couldn't write the copy for ${failed.length} ${failed.length === 1 ? "ticket" : "tickets"}`, detail: failed.slice(0, 3).map((p) => `${handle(p.number!)} ${p.client ?? ""}`).join(" · "), href: `/board/email?t=${failed[0].number}` });
  const rewriteClients = new Map<string, { slug: string; n: number }>();
  for (const r of rewrites) if (r.slug) rewriteClients.set(r.client, { slug: r.slug, n: (rewriteClients.get(r.client)?.n ?? 0) + 1 });
  const heavy = [...rewriteClients].sort((a, b) => b[1].n - a[1].n)[0];
  if (heavy && heavy[1].n >= 3) actions.push({ key: "rewrites", tone: "warn", title: `${heavy[0]}'s AI copy was rewritten ${heavy[1].n} times`, detail: "Put what keeps changing in their Brand Bible so the AI writes it right first time", href: `/clients/${heavy[1].slug}/brand-bible` });
  const backClient = clients.find((c) => c.copyBack >= 2);
  if (backClient) actions.push({ key: "sendbacks", tone: "warn", title: `${backClient.name} sent copy back ${backClient.copyBack} times`, detail: backClient.lastAsk ? `Latest: "${backClient.lastAsk}"` : "Look at what they changed before the next ticket", href: `/clients/${backClient.slug}` });
  const sliding = clients.filter((c) => c.openRate != null && c.usualOpen != null && c.usualOpen > 0 && c.openRate < c.usualOpen * 0.85).sort((a, b) => (a.openRate! / a.usualOpen!) - (b.openRate! / b.usualOpen!))[0];
  if (sliding) actions.push({ key: "opens", tone: "warn", title: `${sliding.name}'s opens fell to ${sliding.openRate}% (usually ${sliding.usualOpen}%)`, detail: "Try new subject line styles from the ones winning below", href: `/clients/${sliding.slug}` });
  for (const s of strategists.filter((x) => x.act && /late|waiting/.test(x.act)).slice(0, 1)) actions.push({ key: `s-${s.id}`, tone: "warn", title: `${s.name}: ${s.act}`, detail: `${s.open} tickets in copy review`, href: `/board/email?person=${s.id}` });

  const opensTiring = flowTiring(w, "open", pieces.filter((p) => p.open && p.source === "kaizen")).slice(0, 6);
  await picturesFor(db, [...best, ...worst], new Map([...links].filter(([, l]) => l.design).map(([k, l]) => [k, l.design!]))).catch(() => null);

  return {
    period,
    days: w.days,
    headlines,
    strategists,
    clients,
    styles,
    subjects,
    late,
    rewrites,
    actions: actions.slice(0, 6),
    split: { copy: rounds.copy, design: rounds.design },
    best,
    worst,
    opensTiring,
    openRate: { now: openNow, before: openBefore, sends: cur.length },
  };
}

