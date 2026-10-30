import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import type { Staff } from "@/lib/auth";
import { nyToday } from "@/lib/dates";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { businessDuration, FORMAT_LABEL, health, stageInfo, type Format, type Stage } from "@/lib/stages";
import type { Alert, ClientPulse, Load, PhaseKey, PhaseStat, QueueItem } from "@/app/(team)/pipeline/views/shared";

// Everything the home pages show, from the live tickets: what's moving and where, what's late, who carries what, how the
// clients' allotments and approvals are going. Read with the viewer's own access rules.

const DAY = 600; // a business day, in business minutes (8am–6pm)

/** The five phases on the home pages, and the stages in each. */
const PHASE_OF: Partial<Record<Stage, PhaseKey>> = {
  requested: "brief",
  in_production: "make",
  client_revision: "make",
  internal_review: "review",
  copy: "review",
  copy_review: "review",
  ready_for_client: "client",
  client_review: "client",
  ready_for_launch: "launch",
};
/** The usual turnaround for each phase, in business days. */
const SLA: Record<PhaseKey, number> = { brief: 1, make: 3, review: 1, client: 2, launch: 1 };
/** About how much open work each role carries at once. */
const CAPACITY: Partial<Record<TeamRole, number>> = { graphic_designer: 10, video_editor: 6, copywriter: 15, media_buyer: 12, customer_success: 20 };

type Row = {
  id: string;
  number: number;
  client_id: string;
  client_name: string;
  client_slug: string;
  title: string;
  format: Format;
  priority: "normal" | "high" | "urgent";
  stage: Stage;
  assignee_id: string | null;
  assignee_name: string | null;
  creative_id: string | null;
  buyer_id: string | null;
  stage_entered_at: string;
  stage_due_at: string | null;
  created_at: string;
  minutes_in_stage: number;
  minutes_over: number;
  internal_rounds: number;
  client_rounds: number;
  new_count: number;
};

/** Weekdays between two moments, as business days (enough for an average). */
function businessDays(from: string, to: string) {
  const a = new Date(from);
  const b = new Date(to);
  let days = 0;
  for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) days++;
  return days || (b.getTime() - a.getTime()) / 86_400_000;
}

const dueLabel = (r: Row) => {
  if (r.minutes_over > 0) return `${businessDuration(r.minutes_over)} late`;
  if (!r.stage_due_at) return "No due date";
  const due = new Date(r.stage_due_at);
  const today = nyToday() === nyToday(due);
  return today
    ? `Today ${due.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`
    : due.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
};

const toQueue = (r: Row, note?: string): QueueItem => ({
  id: r.id,
  href: `/board?t=${r.number}`,
  client: r.client_name,
  title: r.title,
  format: FORMAT_LABEL[r.format],
  stage: stageInfo(r.stage)?.label ?? r.stage,
  due: dueLabel(r),
  tone: health(r.minutes_over, r.stage),
  priority: r.priority === "urgent" ? "Urgent" : r.priority === "high" ? "High" : undefined,
  note,
});

// Worst first: late, then due soonest
const byUrgency = (a: Row, b: Row) => b.minutes_over - a.minutes_over || (a.stage_due_at ?? "9").localeCompare(b.stage_due_at ?? "9");

