import "server-only";
import { onService } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { cleanFocus, clientLines, lineOf, type FocusLine } from "./core";
import { fireKey, fireOf, fireTitle, kpiWorse, KPI_FIRE_DAYS, KPI_FIRE_DEVIATION, type FireSignal } from "./fire";

// Exec focus, the database side: reading an exec's focus, telling every exec when a client is on fire (once per client
// per day), and the daily sweep for the fire rules that need numbers (the main KPI far off, tracking broken).

/** An exec's focus lines (empty: not set, so they hear everything). Never throws: an older database has no column. */
export async function loadExecFocus(db: SupabaseClient, profileId: string): Promise<FocusLine[]> {
  const { data, error } = await db.from("profiles").select("exec_focus").eq("id", profileId).maybeSingle();
  if (error || !data) return [];
  return cleanFocus((data as { exec_focus?: string[] | null }).exec_focus ?? []);
}

/** The lines each client buys, for the clients given */
export async function linesByClient(db: SupabaseClient, ids: string[]): Promise<Map<string, FocusLine[]>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data } = await db.from("clients").select("id, services, services_extra, services_removed, strategy_only").in("id", uniq);
  const { servicesOf } = await import("@/lib/services");
  return new Map((data ?? []).map((c) => [c.id as string, clientLines(servicesOf(c as { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null }))]));
}

/** Clients with a fire alert today (any exec's), so their items lead an exec's day */
export async function onFireToday(db: SupabaseClient): Promise<Set<string>> {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const { data, error } = await db.from("notifications").select("client_id").like("key", `fire:%:${day}`).not("client_id", "is", null).limit(200);
  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.client_id as string));
}

export type FireInput = { clientId: string; signal: FireSignal; href?: string | null; body?: string | null; line?: FocusLine | null; client?: string | null };

/**
 * Tells every exec a client is on fire, when the signal says so: critical, one line why, once per client per day (a
 * second fire the same day for the same client is the same alert). Returns whether it fired.
 */
export async function raiseFire(admin: SupabaseClient, i: FireInput): Promise<boolean> {
  const f = fireOf(i.signal);
  if (!f.fire || !i.clientId) return false;
  return notifyFire(admin, { clientId: i.clientId, client: i.client ?? null, why: f.why, href: i.href ?? null, body: i.body ?? null, line: i.line ?? null });
}

/** The alert itself: every exec, critical, the only thing that rings an exec's bell (once per client per day) */
export async function notifyFire(admin: SupabaseClient, i: { clientId: string; client: string | null; why: string; href: string | null; body?: string | null; line?: FocusLine | null }): Promise<boolean> {
  const [{ data: c }, { data: execs }] = await Promise.all([
    i.client ? Promise.resolve({ data: { name: i.client, slug: null as string | null } }) : admin.from("clients").select("name, slug").eq("id", i.clientId).maybeSingle(),
    admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null),
  ]);
  if (!execs?.length) return false;
  const name = (c?.name as string | undefined) ?? "A client";
  const href = i.href ?? (c?.slug ? `/clients/${c.slug}` : "/pipeline?block=escalated");
  const key = fireKey(i.clientId);
  const base = execs.map((e) => ({ profile_id: e.id as string, kind: "fire", title: fireTitle(name, i.why), body: (i.body ?? "").slice(0, 1000) || null, href, client_id: i.clientId, key, priority: "critical" }));
  const { error } = await admin.from("notifications").upsert(base.map((r) => ({ ...r, fire: true, line: i.line ?? null })), { onConflict: "profile_id,key", ignoreDuplicates: true });
  // The columns aren't there yet (the migration hasn't run): still tell them
  if (error && /fire|line/.test(error.message)) await admin.from("notifications").upsert(base, { onConflict: "profile_id,key", ignoreDuplicates: true });
  return true;
}

type Win = { spend?: number; results?: number; value?: number | null };

/** A client on fire right now, by the owner's four rules (src/lib/exec-focus/fire.ts), one per client */
export type LiveFire = { clientId: string; client: string; clientSlug: string | null; why: string; href: string | null; line: FocusLine | null; rule: 1 | 2 | 3 | 4; body: string | null; at: string | null };

const DAY = 86_400_000;

/**
 * Every client on fire right now, read live: (1) said they're leaving or cancelling (the last 14 days), (2) an ad
 * account disabled, its payment failed or its spend stopped, (3) an angry client message unanswered for more than one
 * business day, (4) the main KPI 50%+ off target for 2+ weeks with nothing in motion. One per client, the first rule
 * that holds. The Overview's Escalated tab and the bell read the same list.
 */
