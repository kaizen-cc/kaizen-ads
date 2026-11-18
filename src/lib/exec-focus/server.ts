import "server-only";
import { onService } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { cleanFocus, clientLines, type FocusLine } from "./core";
import { fireKey, fireOf, fireTitle, kpiWorse, KPI_FIRE_DEVIATION, topSpenders, type FireSignal } from "./fire";

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
  const { data } = await db.from("clients").select("id, services, services_extra, services_removed").in("id", uniq);
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
  const [{ data: c }, { data: execs }] = await Promise.all([
    i.client ? Promise.resolve({ data: { name: i.client, slug: null as string | null } }) : admin.from("clients").select("name, slug").eq("id", i.clientId).maybeSingle(),
    admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null),
  ]);
  if (!execs?.length) return false;
  const name = (c?.name as string | undefined) ?? "A client";
  const href = i.href ?? (c?.slug ? `/clients/${c.slug}` : "/pipeline");
  const key = fireKey(i.clientId);
  const base = execs.map((e) => ({ profile_id: e.id as string, kind: "fire", title: fireTitle(name, f.why), body: (i.body ?? "").slice(0, 1000) || null, href, client_id: i.clientId, key, priority: "critical" }));
  const { error } = await admin.from("notifications").upsert(base.map((r) => ({ ...r, fire: true, line: i.line ?? null })), { onConflict: "profile_id,key", ignoreDuplicates: true });
  // The columns aren't there yet (the migration hasn't run): still tell them
  if (error && /fire|line/.test(error.message)) await admin.from("notifications").upsert(base, { onConflict: "profile_id,key", ignoreDuplicates: true });
  return true;
}

type Win = { spend?: number; results?: number; value?: number | null };

/**
 * The daily sweep for the fire rules that need numbers: an account spending with no conversions tracked for a week,
 * and the main KPI 50%+ worse than target for 7+ days on a top-spend or at-risk client. One alert per client per day.
 */
export async function fireSweep(admin: SupabaseClient): Promise<{ fired: number }> {
  const { data: targets } = await admin
    .from("kpi_targets")
    .select("id, client_id, platform, conversion, target, clients!inner(name, slug, archived_at, status, services, services_extra, services_removed)")
    .eq("active", true)
    .not("target", "is", null)
    .is("clients.archived_at", null)
    .in("clients.status", LIVE)
    // Only the lines the client buys (src/lib/service-gate.ts)
    .then((r) => ({ ...r, data: (r.data ?? []).filter(onService) }));
  const ids = (targets ?? []).map((t) => t.id as string);
  if (!ids.length) return { fired: 0 };
  const [{ data: snaps }, { RISK_DAYS, RISK_PREFIX, atRiskClients }] = await Promise.all([admin.from("kpi_snapshots").select("target_id, status, windows").in("target_id", ids), import("@/lib/client-risk")]);
  const { data: notes } = await admin
    .from("client_memory")
    .select("client_id, body, created_at")
    .eq("status", "active")
    .like("body", `${RISK_PREFIX} (said%`)
    .gte("created_at", new Date(Date.now() - RISK_DAYS * 86_400_000).toISOString())
    .limit(300);
  const atRisk = atRiskClients((notes ?? []) as { client_id: string; body: string; created_at: string }[]);
  const snapOf = new Map((snaps ?? []).map((s) => [s.target_id as string, s]));
  const spend = new Map<string, number>();
  for (const t of targets ?? []) {
    const w = (snapOf.get(t.id as string)?.windows ?? {}) as Record<string, Win>;
    spend.set(t.id as string, Number(w.d30?.spend ?? 0));
  }
  const top = topSpenders(spend);
  let fired = 0;
  const done = new Set<string>();
  for (const t of targets ?? []) {
    const clientId = t.client_id as string;
    if (done.has(clientId)) continue;
    const s = snapOf.get(t.id as string);
    if (!s) continue;
    const w = (s.windows ?? {}) as Record<string, Win>;
    const c = t.clients as unknown as { name: string; slug: string };
    const roas = t.conversion === "roas" || t.conversion === "tiktok_roas";
    const line = (t.platform === "google" ? "google" : t.platform === "tiktok" ? "tiktok" : "meta") as FocusLine;
    const href = `/kpis?target=${t.id}`;
    const d7 = w.d7 ?? {};
    const tracking: FireSignal = { kind: "tracking", spend7: Number(d7.spend ?? 0), results7: Number(d7.results ?? 0), tracksConversions: !roas && t.target != null };
    if (await raiseFire(admin, { clientId, client: c.name, signal: tracking, href, line, body: "Check the pixel, the conversion event and the landing page before anything else." })) {
      fired++;
      done.add(clientId);
      continue;
    }
    if (s.status !== "off") continue;
    const worse7 = kpiWorse({ value: d7.value, target: Number(t.target), roas, results: d7.results });
    const worse14 = kpiWorse({ value: w.d14?.value, target: Number(t.target), roas, results: w.d14?.results });
    if (worse7 == null || worse7 < KPI_FIRE_DEVIATION) continue;
    const days = worse14 != null && worse14 >= KPI_FIRE_DEVIATION ? 14 : 7;
    const kpi: FireSignal = { kind: "kpi", deviation: worse7, days, topSpend: top.has(t.id as string), atRisk: atRisk.has(clientId) };
    if (await raiseFire(admin, { clientId, client: c.name, signal: kpi, href, line, body: `${Number(d7.spend ?? 0) ? `$${Math.round(Number(d7.spend)).toLocaleString("en-US")} spent in the last 7 days. ` : ""}Open the account and agree a plan today.` })) {
      fired++;
      done.add(clientId);
    }
  }
  return { fired };
}

/** raiseFire with the service key, from code that only has the person's session (a no-op without the key) */
export async function raiseFireAsAdmin(i: FireInput): Promise<boolean> {
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  return adminConfigured() ? raiseFire(createAdminClient(), i) : false;
}