export async function loadHome(db: SupabaseClient, me: Staff) {
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const cols =
    "id, number, client_id, client_name, client_slug, title, format, priority, stage, assignee_id, assignee_name, creative_id, buyer_id, stage_entered_at, stage_due_at, created_at, minutes_in_stage, minutes_over, internal_rounds, client_rounds, new_count";
  const [{ data: open }, { data: rounds }, { data: usageAll }, { data: people }, { data: events }, { data: copyDone }, { data: liveRows }] = await Promise.all([
    db.from("board_requests").select(cols).neq("stage", "launched").limit(2000),
    db.from("client_rounds").select("request_id, round, decision, created_at, requests(created_at, client_id)").gte("created_at", since30 > month ? month : since30).order("round"),
    db.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used"),
    db.from("profiles").select("id, full_name, role").eq("is_active", true),
    db.from("request_events").select("request_id, kind, to_stage, data, actor_id, created_at").gte("created_at", since30).in("kind", ["review", "stage"]).limit(5000),
    db.from("copy_sets").select("request_id, approved_by, approved_at").gte("approved_at", since7),
    // Paused and archived clients aren't owed creative, so they're never flagged for it
    db.from("clients").select("id").is("archived_at", null).in("status", LIVE),
  ]);
  const liveIds = new Set((liveRows ?? []).map((c) => c.id as string));
  const usage = (usageAll ?? []).filter((u) => liveIds.has(u.client_id as string));
  const rows = (open ?? []) as Row[];
  const roleOf = new Map((people ?? []).map((p) => [p.id, p.role as TeamRole]));

  // ─── Flow ───
  const phases = Object.fromEntries((["brief", "make", "review", "client", "launch"] as PhaseKey[]).map((k) => [k, { count: 0, slaDays: SLA[k] } as PhaseStat])) as Record<PhaseKey, PhaseStat>;
  const sums: Record<string, number> = {};
  for (const r of rows) {
    const k = PHASE_OF[r.stage];
    if (!k) continue;
    phases[k].count++;
    sums[k] = (sums[k] ?? 0) + r.minutes_in_stage / DAY;
  }
  for (const k of Object.keys(phases) as PhaseKey[]) if (phases[k].count) phases[k].avgDays = Math.round((sums[k] / phases[k].count) * 10) / 10;

  // ─── Vitals ───
  type Round = { request_id: string; round: number; decision: string; created_at: string; requests: { created_at: string; client_id: string } | null };
  const rs = (rounds ?? []) as unknown as Round[];
  const approvals = rs.filter((r) => r.decision === "approved" && r.requests);
  const turnaround = approvals.length ? Math.round((approvals.reduce((t, r) => t + businessDays(r.requests!.created_at, r.created_at), 0) / approvals.length) * 10) / 10 : null;
  const firstPass = approvals.length ? Math.round((approvals.filter((r) => r.round === 1).length / approvals.length) * 100) : null;
  const timed = rows.filter((r) => r.stage_due_at);
  const onTime = timed.length ? Math.round((timed.filter((r) => r.minutes_over <= 0).length / timed.length) * 100) : null;

  // ─── Clients: allotment pace and approvals ───
  const now = new Date();
  const monthElapsed = now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const byClient = new Map<string, Row[]>();
  for (const r of rows) byClient.set(r.client_id, [...(byClient.get(r.client_id) ?? []), r]);
  const revisesBy = new Map<string, number>();
  for (const r of rs) if (r.decision === "revise" && r.requests) revisesBy.set(r.requests.client_id, (revisesBy.get(r.requests.client_id) ?? 0) + 1);
  const clients: (ClientPulse & { clientId: string })[] = (usage ?? [])
    .map((u) => {
      const list = byClient.get(u.client_id) ?? [];
      const allotment = (u.images_per_month ?? 0) + (u.videos_per_month ?? 0);
      const used = u.images_used + u.videos_used;
      const waiting = list.filter((r) => r.stage === "client_review").length;
      const revisions = Math.round(((revisesBy.get(u.client_id) ?? 0) / Math.max(1, list.length || 1)) * 10) / 10;
      const pace = allotment ? used / allotment - monthElapsed : 0;
      // The risk is under-delivering, not giving a client more: nothing made a third of the way into the month, or far
      // behind where they should be by today. Being over the allotment is noted, not flagged.
      const nothing = allotment > 0 && used === 0 && monthElapsed >= 1 / 3;
      const behind = allotment > 0 && pace < -0.35;
      const tone: ClientPulse["tone"] = nothing ? "bad" : behind ? "warn" : revisions >= 2 ? "warn" : "ok";
      const note = nothing
        ? "Nothing delivered yet"
        : behind
          ? "Behind on creative"
          : revisions >= 2
            ? "Revision-heavy"
            : used > allotment && allotment
              ? "Over the allotment"
              : waiting
                ? `${waiting} with the client`
                : "On pace";
      return { name: list[0]?.client_name ?? "", slug: list[0]?.client_slug ?? "", clientId: u.client_id, tone, used, allotment, revisionsPerItem: revisions, waiting, note };
    })
    .filter((c) => c.allotment > 0 || c.waiting > 0)
    .sort((a, b) => ({ bad: 0, warn: 1, brand: 2, ok: 3, muted: 4 })[a.tone] - ({ bad: 0, warn: 1, brand: 2, ok: 3, muted: 4 })[b.tone] || b.used - a.used);
  // Clients with no open ticket: fill their names in
  const missing = clients.filter((c) => !c.name).map((c) => c.clientId);
  if (missing.length) {
    const { data: names } = await db.from("clients").select("id, name, slug").in("id", missing);
    for (const c of clients) {
      const n = (names ?? []).find((x) => x.id === c.clientId);
      if (n) Object.assign(c, { name: n.name, slug: n.slug });
    }
  }

  // ─── Needs attention, worst first ───
  const attention: Alert[] = [];
  for (const r of rows.filter((x) => x.minutes_over > 0).sort(byUrgency).slice(0, 6))
    attention.push({
      id: `late-${r.id}`,
      tone: r.minutes_over > DAY ? "bad" : "warn",
      kind: r.stage === "client_review" ? "No response" : "Behind",
      client: r.client_name,
      title: r.title,
      detail: `${stageInfo(r.stage)?.label ?? r.stage} for ${businessDuration(r.minutes_in_stage)} · ${businessDuration(r.minutes_over)} past turnaround`,
      owner: r.assignee_name ?? undefined,
      href: `/board?t=${r.number}`,
    });
  for (const r of rows.filter((x) => x.client_rounds >= 2).slice(0, 3))
    attention.push({ id: `rev-${r.id}`, tone: "warn", kind: "Revisions", client: r.client_name, title: r.title, detail: `Client round ${r.client_rounds}${r.internal_rounds ? ` · ${r.internal_rounds} internal` : ""}`, owner: r.assignee_name ?? undefined, href: `/board?t=${r.number}` });
  for (const c of clients.filter((x) => x.note === "Nothing delivered yet" || x.note === "Behind on creative").slice(0, 6))
    attention.push({ id: `allot-${c.clientId}`, tone: c.note === "Nothing delivered yet" ? "bad" : "warn", kind: "Allotment", client: c.name, title: c.note, detail: `${c.used} of ${c.allotment} made with ${Math.round(monthElapsed * 100)}% of the month gone`, href: `/clients/${c.slug}` });
  attention.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));

  // ─── Who carries what ───
  const loads = new Map<string, Load & { id: string; role: TeamRole }>();
  for (const r of rows) {
    if (!r.assignee_id || !r.assignee_name) continue;
    const role = roleOf.get(r.assignee_id) ?? ("graphic_designer" as TeamRole);
    const l = loads.get(r.assignee_id) ?? { id: r.assignee_id, name: r.assignee_name, role, active: 0, overdue: 0, capacity: CAPACITY[role] ?? 12 };
    l.active++;
    if (r.minutes_over > 0) l.overdue++;
    loads.set(r.assignee_id, l);
  }
  const team = [...loads.values()].sort((a, b) => b.overdue - a.overdue || b.active - a.active);
  const asLoad = (l: (typeof team)[number]): Load => ({ name: l.name, role: roleLabel(l.role), active: l.active, overdue: l.overdue, capacity: l.capacity });

  // ─── My work ───
  const mine = rows.filter((r) => r.assignee_id === me.id).sort(byUrgency);
  const today = nyToday();
  const dueToday = mine.filter((r) => r.minutes_over <= 0 && r.stage_due_at && nyToday(new Date(r.stage_due_at)) === today).length;
  type Ev = { request_id: string; kind: string; to_stage: string | null; data: Record<string, unknown> | null; actor_id: string | null; created_at: string };
  const evs = (events ?? []) as Ev[];

  return {
    rows,
    phases,
    vitals: { inMotion: rows.length, turnaroundDays: turnaround, turnaroundTarget: 5, firstPassRate: firstPass, onTimeRate: onTime },
    attention: attention.slice(0, 8),
    clients: clients.slice(0, 10),
    monthElapsed,
    team: team.map(asLoad),
    teamOf: (roles: TeamRole[]) => team.filter((l) => roles.includes(l.role)).map(asLoad),
    mine,
    dueToday,
    evs,
    copyDone: (copyDone ?? []) as { request_id: string; approved_by: string | null; approved_at: string }[],
    toQueue,
    since7,
  };
}

