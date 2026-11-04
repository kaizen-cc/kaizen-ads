import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleElapsed } from "@/lib/allotment";
import { packageGaps } from "@/lib/package-gaps";
import { loadProduction, spansOf, type Production, type Scorecard, type Span } from "@/lib/production";
import { roleLabel, type TeamRole } from "@/lib/roles";
import type { HistoryEvent, TaskComment } from "@/lib/asana";
import { loadErrors, type ErrorItem } from "@/lib/creative-errors";
import { loadWatchList, type WatchRow } from "@/lib/fatigue";
import { bizDays } from "@/lib/production";
import { cleanTitle } from "@/lib/task-title";

// The creative team's KPIs for execs and leads, on the Board's KPIs tab: speed, quality and volume against the period
// before, each maker's card, every creative-package client's allotment this billing cycle, how the new creative is
// doing in the ad accounts, and the handful of things to act on first. Production numbers come from the Creative
// board's history (Asana while the team moves over) and the Board's own tickets; allotments from each client's billing
// cycle; creative results from the ledger (profitable winners only, rule one).

export type Period = "cycle" | "30" | "90";
export const PERIODS: { key: Period; label: string }[] = [
  { key: "cycle", label: "This billing month" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
];

export type Tone = "ok" | "warn" | "bad" | null;
export type Headline = { key: string; label: string; value: number | null; unit: "d" | "%" | ""; previous: number | null; better: "down" | "up"; tone: Tone; verdict: string; hint: string };
/** A piece of work shown anywhere on the tab: a Board ticket (opens its drawer) or an Asana task (opens Asana) */
export type TaskRef = { key: string; title: string; urgent?: boolean; client: string | null; stage: string | null; late: boolean; due: string | null; href: string; external: boolean; note: string | null; at: string | null };
export type Sendbacks = { internal: number; client: number; pieces: number };
export type Maker = Scorecard & {
  role: string;
  roleKey: string;
  open: number;
  late: number;
  act: string | null;
  /** Everything on their plate right now */
  plate: TaskRef[];
  /** Pieces of theirs sent back (internal review or the client), last 90 days */
  revisions: TaskRef[];
  sendbacks: { d45: Sendbacks; d90: Sendbacks };
  errors: { d45: number; d90: number; items: ErrorItem[] };
  /** Business days from the brief to the piece first reaching the client (their pieces, last 90 days) */
  briefToDone: number | null;
  /** % of their pieces that reached the client by the due date first set */
  metDue: { pct: number | null; of: number; missed: TaskRef[] };
  /** % of the pieces they held whose due date they moved later, and which */
  pushedBack: { pct: number | null; of: number; items: TaskRef[] };
  /** Profitable winners made from their work */
  winners: WinnerAd[];
};
/** A winner credited to whoever made it: from a ticket launched in Kaizen Ads (certain) or matched by name (likely) */
export type WinnerAd = Winner & { how: "launched" | "name"; task: string | null };
export type ClientAllotment = {
  id: string;
  name: string;
  slug: string;
  used: number;
  cap: number | null;
  elapsed: number; // 0–1 through the billing cycle
  resets: string | null;
  periodStart: string | null;
  status: "ahead" | "on_track" | "behind" | "at_risk" | "missed";
  /** An exec or lead set this cycle aside (a delay, billing dates out of step) */
  dismissed: { reason: string | null; by: string | null; at: string } | null;
};
export type Winner = { key: string; clientId: string; client: string; slug: string; name: string; image: string | null; text: string | null; headline: string | null; cta: string | null; result: string | null; costPerResult: number | null; target: number | null; roas: number | null; spend: number; results: number; days: number };
export type Action = { key: string; tone: "bad" | "warn"; title: string; detail: string; href: string };
export type CreativeKpis = {
  period: Period;
  days: number;
  headlines: Headline[];
  makers: Maker[];
  allotments: ClientAllotment[];
  revisionClients: (Production["revisions"][number] & { recent: TaskRef[] })[];
  slowClients: Production["slow"];
  late: { id: string; number: number; title: string; urgent: boolean; client: string; stage: string; hoursOver: number; assignee: string | null; due: string | null }[];
  /** Team averages for the per-person numbers */
  teamAvg: { briefToDone: number | null; metDue: number | null; pushedBack: number | null; revisionTurnaround: number | null; winners: number };
  teamSendbacks: { d45: Sendbacks; d90: Sendbacks };
  winners: Winner[];
  watch: WatchRow[];
  errorsUnsorted: number;
  results: { launched: number; winners: number; losers: number; testing: number; hitRate: number | null; previousHitRate: number | null; topClients: { name: string; slug: string; winners: number; judged: number }[] };
  tiring: { client: string; slug: string; ad: string; severity: string; thumbnail: string | null; since: string; refreshing: boolean }[];
  actions: Action[];
  split: { copy: number; creative: number };
  source: { asana: boolean };
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

/** How many days "this billing month" covers: the median creative client's days into their cycle (at least a week). */
export function cycleDays(rows: { period_start: string | null }[]) {
  const into = rows
    .map((r) => (r.period_start ? (Date.now() - Date.parse(`${r.period_start}T00:00:00`)) / 86_400_000 : null))
    .filter((x): x is number => x != null && x >= 0)
    .sort((a, b) => a - b);
  const mid = into.length ? into[Math.floor(into.length / 2)] : new Date().getDate();
  return Math.max(7, Math.round(mid));
}

/** "Turnaround is 1.2 days faster than the period before" */
export function verdictOf(label: string, value: number | null, previous: number | null, unit: string, better: "up" | "down", noun: string) {
  if (value == null) return `No ${noun} in this period yet.`;
  if (previous == null) return `${label} is ${value}${unit}. Nothing to compare with yet.`;
  const diff = r1(value - previous) ?? 0;
  if (Math.abs(diff) < (unit === "%" ? 2 : 0.2)) return `${label} is holding steady at ${value}${unit}.`;
  const good = better === "down" ? diff < 0 : diff > 0;
  const amount = unit === "%" ? `${Math.abs(diff)} points` : `${Math.abs(diff)} ${Math.abs(diff) === 1 ? "day" : "days"}`;
  const word = unit === "%" ? (diff > 0 ? "higher" : "lower") : diff > 0 ? "slower" : "faster";
  return `${good ? "Better: " : "Worse: "}${amount} ${word} than the period before.`;
}

const MAKE_COLS = ["make", "client_revision"];
const ymdNY = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const STAGE_NAME: Record<string, string> = {
  requested: "Requested",
  in_production: "In production",
  internal_review: "Internal review",
  copy: "Copy",
  copy_review: "Copy review",
  ready_for_client: "Ready for the client",
  client_review: "With the client",
  client_revision: "Client revision",
  ready_for_launch: "Ready to launch",
  launched: "Launched",
};

/** Whether a span is the person making the piece (a maker's own columns, or worked straight out of the brief column) */
const makes = (s: Span) => MAKE_COLS.includes(s.col) || (s.col === "brief" && s.to != null && s.next != null && s.next !== "brief");

export async function loadCreativeKpis(db: SupabaseClient, period: Period): Promise<CreativeKpis> {
  const { data: usage } = await db.from("client_allotment_usage").select("*");
  const usageRows = (usage ?? []) as { client_id: string; images_per_month: number | null; videos_per_month: number | null; images_used: number; videos_used: number; period_start: string | null; period_end: string | null }[];
  const days = period === "cycle" ? cycleDays(usageRows) : Number(period);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const before = new Date(Date.now() - 2 * days * 86_400_000).toISOString();
  const d90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const d45 = new Date(Date.now() - 45 * 86_400_000).toISOString();

  const [now, prev, { data: clients }, { data: tickets }, { data: people }, gaps, { data: ledger }, { data: asanaRows }, { data: dismissals }, errors, { data: winnersRaw }, watch] = await Promise.all([
    loadProduction(db, days).catch(() => null),
    loadProduction(db, days, days).catch(() => null),
    db.from("clients").select("id, name, slug, creative_package, status").is("archived_at", null).in("status", ["active", "onboarding"]),
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage, assignee_id, assignee_name, creative_id, minutes_over, stage_due_at, created_at, launched_at, internal_rounds, client_rounds, updated_at").is("deleted_at", null).gte("updated_at", d90).limit(2000),
    db.from("profiles").select("id, full_name, role").eq("is_active", true),
    packageGaps(db).catch(() => new Map()),
    db.from("client_ledger").select("client_id, verdict, first_seen").eq("kind", "creative").gte("first_seen", before.slice(0, 10)).limit(5000),
    db.from("asana_tasks").select("gid, name, url, client_id, open, section, due_on, assignee_name, profile_id, asana_created_at, history, comments, clients(name)").gte("asana_modified_at", d90).not("history_read_at", "is", null).limit(2500),
    db.from("allotment_dismissals").select("client_id, period_start, reason, dismissed_at, profiles:dismissed_by(full_name)"),
    loadErrors(db, d90).catch(() => ({ byPerson: new Map<string, ErrorItem[]>(), unsorted: 0 })),
    db.from("client_ledger").select("key, client_id, title, detail, cost_per_result, target, roas, spend, results, result_label, first_seen, last_seen, verdict_at").eq("kind", "creative").eq("verdict", "winner").order("verdict_at", { ascending: false }).limit(12),
    loadWatchList(db, { limit: 9 }).catch(() => [] as WatchRow[]),
  ]);
  // Every profitable winner (to credit its maker), the tickets they came from, and due-date changes on the Board
  const [{ data: allWins }, { data: dueEvents }] = await Promise.all([
    db.from("client_ledger").select("key, client_id, title, detail, cost_per_result, target, roas, spend, results, result_label, first_seen, last_seen").eq("kind", "creative").eq("verdict", "winner").order("first_seen", { ascending: false }).limit(1500),
    db.from("request_events").select("request_id, actor_id, data, created_at").eq("kind", "due").gte("created_at", d90).limit(3000),
  ]);
  const winTickets = [...new Set((allWins ?? []).map((w) => (w.detail as { ticket?: number } | null)?.ticket).filter((n): n is number => typeof n === "number"))];
  const { data: winTicketRows } = winTickets.length ? await db.from("board_requests").select("number, creative_id, assignee_id, title").in("number", winTickets) : { data: [] };
  const clientById = new Map((clients ?? []).map((c) => [c.id as string, c]));
  const team_ = (people ?? []) as { id: string; full_name: string; role: string }[];
  const personFor = (name: string | null) => (name ? team_.find((p) => p.full_name.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(p.full_name.toLowerCase())) : undefined);
  const today = ymdNY(new Date());

  // ─── Headlines ───
  const team = now?.team ?? [];
  const prevTeam = prev?.team ?? [];
  const pooled = (t: Scorecard[], f: (s: Scorecard) => number | null) => {
    const xs = t.filter((s) => s.pieces > 0 && f(s) != null);
    const n = xs.reduce((a, s) => a + s.pieces, 0);
    return n ? Math.round(xs.reduce((a, s) => a + (f(s) ?? 0) * s.pieces, 0) / n) : null;
  };
  const firstPass = pooled(team, (s) => s.firstPass);
  const firstPassPrev = pooled(prevTeam, (s) => s.firstPass);
  const onTime = pooled(team, (s) => s.onTime);
  const onTimePrev = pooled(prevTeam, (s) => s.onTime);

  const judged = (from: string, to: string) => {
    const rows = (ledger ?? []).filter((r) => (r.first_seen as string) >= from.slice(0, 10) && (r.first_seen as string) < to.slice(0, 10));
    const w = rows.filter((r) => r.verdict === "winner").length;
    const l = rows.filter((r) => r.verdict === "loser").length;
    return { rows, w, l, t: rows.filter((r) => r.verdict === "testing").length, rate: w + l ? Math.round((w / (w + l)) * 100) : null };
  };
  const cur = judged(since, new Date(Date.now() + 86_400_000).toISOString());
  const old = judged(before, since);

  const tone = (v: number | null, ok: (x: number) => boolean, warn: (x: number) => boolean): Tone => (v == null ? null : ok(v) ? "ok" : warn(v) ? "warn" : "bad");
  const headlines: Headline[] = [
    { key: "draft", label: "To a first draft", value: now?.firstDraft ?? null, unit: "d", previous: prev?.firstDraft ?? null, better: "down", tone: tone(now?.firstDraft ?? null, (x) => x <= 3, (x) => x <= 5), verdict: verdictOf("Brief to first draft", now?.firstDraft ?? null, prev?.firstDraft ?? null, "d", "down", "pieces reached a client"), hint: `brief → in front of the client · ${now?.pieces ?? 0} pieces` },
    { key: "pass", label: "First-pass approval", value: firstPass, unit: "%", previous: firstPassPrev, better: "up", tone: tone(firstPass, (x) => x >= 70, (x) => x >= 50), verdict: verdictOf("First-pass approval", firstPass, firstPassPrev, "%", "up", "pieces passed on"), hint: "went through with no changes asked" },
    { key: "back", label: "Sent back by clients", value: now?.revisionRate ?? null, unit: "%", previous: prev?.revisionRate ?? null, better: "down", tone: tone(now?.revisionRate ?? null, (x) => x <= 25, (x) => x <= 45), verdict: verdictOf("Client revision rate", now?.revisionRate ?? null, prev?.revisionRate ?? null, "%", "down", "pieces reached a client"), hint: "of pieces, at least once" },
    { key: "rev", label: "Revision turnaround", value: now?.revisionTurnaround ?? null, unit: "d", previous: prev?.revisionTurnaround ?? null, better: "down", tone: tone(now?.revisionTurnaround ?? null, (x) => x <= 1, (x) => x <= 2), verdict: verdictOf("Revision turnaround", now?.revisionTurnaround ?? null, prev?.revisionTurnaround ?? null, "d", "down", "client revisions"), hint: "client revision → back to them" },
    { key: "ontime", label: "On time", value: onTime, unit: "%", previous: onTimePrev, better: "up", tone: tone(onTime, (x) => x >= 80, (x) => x >= 60), verdict: verdictOf("On-time delivery", onTime, onTimePrev, "%", "up", "pieces passed on"), hint: "pieces made within their turnaround target" },
    { key: "hit", label: "New creative that wins", value: cur.rate, unit: "%", previous: old.rate, better: "up", tone: tone(cur.rate, (x) => x >= 30, (x) => x >= 15), verdict: verdictOf("Hit rate", cur.rate, old.rate, "%", "up", "new creative judged"), hint: `profitable winners of ${cur.w + cur.l} judged in the ad accounts` },
  ];

  // ─── Each Asana task's life (90 days), read once for plates, sendbacks and clients' revisions ───
  type T = { gid: string; name: string; url: string | null; clientId: string | null; client: string | null; open: boolean; section: string | null; due: string | null; profileId: string | null; assignee: string | null; spans: Span[]; comments: TaskComment[]; dues: { at: string; from: string | null; to: string | null; by: string | null }[]; createdAt: string };
  const tasks: T[] = (asanaRows ?? []).map((r) => ({
    gid: r.gid as string,
    name: r.name as string,
    url: (r.url as string | null) ?? null,
    clientId: (r.client_id as string | null) ?? null,
    client: (r.clients as unknown as { name: string } | null)?.name ?? null,
    open: Boolean(r.open),
    section: (r.section as string | null) ?? null,
    due: (r.due_on as string | null) ?? null,
    profileId: (r.profile_id as string | null) ?? null,
    assignee: (r.assignee_name as string | null) ?? null,
    spans: spansOf((r.asana_created_at as string) ?? new Date().toISOString(), (r.history ?? []) as HistoryEvent[], r.section as string | null, r.assignee_name as string | null),
    comments: (r.comments ?? []) as TaskComment[],
    dues: ((r.history ?? []) as HistoryEvent[]).filter((e): e is Extract<HistoryEvent, { kind: "due" }> => e.kind === "due").sort((a, b) => a.at.localeCompare(b.at)),
    createdAt: (r.asana_created_at as string) ?? new Date().toISOString(),
  }));
  const asanaRef = (t: T, note: string | null, at: string | null): TaskRef => ({ key: `a:${t.gid}:${at ?? ""}`, ...cleanTitle(t.name), client: t.client, stage: t.section, late: Boolean(t.open && t.due && t.due < today), due: t.due, href: t.url ?? "#", external: true, note, at });
  const ticketRef = (r: Record<string, unknown>, note: string | null = null, at: string | null = null): TaskRef => ({
    key: `t:${r.number}:${at ?? ""}`,
    ...cleanTitle(r.title as string),
    client: (r.client_name as string | null) ?? null,
    stage: STAGE_NAME[r.stage as string] ?? (r.stage as string),
    late: (r.minutes_over as number) > 0,
    due: (r.stage_due_at as string | null) ?? null,
    href: `/board?t=${r.number}`,
    external: false,
    note,
    at,
  });
  /** Who made the piece at a moment (the last maker before it), and who wrote its copy */
  const makerAt = (t: T, at: string) => personFor(t.spans.filter((s) => s.from <= at && s.holder && makes(s)).at(-1)?.holder ?? null);
  const writerAt = (t: T, at: string) => personFor(t.spans.filter((s) => s.from <= at && s.holder && s.col === "copy").at(-1)?.holder ?? null);

  // Sendbacks: internal review sending it back, or the client's revision, against the pieces each person passed on
  const sb = new Map<string, { d45: Sendbacks; d90: Sendbacks; items: TaskRef[] }>();
  const bucket = (id: string) => {
    if (!sb.has(id)) sb.set(id, { d45: { internal: 0, client: 0, pieces: 0 }, d90: { internal: 0, client: 0, pieces: 0 }, items: [] });
    return sb.get(id)!;
  };
  const count = (id: string | undefined, at: string, field: keyof Sendbacks, item?: TaskRef) => {
    if (!id || at < d90) return;
    const b = bucket(id);
    b.d90[field]++;
    if (at >= d45) b.d45[field]++;
    if (item) b.items.push(item);
  };
  const recentByClient = new Map<string, TaskRef[]>();
  for (const t of tasks) {
    t.spans.forEach((s, i) => {
      if (!s.to) return;
      // A piece passed on (its maker's or copywriter's span ended moving forward)
      if (makes(s) && s.next !== s.col) count(personFor(s.holder)?.id, s.to, "pieces");
      if (s.col === "copy" && s.next !== "copy") count(personFor(s.holder)?.id, s.to, "pieces");
      // Internal review sent it back
      if (s.col === "creative_review" && s.next === "make") count(makerAt(t, s.from)?.id, s.to, "internal", asanaRef(t, "Sent back in internal review", s.to));
      if (s.col === "copy_review" && s.next === "copy") count(writerAt(t, s.from)?.id, s.to, "internal", asanaRef(t, "Copy sent back in review", s.to));
      void i;
    });
    for (const s of t.spans.filter((x) => x.col === "client_revision" && x.from >= d90)) {
      const copy = s.next === "copy" || s.next === "copy_review";
      const said = t.comments.filter((m) => m.at >= s.from && (!s.to || m.at <= s.to)).at(-1)?.text ?? null;
      const item = asanaRef(t, said ? `Client: ${said.slice(0, 160)}` : copy ? "Client asked for copy changes" : "Client asked for changes", s.from);
      count((copy ? writerAt(t, s.from) : makerAt(t, s.from))?.id, s.from, "client", item);
      if (t.clientId) recentByClient.set(t.clientId, [...(recentByClient.get(t.clientId) ?? []), item]);
    }
  }
  // The Board's own tickets join in as the team moves over
  for (const r of tickets ?? []) {
    const id = ((r.creative_id ?? r.assignee_id) as string | null) ?? undefined;
    const at = (r.updated_at as string) ?? (r.created_at as string);
    if ((r.internal_rounds as number) > 0) for (let n = 0; n < (r.internal_rounds as number); n++) count(id, at, "internal", n ? undefined : ticketRef(r, `Sent back in internal review (${r.internal_rounds}×)`, at));
    if ((r.client_rounds as number) > 0) {
      const item = ticketRef(r, `Client revisions (${r.client_rounds}×)`, at);
      for (let n = 0; n < (r.client_rounds as number); n++) count(id, at, "client", n ? undefined : item);
      const cid = [...clientById.values()].find((c) => c.slug === r.client_slug)?.id as string | undefined;
      if (cid) recentByClient.set(cid, [...(recentByClient.get(cid) ?? []), item]);
    }
    if (["internal_review", "copy", "copy_review", "ready_for_client", "client_review", "ready_for_launch", "launched"].includes(r.stage as string)) count(id, (r.created_at as string) ?? at, "pieces");
  }
  const teamSendbacks = { d45: { internal: 0, client: 0, pieces: 0 }, d90: { internal: 0, client: 0, pieces: 0 } };
  for (const b of sb.values())
    for (const w of ["d45", "d90"] as const) {
      teamSendbacks[w].internal += b[w].internal;
      teamSendbacks[w].client += b[w].client;
      teamSendbacks[w].pieces += b[w].pieces;
    }

  // ─── Per person: brief to the client, due dates met and pushed back (Asana pieces, and the Board's tickets) ───
  const fmtDay = (x: string) => new Date(x.length === 10 ? `${x}T12:00:00` : x).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  type Per = { done: number[]; met: number; dueOf: number; missed: TaskRef[]; held: Set<string>; pushed: Map<string, TaskRef> };
  const per = new Map<string, Per>();
  const perOf = (id: string) => {
    if (!per.has(id)) per.set(id, { done: [], met: 0, dueOf: 0, missed: [], held: new Set(), pushed: new Map() });
    return per.get(id)!;
  };
  for (const t of tasks) {
    for (const s of t.spans) {
      if (!s.holder || !(makes(s) || s.col === "copy") || (s.to ?? new Date().toISOString()) < d90) continue;
      const p = personFor(s.holder);
      if (p) perOf(p.id).held.add(`a:${t.gid}`);
    }
    const firstClient = t.spans.find((s) => s.col === "client");
    const made = t.spans.filter((s) => s.holder && makes(s)).at(-1);
    const maker = made ? personFor(made.holder) : undefined;
    if (maker && firstClient && firstClient.from >= d90) {
      const p = perOf(maker.id);
      p.done.push(bizDays(t.createdAt, firstClient.from));
      // Against the due date first set (a later push doesn't make it on time)
      const due = t.dues[0]?.from ?? t.dues[0]?.to ?? t.due;
      if (due) {
        p.dueOf++;
        if (ymdNY(new Date(firstClient.from)) <= due.slice(0, 10)) p.met++;
        else p.missed.push(asanaRef(t, `Reached the client ${fmtDay(firstClient.from)}, due ${fmtDay(due)}`, firstClient.from));
      }
    }
    for (const e of t.dues) {
      if (e.at < d90 || !e.from || !e.to || e.to <= e.from) continue;
      const who = personFor(e.by);
      // Counted only when they held the piece at that moment
      const holding = t.spans.find((s) => s.from <= e.at && (!s.to || s.to >= e.at));
      if (!who || !holding?.holder || personFor(holding.holder)?.id !== who.id) continue;
      perOf(who.id).pushed.set(`a:${t.gid}`, asanaRef(t, `Due ${fmtDay(e.from)} → ${fmtDay(e.to)}`, e.at));
    }
  }
  const ticketById = new Map((tickets ?? []).map((r) => [r.id as string, r]));
  for (const r of tickets ?? []) {
    const owner = (r.creative_id ?? r.assignee_id) as string | null;
    if (owner && (r.updated_at as string) >= d90) perOf(owner).held.add(`t:${r.number}`);
  }
  for (const e of dueEvents ?? []) {
    const r = ticketById.get(e.request_id as string);
    const d = (e.data ?? {}) as { from?: string | null; to?: string | null };
    const owner = r ? ((r.creative_id ?? r.assignee_id) as string | null) : null;
    if (!r || !owner || e.actor_id !== owner || !d.from || !d.to || d.to <= d.from) continue;
    perOf(owner).pushed.set(`t:${r.number}`, ticketRef(r, `Due ${fmtDay(d.from)} → ${fmtDay(d.to)}`, e.created_at as string));
  }

  // ─── Winners, credited to whoever made them ───
  const kept = (key: string, image: string | null) => (/^\d{5,25}$/.test(key) ? `/api/ad-media/${key}` : image);
  const toWinner = (w: Record<string, unknown>): Winner => {
    const d = (w.detail ?? {}) as { image?: string; text?: string; headline?: string; cta?: string; name?: string };
    const c = clientById.get(w.client_id as string)!;
    const first = w.first_seen ? Date.parse(`${w.first_seen}T00:00:00`) : Date.now();
    const last = w.last_seen ? Date.parse(`${w.last_seen}T00:00:00`) : Date.now();
    return {
      key: w.key as string,
      clientId: w.client_id as string,
      client: c.name as string,
      slug: c.slug as string,
      name: d.name ?? (w.title as string),
      image: kept(w.key as string, d.image ?? null),
      text: d.text ?? null,
      headline: d.headline ?? (w.title as string) ?? null,
      cta: d.cta ?? null,
      result: (w.result_label as string | null) ?? null,
      costPerResult: w.cost_per_result == null ? null : Number(w.cost_per_result),
      target: w.target == null ? null : Number(w.target),
      roas: w.roas == null ? null : Number(w.roas),
      spend: Number(w.spend ?? 0),
      results: Number(w.results ?? 0),
      days: Math.max(1, Math.round((last - first) / 86_400_000) + 1),
    };
  };
  const ticketMaker = new Map((winTicketRows ?? []).map((r) => [r.number as number, { id: ((r.creative_id ?? r.assignee_id) as string | null) ?? null, title: r.title as string }]));
  const STOP = new Set(["meta", "ads", "need", "new", "creative", "creatives", "image", "images", "video", "videos", "carousel", "urgent", "static", "statics", "round", "post", "boosted", "copy", "with", "from", "this", "that", "variation", "variations", "version", "final", "launch"]);
  const words = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)));
  const winsBy = new Map<string, WinnerAd[]>();
  for (const w of allWins ?? []) {
    const c = clientById.get(w.client_id as string);
    if (!c) continue;
    const d = (w.detail ?? {}) as { ticket?: number; name?: string };
    let who: string | null = null;
    let how: WinnerAd["how"] = "launched";
    let task: string | null = null;
    const fromTicket = typeof d.ticket === "number" ? ticketMaker.get(d.ticket) : undefined;
    if (fromTicket?.id) {
      who = fromTicket.id;
      task = `#${d.ticket} ${cleanTitle(fromTicket.title).title}`;
    } else {
      // Conservative: the client's Asana piece whose title shares two or more real words with the ad's name, made
      // before the ad started (within 75 days), and clearly the best match
      const clientWords = words(c.name as string);
      const adWords = [...words(`${d.name ?? ""} ${w.title ?? ""}`)].filter((x) => !clientWords.has(x));
      const seen = w.first_seen as string;
      const found = tasks
        .filter((t) => t.clientId === w.client_id && t.createdAt.slice(0, 10) <= seen && Date.parse(`${seen}T00:00:00`) - Date.parse(t.createdAt) <= 75 * 86_400_000)
        .map((t) => ({ t, hits: [...words(cleanTitle(t.name).title)].filter((x) => !clientWords.has(x) && adWords.includes(x)).length }))
        .filter((x) => x.hits >= 2)
        .sort((a, b) => b.hits - a.hits);
      if (found.length && (found.length === 1 || found[0].hits > found[1].hits)) {
        const made = found[0].t.spans.filter((s) => s.holder && makes(s)).at(-1);
        const p = made ? personFor(made.holder) : undefined;
        if (p) {
          who = p.id;
          how = "name";
          task = cleanTitle(found[0].t.name).title;
        }
      }
    }
    if (!who) continue;
    winsBy.set(who, [...(winsBy.get(who) ?? []), { ...toWinner(w), how, task }]);
  }

  // ─── Makers ───
  const openBy = new Map<string, { open: number; late: number; plate: TaskRef[] }>();
  const live = (tickets ?? []).filter((t) => t.stage !== "launched");
  for (const t of live) {
    const id = (t.creative_id ?? t.assignee_id) as string | null;
    if (!id) continue;
    const o = openBy.get(id) ?? { open: 0, late: 0, plate: [] };
    o.open++;
    if ((t.minutes_over as number) > 0) o.late++;
    o.plate.push(ticketRef(t));
    openBy.set(id, o);
  }
  for (const t of tasks.filter((x) => x.open)) {
    const id = t.profileId ?? personFor(t.assignee)?.id;
    if (!id) continue;
    const o = openBy.get(id) ?? { open: 0, late: 0, plate: [] };
    const ref = asanaRef(t, null, null);
    o.plate.push(ref);
    if (ref.late) o.late++;
    openBy.set(id, o);
  }
  const roleOf = new Map(team_.map((p) => [p.id, p.role]));
  const loads = team.map((s) => (openBy.get(s.profileId ?? "")?.plate.length ?? 0));
  const typical = avg(loads) ?? 0;
  const makers: Maker[] = team.map((s) => {
    const o = openBy.get(s.profileId ?? "") ?? { open: 0, late: 0, plate: [] };
    const load = o.plate.length;
    const act =
      s.sitting.length >= 3 || o.late >= 2
        ? `${Math.max(s.sitting.length, o.late)} pieces waiting on them: clear the oldest first`
        : typical && load >= Math.max(6, typical * 1.6)
          ? `Carrying ${load} open pieces, well above the team's ${Math.round(typical)}: move some work`
          : s.firstPass != null && s.firstPass < 50
            ? "Half their work comes back for changes: review the briefs and feedback together"
            : s.turnaround != null && s.turnaround > s.turnaroundTarget * 1.5
              ? `Turnaround ${s.turnaround}d against a ${s.turnaroundTarget}d target`
              : null;
    const key = roleOf.get(s.profileId ?? "") ?? (s.kind === "copy" ? "copywriter" : "graphic_designer");
    const b = sb.get(s.profileId ?? "") ?? { d45: { internal: 0, client: 0, pieces: 0 }, d90: { internal: 0, client: 0, pieces: 0 }, items: [] };
    const errs = errors.byPerson.get(s.profileId ?? "") ?? [];
    const plate = o.plate.sort((a, b2) => Number(b2.late) - Number(a.late) || (a.due ?? "9").localeCompare(b2.due ?? "9"));
    const pp = per.get(s.profileId ?? "");
    const doneAvg = pp?.done.length ? r1(avg(pp.done)) : null;
    return {
      ...s,
      role: roleLabel(key as TeamRole),
      roleKey: key,
      open: o.open,
      late: o.late,
      act,
      plate,
      revisions: b.items.sort((a, b2) => (b2.at ?? "").localeCompare(a.at ?? "")).slice(0, 12),
      sendbacks: { d45: b.d45, d90: b.d90 },
      errors: { d45: errs.filter((e) => e.at >= d45).length, d90: errs.length, items: errs.slice(0, 12) },
      briefToDone: doneAvg,
      metDue: { pct: pp?.dueOf ? Math.round((pp.met / pp.dueOf) * 100) : null, of: pp?.dueOf ?? 0, missed: (pp?.missed ?? []).sort((a, b2) => (b2.at ?? "").localeCompare(a.at ?? "")).slice(0, 12) },
      pushedBack: { pct: pp?.held.size ? Math.round((pp.pushed.size / pp.held.size) * 100) : null, of: pp?.held.size ?? 0, items: [...(pp?.pushed.values() ?? [])].sort((a, b2) => (b2.at ?? "").localeCompare(a.at ?? "")).slice(0, 12) },
      winners: (winsBy.get(s.profileId ?? "") ?? []).sort((a, b2) => b2.spend - a.spend),
    };
  });
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const teamAvg = {
    briefToDone: mean(makers.map((m) => m.briefToDone)),
    metDue: mean(makers.map((m) => m.metDue.pct)),
    pushedBack: mean(makers.map((m) => m.pushedBack.pct)),
    revisionTurnaround: mean(makers.map((m) => m.revisionTurnaround)),
    winners: makers.reduce((n, m) => n + m.winners.length, 0),
  };

  // ─── Allotments, per creative-package client, this billing cycle ───
  const dismissedOf = new Map((dismissals ?? []).map((d) => [`${d.client_id}:${d.period_start}`, { reason: (d.reason as string | null) ?? null, by: (d.profiles as unknown as { full_name: string } | null)?.full_name ?? null, at: d.dismissed_at as string }]));
  const allotments: ClientAllotment[] = usageRows
    .map((u) => {
      const c = clientById.get(u.client_id);
      if (!c?.creative_package) return null;
      const cap = u.images_per_month == null && u.videos_per_month == null ? null : (u.images_per_month ?? 0) + (u.videos_per_month ?? 0);
      const used = (u.images_used ?? 0) + (u.videos_used ?? 0);
      const cycle = u.period_start && u.period_end ? { start: u.period_start, end: u.period_end } : null;
      const elapsed = cycleElapsed(cycle);
      const gap = gaps.get(u.client_id);
      const share = cap ? used / cap : null;
      const status: ClientAllotment["status"] = gap?.missed ? "missed" : gap?.atRisk ? "at_risk" : share == null ? "on_track" : share >= elapsed + 0.15 ? "ahead" : share >= elapsed - 0.2 ? "on_track" : "behind";
      return { id: u.client_id, name: c.name as string, slug: c.slug as string, used, cap, elapsed, resets: u.period_end, periodStart: u.period_start, status, dismissed: u.period_start ? (dismissedOf.get(`${u.client_id}:${u.period_start}`) ?? null) : null };
    })
    .filter((x): x is ClientAllotment => x != null);
  const ORDER = { missed: 0, at_risk: 1, behind: 2, on_track: 3, ahead: 4 };
  allotments.sort((a, b) => Number(Boolean(a.dismissed)) - Number(Boolean(b.dismissed)) || ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  // ─── Late tickets on the Board ───
  const late = live
    .filter((t) => (t.minutes_over as number) > 0)
    .sort((a, b) => (b.minutes_over as number) - (a.minutes_over as number))
    .slice(0, 8)
    .map((t) => {
      const c = cleanTitle(t.title as string);
      return { id: t.id as string, number: t.number as number, title: c.title, urgent: c.urgent, client: (t.client_name as string) ?? "", stage: STAGE_NAME[t.stage as string] ?? (t.stage as string), hoursOver: Math.round((t.minutes_over as number) / 60), assignee: (t.assignee_name as string | null) ?? null, due: (t.stage_due_at as string | null) ?? null };
    });

  // ─── Creative in the ad accounts ───
  const byClient = new Map<string, { w: number; j: number }>();
  for (const r of cur.rows) {
    const b = byClient.get(r.client_id as string) ?? { w: 0, j: 0 };
    if (r.verdict === "winner") b.w++;
    if (r.verdict === "winner" || r.verdict === "loser") b.j++;
    byClient.set(r.client_id as string, b);
  }
  const topClients = [...byClient.entries()]
    .filter(([id, b]) => b.w > 0 && clientById.has(id))
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 5)
    .map(([id, b]) => ({ name: clientById.get(id)!.name as string, slug: clientById.get(id)!.slug as string, winners: b.w, judged: b.j }));
  const tiring = (watch ?? []).map((f) => ({ client: f.client, slug: f.clientSlug, ad: f.headline ?? f.adName, severity: f.severity, thumbnail: f.thumbnail, since: f.firstFlaggedAt, refreshing: f.state === "refreshing" }));
  const winners: Winner[] = (winnersRaw ?? [])
    .filter((w) => clientById.has(w.client_id as string))
    .slice(0, 6)
    .map((w) => toWinner(w));

  // ─── Act on this: the few things that matter most, each linking to where it's handled ───
  const actions: Action[] = [];
  const counted = allotments.filter((a) => !a.dismissed);
  const missed = counted.filter((a) => a.status === "missed");
  const risk = counted.filter((a) => a.status === "at_risk" || a.status === "behind");
  if (missed.length) actions.push({ key: "missed", tone: "bad", title: `${missed.length} ${missed.length === 1 ? "client" : "clients"} paid for creative last cycle and got none`, detail: missed.slice(0, 3).map((a) => a.name).join(", "), href: `/clients/${missed[0].slug}` });
  if (late.length) actions.push({ key: "late", tone: late.length >= 5 ? "bad" : "warn", title: `${late.length} ${late.length === 1 ? "ticket is" : "tickets are"} late on the Board`, detail: `Oldest: #${late[0].number} ${late[0].title} (${late[0].hoursOver}h over)`, href: `/board?t=${late[0].number}` });
  if (risk.length) actions.push({ key: "risk", tone: "warn", title: `${risk.length} ${risk.length === 1 ? "client is" : "clients are"} behind on this cycle's allotment`, detail: risk.slice(0, 3).map((a) => `${a.name} ${a.used}/${a.cap ?? "?"}`).join(" · "), href: `/board?view=kpis&allot=behind` });
  const overloaded = makers.filter((m) => m.act && /open pieces|waiting on them/.test(m.act));
  for (const m of overloaded.slice(0, 2)) actions.push({ key: `load-${m.profileId}`, tone: "warn", title: `${m.name}: ${m.act}`, detail: `${m.plate.length} on their plate, ${m.late} late`, href: m.profileId ? `/board?view=kpis&person=${m.profileId}` : "/board" });
  if (now?.revisionRate != null && prev?.revisionRate != null && now.revisionRate - prev.revisionRate >= 10)
    actions.push({ key: "revspike", tone: "warn", title: `Client revisions jumped to ${now.revisionRate}% (from ${prev.revisionRate}%)`, detail: now.revisions[0] ? `Most from ${now.revisions[0].client} (${now.revisions[0].perPiece} per piece)` : "Look at what clients are asking to change", href: now.revisions[0]?.slug ? `/clients/${now.revisions[0].slug}` : "/board" });
  else if (now?.revisions[0] && now.revisions[0].perPiece >= 1.5) actions.push({ key: "revclient", tone: "warn", title: `${now.revisions[0].client} sends back ${now.revisions[0].perPiece} revisions per piece`, detail: "Check the brief and their Brand Bible's dos and don'ts before the next round", href: now.revisions[0].slug ? `/clients/${now.revisions[0].slug}` : "/board" });
  const waitingRefresh = tiring.filter((t) => !t.refreshing);
  if (waitingRefresh.length >= 3) actions.push({ key: "tiring", tone: "warn", title: `${waitingRefresh.length} tiring ads have no refresh in the works`, detail: waitingRefresh.slice(0, 3).map((t) => t.client).join(", "), href: "/board?view=kpis#tiring" });

  const slugToId = new Map([...clientById.values()].map((c) => [c.slug as string, c.id as string]));
  return {
    period,
    days,
    headlines,
    makers,
    allotments,
    revisionClients: (now?.revisions ?? []).map((r) => ({ ...r, recent: (recentByClient.get(slugToId.get(r.slug ?? "") ?? "") ?? []).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 5) })),
    slowClients: now?.slow ?? [],
    late,
    teamAvg,
    teamSendbacks,
    winners,
    watch: watch ?? [],
    errorsUnsorted: errors.unsorted,
    results: { launched: cur.rows.length, winners: cur.w, losers: cur.l, testing: cur.t, hitRate: cur.rate, previousHitRate: old.rate, topClients },
    tiring: tiring.slice(0, 8),
    actions: actions.slice(0, 6),
    split: now?.split ?? { copy: 0, creative: 0 },
    source: { asana: Boolean(now) },
  };
}
