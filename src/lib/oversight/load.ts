import "server-only";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { isRiskNote, RISK_DAYS } from "@/lib/client-risk";
import { econFlags, laborCost, monthly, payState, scorecard, type EconFlag, type PayState, type ScoreRow } from "./core";

// The weekly scorecard and account economics, read with the admin client after the page or tool has checked who's
// asking (the scorecard: execs and line heads; economics: execs only). Economics reads Stripe through Kaizen Track
// (its hourly mirror of payments, open invoices and subscriptions, and its time entries and cost rates), and Stripe
// itself for failed charges and uncollectible invoices once STRIPE_SECRET_KEY (a restricted read key) is set. Nothing
// here is ever written to Slack or anything a client sees.

const DAY = 86_400_000;
const LIVE = ["active", "onboarding"];
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ─── Scorecard ──────────────────────────────────────────────────────────────

export async function loadScorecard(admin: SupabaseClient, now = new Date()): Promise<{ rows: ScoreRow[]; week: string }> {
  const nowIso = now.toISOString();
  const [{ data: clients }, { data: seats }, { data: people }, { data: promises }, { data: owed }, { data: calls }, { data: flags }, { data: notes }] = await Promise.all([
    admin.from("clients").select("id").is("archived_at", null).in("status", LIVE),
    admin.from("client_assignments").select("client_id, profile_id, role"),
    admin.from("profiles").select("id, full_name, role, is_active"),
    admin.from("message_promises").select("owner_id, client_id").in("status", ["overdue", "escalated"]).limit(1000),
    admin.from("owed_replies").select("target_id, client_id").in("status", ["nudged", "escalated"]).limit(1000),
    admin.from("call_commitments").select("routed_to, client_id").eq("status", "open").is("merged_into", null).lt("due_at", nowIso).gte("due_at", new Date(now.getTime() - 30 * DAY).toISOString()).limit(1000),
    admin.from("watch_flags").select("client_id, kind, line").is("resolved_at", null).in("kind", ["unapproved_change", "quiet_channel"]).limit(1000),
    admin.from("client_memory").select("client_id, body, created_at").ilike("body", "At risk (said%").gte("created_at", new Date(now.getTime() - RISK_DAYS * DAY).toISOString()).limit(1000),
  ]);
  const live = new Set((clients ?? []).map((c) => c.id as string));
  const missed = [
    ...(promises ?? []).filter((p) => p.owner_id).map((p) => ({ profile_id: p.owner_id as string, client_id: (p.client_id as string | null) ?? null })),
    ...(owed ?? []).filter((o) => o.target_id).map((o) => ({ profile_id: o.target_id as string, client_id: (o.client_id as string | null) ?? null })),
    ...(calls ?? []).flatMap((c) => ((c.routed_to as string[] | null) ?? []).map((id) => ({ profile_id: id, client_id: (c.client_id as string | null) ?? null }))),
  ].filter((m) => !m.client_id || live.has(m.client_id));
  const rows = scorecard({
    people: (people ?? []).map((p) => ({ id: p.id as string, name: p.full_name as string, role: p.role as string, active: Boolean(p.is_active) })),
    seats: ((seats ?? []) as { client_id: string; profile_id: string; role: string }[]).filter((s) => live.has(s.client_id)),
    missed,
    flags: ((flags ?? []) as { client_id: string; kind: string; line: string | null }[]).filter((f) => live.has(f.client_id)),
    atRisk: new Set(((notes ?? []) as { client_id: string; body: string }[]).filter((n) => isRiskNote(n.body) && live.has(n.client_id)).map((n) => n.client_id)),
  });
  return { rows, week: nyDay(now) };
}

// ─── Economics ─────────────────────────────────────────────────────────────

export type EconRow = { clientId: string; client: string; slug: string; fee: number; hours: number; cost: number; margin: number; pay: PayState; owed: number; flags: EconFlag[] };
export type Economics = { ok: true; rows: EconRow[]; stripeDirect: boolean; stripeError: string | null; trackSyncedAt: string | null; unmatched: number } | { ok: false; setup: string };