export async function liveFires(admin: SupabaseClient, now = new Date()): Promise<LiveFire[]> {
  const day14 = new Date(now.getTime() - 14 * DAY).toISOString();
  const [{ data: clients }, { data: notes }, { data: flags }, { data: owed }, { soundsLikeChurn }, { businessHoursBetween }, { isAngry }] = await Promise.all([
    admin.from("clients").select("id, name, slug").is("archived_at", null).in("status", LIVE as unknown as string[]).limit(3000),
    admin.from("client_memory").select("client_id, body, created_at").eq("status", "active").like("body", "At risk (said%").gte("created_at", day14).order("created_at", { ascending: false }).limit(300),
    admin.from("watch_flags").select("id, kind, client_id, line, title, body, detail, opened_at").is("resolved_at", null).in("kind", ["payment_issue", "delivery_issue", "spend_stopped"]).limit(500),
    admin.from("owed_replies").select("id, client_id, body, gist, asked_at, url, from_name").eq("from_team", false).in("status", ["watching", "nudged", "escalated"]).not("client_id", "is", null).gte("asked_at", new Date(now.getTime() - 30 * DAY).toISOString()).limit(800),
    import("@/lib/client-risk"),
    import("@/lib/escalation-ladder-core"),
    import("./fire"),
  ]);
  const live = new Map((clients ?? []).map((c) => [c.id as string, c as { id: string; name: string; slug: string | null }]));
  const out = new Map<string, LiveFire>();
  const add = (f: Omit<LiveFire, "client" | "clientSlug">) => {
    const c = live.get(f.clientId);
    if (!c || out.has(f.clientId)) return;
    out.set(f.clientId, { ...f, client: c.name, clientSlug: c.slug ?? null, href: f.href ?? (c.slug ? `/clients/${c.slug}` : null) });
  };
  // 1. Leaving or cancelling: what the client said (a note written from it, or a message still waiting on us)
  for (const n of notes ?? []) add({ clientId: n.client_id as string, why: "said they may cancel or leave", href: null, line: null, rule: 1, body: String(n.body ?? "").slice(0, 400), at: n.created_at as string });
  for (const o of owed ?? []) if (soundsLikeChurn(`${o.body ?? ""} ${o.gist ?? ""}`)) add({ clientId: o.client_id as string, why: "said they may cancel or leave", href: (o.url as string | null) ?? null, line: null, rule: 1, body: String(o.gist ?? o.body ?? "").slice(0, 400), at: o.asked_at as string });
  // 2. The ad account: disabled, payment failed, spend stopped
  for (const f of flags ?? []) {
    const d = (f.detail ?? {}) as { account_status?: number | null; average?: number };
    const fire = fireOf({ kind: "watch", watchKind: f.kind as string, severity: "critical", line: f.line as string | null, accountStatus: d.account_status ?? null, dailyAverage: Number(d.average ?? 0) || undefined, spend30: Number(d.average ?? 0) * 30 });
    if (fire.fire) add({ clientId: f.client_id as string, why: fire.why, href: null, line: lineOf(f.line as string | null), rule: 2, body: String(f.title ?? ""), at: f.opened_at as string });
  }
  // 3. Angry and unanswered for more than a business day
  for (const o of owed ?? []) {
    const text = `${o.body ?? ""} ${o.gist ?? ""}`;
    if (!isAngry(text)) continue;
    const bh = businessHoursBetween(new Date(o.asked_at as string), now);
    const fire = fireOf({ kind: "angry_unanswered", text, businessHours: bh });
    if (fire.fire) add({ clientId: o.client_id as string, why: fire.why, href: (o.url as string | null) ?? null, line: null, rule: 3, body: `${o.from_name ?? "The client"}: ${String(o.gist ?? o.body ?? "").slice(0, 300)}`, at: o.asked_at as string });
  }
  // An account off target is no longer a fire: it's on the ladder (the lead first) and in the execs' Accounts block
  return [...out.values()].sort((a, b) => a.rule - b.rule);
}

/**
 * Accounts that reach the execs (owner, Nov 23 2026): the main KPI 50%+ worse than target over the last 7 days, off
 * target for over 7 days (from the day it first reached anyone's day), and nothing in motion (person-driven: a sprint
 * started or acted on this week, a person's audit or the plan worked on in 2 weeks). Until then it's the buyer's, then
 * the line's lead's. By KPI target, with how far off and what's (not) moving.
 */