// ─── Ad accounts against their KPI targets (from the KPI tracker, refreshed every 30 minutes in business hours, hourly otherwise) ───

export type KpiPulse = {
  platform: "meta" | "google" | "all";
  accounts: number;
  counts: Record<"excellent" | "good" | "close" | "off" | "idle" | "setup", number>;
  /** "Needs setup", split: a new client with no ad account yet, and an account we can't read (access) */
  setup: { noAccount: string[]; cantRead: string[] };
  spend30: number;
  off: { id: string; client: string; slug: string; platform: string; label: string; deviation: number | null; status: string }[];
  offTotal: number;
  /** Off target but no alarm needed yet: someone changed the account within the last few days (see WORKED_DAYS) */
  offFresh: number;
  working: { id: string; client: string; slug: string; platform: string; label: string; changedAt: string; who: string | null }[];
  /** check: the spend is so far past the budget that the budget itself is probably wrong (a typo, a daily figure) */
  pacing: { id: string; client: string; slug: string; platform: string; label: string; status: "over" | "under" | "check"; pace: number; spent: number; budget: number }[];
  syncedAt: string | null;
  syncedMinutes: number | null;
};

const PLATFORM = { meta: "Meta", google: "Google" } as const;

/** An account changed this recently is being worked on: off target or not, it isn't raised as an alarm until then */
export const WORKED_DAYS = 5;
const accountKey = (platform: string, id: string) => (platform === "google" ? id.replace(/\D/g, "") : id.replace(/^act_/, ""));

