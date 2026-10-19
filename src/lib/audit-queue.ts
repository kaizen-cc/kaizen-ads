import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { notLive } from "@/lib/live-guard";

// Three audits at a time per person, so a burst of clicks doesn't pile up AI and Meta calls. A fourth (and fifth…)
// waits as "queued" in the order it was asked for; when a slot frees up the person picks which one to start.

export const MAX_AUDITS = 3;
const STALE_MS = 15 * 60_000; // a "running" audit older than this has timed out and doesn't hold a slot

export type AuditStart = { status: "running" | "queued"; id: string; client: string; full?: boolean } | { error: string };

async function runningFor(admin: SupabaseClient, personId: string) {
  const { count } = await admin
    .from("account_audits")
    .select("id", { count: "exact", head: true })
    .eq("created_by", personId)
    .eq("status", "running")
    .gte("created_at", new Date(Date.now() - STALE_MS).toISOString());
  return count ?? 0;
}

/**
 * Asks for an audit: of a KPI's account (`targetId`), or starting one already queued (`auditId`). Returns "running"
 * (the caller runs it) or "queued" (no free slot: it waits, in order, for the person to start it).
 */
export async function requestAudit(db: SupabaseClient, admin: SupabaseClient, me: Staff, ask: { targetId?: string; auditId?: string }): Promise<AuditStart> {
  if (ask.auditId) {
    const { data: a } = await db.from("account_audits").select("id, status, client_id, clients(name)").eq("id", ask.auditId).maybeSingle();
    if (!a) return { error: "You don't work on this client." };
    const client = (a.clients as unknown as { name: string } | null)?.name ?? "";
    if (a.status !== "queued") return { status: "running", id: a.id, client };
    if ((await runningFor(admin, me.id)) >= MAX_AUDITS) return { status: "queued", id: a.id, client, full: true };
    await admin.from("account_audits").update({ status: "running", created_at: new Date().toISOString(), created_by: me.id, step: "Starting", progress: 2 }).eq("id", a.id);
    return { status: "running", id: a.id, client, started: true } as AuditStart;
  }

  const { data: t } = await db.from("kpi_targets").select("client_id, ad_account_id, platform, clients(name)").eq("id", ask.targetId ?? "").maybeSingle();
  if (!t) return { error: "You don't work on this client." };
  if (t.platform !== "meta" || !t.ad_account_id) return { error: "Audits read Meta ad accounts; this KPI has none." };
  const why = await notLive(db, t.client_id);
  if (why) return { error: why };
  const client = (t.clients as unknown as { name: string } | null)?.name ?? "";

  // One per account: an audit already running or waiting for this account is the one
  const { data: existing } = await admin
    .from("account_audits")
    .select("id, status, created_at")
    .eq("target_id", ask.targetId!)
    .in("status", ["running", "queued"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && (existing.status === "queued" || Date.now() - Date.parse(existing.created_at) < STALE_MS)) return { status: existing.status as "running" | "queued", id: existing.id, client };

  const full = (await runningFor(admin, me.id)) >= MAX_AUDITS;
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("account_audits")
    .insert(
      full
        ? { target_id: ask.targetId, client_id: t.client_id, created_by: me.id, status: "queued", queued_at: now, step: "Waiting for a free slot", progress: 0 }
        : { target_id: ask.targetId, client_id: t.client_id, created_by: me.id, step: "Starting", progress: 2 },
    )
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Couldn't start the audit" };
  return full ? { status: "queued", id: data.id, client, full: true } : ({ status: "running", id: data.id, client, started: true } as AuditStart);
}

export type AuditFeed = {
  max: number;
  running: { id: string; client: string; progress: number }[];
  queued: { id: string; targetId: string; client: string; at: string }[];
  finished: { id: string; client: string; status: "ready" | "failed"; at: string; headline: string | null }[];
};

/** My audits, for the notifications: what's running, what's waiting (oldest first), and what just finished. */
export async function auditFeed(admin: SupabaseClient, personId: string): Promise<AuditFeed> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await admin
    .from("account_audits")
    .select("id, target_id, status, progress, created_at, queued_at, finished_at, result, clients(name)")
    .eq("created_by", personId)
    .or(`status.in.(running,queued),finished_at.gte.${since}`)
    .order("created_at")
    .limit(50);
  const rows = data ?? [];
  const name = (r: (typeof rows)[number]) => (r.clients as unknown as { name: string } | null)?.name ?? "";
  return {
    max: MAX_AUDITS,
    running: rows.filter((r) => r.status === "running" && Date.now() - Date.parse(r.created_at) < STALE_MS).map((r) => ({ id: r.id, client: name(r), progress: r.progress })),
    queued: rows
      .filter((r) => r.status === "queued")
      .sort((a, b) => (a.queued_at ?? a.created_at).localeCompare(b.queued_at ?? b.created_at))
      .map((r) => ({ id: r.id, targetId: r.target_id, client: name(r), at: r.queued_at ?? r.created_at })),
    finished: rows
      .filter((r) => (r.status === "ready" || r.status === "failed") && r.finished_at)
      .map((r) => ({ id: r.id, client: name(r), status: r.status as "ready" | "failed", at: r.finished_at!, headline: (r.result as { verdict?: { headline?: string } } | null)?.verdict?.headline ?? null })),
  };
}