export async function accountsForExecs(admin: SupabaseClient, now = new Date()): Promise<Map<string, { worse: number; days: number }>> {
  const { data: snaps } = await admin.from("kpi_snapshots").select("target_id, windows").eq("status", "off").limit(1000);
  const ids = (snaps ?? []).map((s) => s.target_id as string);
  if (!ids.length) return new Map();
  const [{ data: targets }, { data: seen }] = await Promise.all([
    admin
      .from("kpi_targets")
      .select("id, client_id, platform, conversion, target, clients!inner(archived_at, status, services, services_extra, services_removed, strategy_only)")
      .in("id", ids)
      .eq("active", true)
      .not("target", "is", null)
      .is("clients.archived_at", null)
      .in("clients.status", LIVE)
      .then((r) => ({ ...r, data: (r.data ?? []).filter(onService) })),
    admin.from("daily_items").select("key, first_seen_at").in("key", ids.map((i) => `kpi:${i}`)).order("first_seen_at").limit(3000),
  ]);
  const firstSeen = new Map<string, number>();
  for (const d of seen ?? []) if (!firstSeen.has(d.key as string)) firstSeen.set(d.key as string, Date.parse(d.first_seen_at as string));
  const win = new Map((snaps ?? []).map((s) => [s.target_id as string, (s.windows ?? {}) as Record<string, Win>]));
  const candidates: { id: string; clientId: string; worse: number; days: number }[] = [];
  for (const t of targets ?? []) {
    const w = win.get(t.id as string) ?? {};
    const roas = t.conversion === "roas" || t.conversion === "tiktok_roas";
    const worse = kpiWorse({ value: w.d7?.value, target: Number(t.target), roas, results: w.d7?.results });
    const since = firstSeen.get(`kpi:${t.id}`);
    const days = since ? Math.floor((now.getTime() - since) / DAY) : 0;
    if (worse == null || worse < KPI_FIRE_DEVIATION || days <= KPI_FIRE_DAYS) continue;
    candidates.push({ id: t.id as string, clientId: t.client_id as string, worse, days });
  }
  const motion = await motionByTarget(admin, candidates, now);
  return new Map(candidates.filter((c) => !motion.get(c.id)).map((c) => [c.id, { worse: c.worse, days: c.days }]));
}

/**
 * What's in motion on each ad account (by KPI target): a sprint that's moving, an audit a person ran in the last 2
 * weeks, or the client's execution plan worked on in the last 2 weeks. Null when nothing is.
 */
export async function motionByTarget(admin: SupabaseClient, targets: { id: string; clientId: string }[], now = new Date()): Promise<Map<string, string | null>> {
  const ids = targets.map((t) => t.id);
  const clientIds = [...new Set(targets.map((t) => t.clientId))];
  if (!ids.length) return new Map();
  const day14 = new Date(now.getTime() - 14 * DAY).toISOString();
  const [{ data: sprints }, { data: audits }, { data: plans }, { inMotion }] = await Promise.all([
    admin.from("optimization_sprints").select("id, target_id, status, started_at").in("target_id", ids).eq("status", "active"),
    admin.from("account_audits").select("target_id, created_at, auto").in("target_id", ids).gte("created_at", day14),
    admin.from("client_execution_plans").select("client_id, updated_at").in("client_id", clientIds).gte("updated_at", day14),
    import("@/lib/exec-overview-core"),
  ]);
  const planned = new Set((plans ?? []).map((p) => p.client_id as string));
  // The last sprint action a person ticked off, per sprint (the automatic checks don't count)
  const sprintIds = (sprints ?? []).map((s) => s.id as string);
  const { data: acts } = sprintIds.length ? await admin.from("sprint_actions").select("sprint_id, done_at").in("sprint_id", sprintIds).not("done_by", "is", null).gte("done_at", new Date(now.getTime() - 7 * DAY).toISOString()) : { data: [] };
  const lastAct = new Map<string, string>();
  for (const a of acts ?? []) if (!lastAct.has(a.sprint_id as string) || String(a.done_at) > lastAct.get(a.sprint_id as string)!) lastAct.set(a.sprint_id as string, a.done_at as string);
  const out = new Map<string, string | null>();
  for (const t of targets) {
    const m = inMotion(
      {
        sprints: (sprints ?? []).filter((s) => s.target_id === t.id).map((s) => ({ status: s.status as string, startedAt: s.started_at as string | null, lastActionAt: lastAct.get(s.id as string) ?? null })),
        audits: (audits ?? []).filter((a) => a.target_id === t.id).map((a) => ({ createdAt: a.created_at as string, auto: a.auto as boolean | null })),
      },
      now,
    );
    out.set(t.id, m ?? (planned.has(t.clientId) ? "The plan was worked on in the last 2 weeks" : null));
  }
  return out;
}

/** The fires, every exec told: once per client per day while it holds */
export async function fireSweep(admin: SupabaseClient): Promise<{ fired: number }> {
  const fires = await liveFires(admin);
  let fired = 0;
  for (const f of fires) if (await notifyFire(admin, { clientId: f.clientId, client: f.client, why: f.why, href: f.href, body: f.body, line: f.line }).catch(() => false)) fired++;
  return { fired };
}

/** raiseFire with the service key, from code that only has the person's session (a no-op without the key) */
export async function raiseFireAsAdmin(i: FireInput): Promise<boolean> {
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  return adminConfigured() ? raiseFire(createAdminClient(), i) : false;
}