/**
 * The last change in each ad account within WORKED_DAYS (from Meta and Google's own history). A red account someone
 * changed is given time to turn around: it comes back as an alert once that long has passed with no newer change.
 */
export async function recentlyWorked(db: SupabaseClient, accounts: { platform: string; ad_account_id: string | null }[]) {
  const keys = [...new Set(accounts.filter((a) => a.ad_account_id).map((a) => accountKey(a.platform, String(a.ad_account_id))))];
  const out = new Map<string, { at: string; who: string | null }>();
  if (!keys.length) return out;
  const since = new Date(Date.now() - WORKED_DAYS * 86_400_000).toISOString();
  const { data } = await db.from("ad_account_changes").select("ad_account_id, at, who").in("ad_account_id", keys).gte("at", since).order("at", { ascending: false }).limit(2000);
  // Our team's changes only: a client changing their own account (shown by their email) or an automated tool isn't us
  // working on it
  const ours = (who: string | null) => Boolean(who) && (!who!.includes("@") || who!.toLowerCase().endsWith("@kaizenmarketing.agency")) && !/commandcenter|automated|rule/i.test(who!);
  for (const c of data ?? []) if (ours(c.who as string | null) && !out.has(c.ad_account_id as string)) out.set(c.ad_account_id as string, { at: c.at as string, who: (c.who as string | null) ?? null });
  return out;
}
export const workedOn = (worked: Map<string, { at: string; who: string | null }>, t: { platform: string; ad_account_id: string | null }) => (t.ad_account_id ? (worked.get(accountKey(t.platform, String(t.ad_account_id))) ?? null) : null);

/**
 * The ad accounts against their targets. owner: only the accounts this buyer owns. platform: Meta or Google only;
 * the two service lines are never added together, so a client whose Google is fine still shows its Meta off target.
 */