const trackDb = () => (process.env.TRACK_SUPABASE_URL && process.env.TRACK_SUPABASE_SECRET_KEY ? createSupabase(process.env.TRACK_SUPABASE_URL, process.env.TRACK_SUPABASE_SECRET_KEY, { auth: { persistSession: false } }) : null);

/** Stripe itself (read only): failed charges and uncollectible invoices in the last 60 days, by Stripe customer */
async function stripeDirect(now: Date): Promise<{ failed: Map<string, number>; uncollectible: Map<string, number> } | { error: string } | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const since = Math.floor((now.getTime() - 60 * DAY) / 1000);
  const get = async (path: string) => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const body = (await res.json()) as { data?: { customer?: string | null; status?: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `Stripe ${res.status}`);
    return body.data ?? [];
  };
  try {
    const [charges, invoices] = await Promise.all([get(`charges?limit=100&created[gte]=${since}`), get(`invoices?limit=100&status=uncollectible&created[gte]=${since}`)]);
    const failed = new Map<string, number>();
    for (const c of charges) if (c.status === "failed" && c.customer) failed.set(c.customer, (failed.get(c.customer) ?? 0) + 1);
    const uncollectible = new Map<string, number>();
    for (const i of invoices) if (i.customer) uncollectible.set(i.customer, (uncollectible.get(i.customer) ?? 0) + 1);
    return { failed, uncollectible };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadEconomics(admin: SupabaseClient, now = new Date()): Promise<Economics> {
  const track = trackDb();
  if (!track) return { ok: false, setup: "Kaizen Track isn't connected (TRACK_SUPABASE_URL and TRACK_SUPABASE_SECRET_KEY), so there's no Stripe or time data to read." };
  const today = nyDay(now);
  const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
  const [{ data: ours }, subsR, manualR, openR, customersR, projectsR, entries, ratesR, syncR, pricesR, { data: targets }, { data: snaps }, { data: idle }, direct] = await Promise.all([
    admin.from("clients").select("id, name, slug, track_client_id").is("archived_at", null).in("status", LIVE),
    track.from("stripe_subscriptions").select("id, customer_id, client_id, amount, interval, status").in("status", ["active", "past_due", "trialing", "unpaid"]),
    track.from("stripe_subscription_clients").select("subscription_id, client_id"),
    track.from("stripe_open_invoices").select("customer_id, client_id, subscription_id, amount_due, due_date"),
    track.from("stripe_customers").select("id, client_id"),
    track.from("projects").select("id, client_id"),
    pages<{ profile_id: string; project_id: string | null; started_at: string; duration_s: number | null }>((a, z) => track.from("time_entries").select("profile_id, project_id, started_at, duration_s").is("deleted_at", null).neq("status", "rejected").gte("started_at", since30).order("started_at").range(a, z)),
    track.from("cost_rates").select("profile_id, hourly_cost, effective_from, effective_to"),
    track.from("stripe_sync_state").select("last_synced_at").limit(1).maybeSingle(),
    track.from("client_service_prices").select("client_id, monthly_price"),
    admin.from("kpi_targets").select("id, client_id").eq("active", true),
    admin.from("kpi_snapshots").select("target_id, deviation"),
    admin.from("watch_flags").select("client_id").eq("kind", "idle").eq("severity", "critical").is("resolved_at", null),
    stripeDirect(now),
  ]);
  if (subsR.error) return { ok: false, setup: `Kaizen Track: ${subsR.error.message}` };
  const byTrack = new Map(((ours ?? []) as { id: string; name: string; slug: string; track_client_id: string | null }[]).filter((c) => c.track_client_id).map((c) => [c.track_client_id as string, c]));
  const manual = new Map((manualR.data ?? []).map((m) => [m.subscription_id as string, m.client_id as string]));
  const subClient = new Map((subsR.data ?? []).map((s) => [s.id as string, (manual.get(s.id as string) ?? s.client_id) as string | null]));
  const customerClient = new Map((customersR.data ?? []).map((c) => [c.id as string, c.client_id as string | null]));
  const fee = new Map<string, number>();
  const pastDue = new Set<string>();
  let unmatched = 0;
  for (const s of subsR.data ?? []) {
    const t = subClient.get(s.id as string);
    if (!t || !byTrack.has(t)) {
      unmatched++;
      continue;
    }
    fee.set(t, (fee.get(t) ?? 0) + monthly(Number(s.amount), s.interval as string));
    if (s.status === "past_due" || s.status === "unpaid") pastDue.add(t);
  }
  // A client with no subscription: the monthly prices set in Track
  for (const p of pricesR.data ?? []) if (!fee.has(p.client_id as string)) fee.set(p.client_id as string, (fee.get(p.client_id as string) ?? 0) + Number(p.monthly_price ?? 0));
  const open = new Map<string, { amount: number; due: string | null }[]>();
  for (const o of openR.data ?? []) {
    const t = (o.subscription_id && subClient.get(o.subscription_id as string)) || (o.client_id as string | null) || (o.customer_id ? customerClient.get(o.customer_id as string) : null);
    if (!t) continue;
    open.set(t, [...(open.get(t) ?? []), { amount: Number(o.amount_due ?? 0), due: (o.due_date as string | null) ?? null }]);
  }
  const projectClient = new Map((projectsR.data ?? []).map((p) => [p.id as string, p.client_id as string | null]));
  const entriesBy = new Map<string, typeof entries>();
  for (const e of entries) {
    const t = e.project_id ? projectClient.get(e.project_id) : null;
    if (t) entriesBy.set(t, [...(entriesBy.get(t) ?? []), e]);
  }
  const rates = (ratesR.data ?? []) as { profile_id: string; hourly_cost: number | null; effective_from: string | null; effective_to: string | null }[];
  const targetClient = new Map((targets ?? []).map((t) => [t.id as string, t.client_id as string]));
  const bestDev = new Map<string, number>();
  for (const s of snaps ?? []) {
    const c = targetClient.get(s.target_id as string);
    if (!c || s.deviation == null) continue;
    bestDev.set(c, Math.min(bestDev.get(c) ?? Infinity, Number(s.deviation)));
  }
  const idleSet = new Set((idle ?? []).map((f) => f.client_id as string));
  const stripe = direct && !("error" in direct) ? direct : null;
  const perTrack = (m: Map<string, number> | undefined, trackId: string) => {
    if (!m) return 0;
    let n = 0;
    for (const [cust, k] of m) if (customerClient.get(cust) === trackId) n += k;
    return n;
  };
  const rows: EconRow[] = [];
  for (const [trackId, c] of byTrack) {
    const f = fee.get(trackId) ?? 0;
    const labor = laborCost(entriesBy.get(trackId) ?? [], rates);
    const o = open.get(trackId) ?? [];
    const input = { fee: f, hours: labor.hours, cost: labor.cost, open: o, pastDue: pastDue.has(trackId), failed: perTrack(stripe?.failed, trackId), uncollectible: perTrack(stripe?.uncollectible, trackId), bestDeviation: bestDev.has(c.id) ? bestDev.get(c.id)! : null, idleBilled: idleSet.has(c.id), today };
    if (!f && !labor.hours && !o.length) continue;
    rows.push({ clientId: c.id, client: c.name, slug: c.slug, fee: f, hours: labor.hours, cost: labor.cost, margin: f - labor.cost, pay: payState(input), owed: o.reduce((n, x) => n + x.amount, 0), flags: econFlags(input) });
  }
  const rank = (r: EconRow) => r.flags.length * 1000 + (r.pay === "overdue" ? 500 : 0) - r.margin / 100;
  rows.sort((a, b) => rank(b) - rank(a));
  return { ok: true, rows, stripeDirect: Boolean(stripe), stripeError: direct && "error" in direct ? direct.error : null, trackSyncedAt: (syncR.data?.last_synced_at as string | null) ?? null, unmatched };
}