export async function loadKpiPulse(db: SupabaseClient, opts?: string | { owner?: string; platform?: "meta" | "google" }): Promise<KpiPulse | null> {
  const { owner, platform } = typeof opts === "string" ? { owner: opts, platform: undefined } : (opts ?? {});
  let q = db.from("kpi_targets").select("id, label, platform, ad_account_id, owner_id, clients!inner(name, slug, archived_at, status)").eq("active", true).is("clients.archived_at", null).in("clients.status", LIVE);
  if (owner) q = q.eq("owner_id", owner);
  if (platform) q = q.eq("platform", platform);
  const [{ data: targets }, { data: snaps }] = await Promise.all([q, db.from("kpi_snapshots").select("target_id, status, deviation, windows, budget, computed_at")]);
  if (!targets?.length) return null;
  const snapBy = new Map((snaps ?? []).map((x) => [x.target_id as string, x]));
  const counts = { excellent: 0, good: 0, close: 0, off: 0, idle: 0, setup: 0 };
  const setup: KpiPulse["setup"] = { noAccount: [], cantRead: [] };
  const off: KpiPulse["off"] = [];
  const pacing: KpiPulse["pacing"] = [];
  let spend30 = 0;
  let synced: string | null = null;
  for (const t of targets) {
    const c = t.clients as unknown as { name: string; slug: string } | null;
    const snap = snapBy.get(t.id);
    const status = ((snap?.status as keyof typeof counts | null) ?? "setup") as keyof typeof counts;
    counts[status] = (counts[status] ?? 0) + 1;
    const name = c?.name ?? "Unknown";
    if (status === "setup") (t.ad_account_id ? setup.cantRead : setup.noAccount).push(name);
    // Without a platform filter the label says which service line it is
    const label = [platform ? null : PLATFORM[t.platform as "meta" | "google"], t.label].filter(Boolean).join(" · ");
    spend30 += Number((snap?.windows as { d30?: { spend?: number } } | null)?.d30?.spend ?? 0);
    if (snap?.computed_at && (!synced || snap.computed_at > synced)) synced = snap.computed_at;
    if (status === "off" || status === "close") off.push({ id: t.id, client: name, slug: c?.slug ?? "", platform: t.platform as string, label, deviation: snap?.deviation == null ? null : Number(snap.deviation), status });
    const b = snap?.budget as { status?: string; pace?: number; spent?: number; budget?: number } | null;
    // A budget under $20 a month is a typo (a "k" lost from the sheet), not a budget
    if ((b?.status === "over" || b?.status === "under") && Number(b.budget ?? 0) >= 20) {
      const pace = b.pace ?? 1;
      pacing.push({ id: t.id, client: name, slug: c?.slug ?? "", platform: t.platform as string, label, status: pace > 3 ? "check" : b.status, pace, spent: Math.round(Number(b.spent ?? 0)), budget: Math.round(Number(b.budget ?? 0)) });
    }
  }
  off.sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0));
  // Off target but changed in the last few days: being worked on, so set apart rather than raised
  const worked = await recentlyWorked(db, targets.filter((t) => off.some((o) => o.id === t.id)) as { platform: string; ad_account_id: string | null }[]);
  const working: KpiPulse["working"] = [];
  const alarms: KpiPulse["off"] = [];
  for (const o of off) {
    const t = targets.find((x) => x.id === o.id)!;
    const w = workedOn(worked, t as { platform: string; ad_account_id: string | null });
    if (w) working.push({ id: o.id, client: o.client, slug: o.slug, platform: o.platform, label: o.label, changedAt: w.at, who: w.who });
    else alarms.push(o);
  }
  const offFresh = alarms.filter((o) => o.status === "off").length;
  // Real pacing problems first; budgets that look wrong after
  pacing.sort((a, b) => Number(a.status === "check") - Number(b.status === "check") || Math.abs(b.pace - 1) - Math.abs(a.pace - 1));
  return { platform: platform ?? "all", accounts: targets.length, counts, setup, spend30: Math.round(spend30), off: alarms.slice(0, 8), offTotal: alarms.length, offFresh, working, pacing: pacing.slice(0, 6), syncedAt: synced, syncedMinutes: synced ? Math.round((Date.now() - Date.parse(synced)) / 60000) : null };
}
