import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actableLines, type LineId } from "@/lib/client-lines";
import { serviceMismatches, type Billed, type Mismatch } from "./core";

// What the account watch shows: open flags (each person's lines; execs everything), the paused services, the Stripe
// mapping check and the unrecognized people (execs and leads). Read with the person's own session, so only clients
// they can see.

export type WatchFlag = {
  id: string;
  kind: string;
  clientId: string;
  client: string;
  slug: string;
  line: string | null;
  account: string | null;
  title: string;
  body: string | null;
  detail: Record<string, unknown>;
  severity: "critical" | "warn" | "info";
  openedAt: string;
};
export type WatchPause = { id: string; clientId: string; client: string; slug: string; service: string; until: string; reason: string };
export type WatchMismatch = Mismatch & { clientId: string; client: string; slug: string };

/** The tabs: billed but idle, accounts (neglect, overtouch, spend), creative, people, and the Stripe check */
export const WATCH_GROUP: Record<string, "idle" | "accounts" | "creative" | "people"> = {
  idle: "idle",
  neglected: "accounts",
  overtouched: "accounts",
  spend_spike: "accounts",
  spend_drop: "accounts",
  spend_stopped: "accounts",
  overspend: "accounts",
  creative_behind: "creative",
  creative_quiet: "creative",
  creative_sprint: "creative",
  unrecognized: "people",
};

const LINE_OF_SERVICE: Record<string, LineId> = { "facebook-ads": "meta", "google-ads": "google", "tiktok-ads": "tiktok", creative: "creative", "email-marketing": "email", "social-media": "social" };

export async function loadWatch(db: SupabaseClient, me: { id: string; role: string; isExec: boolean; isLead: boolean }, opts: { clientId?: string | null } = {}) {
  const sees = me.isExec || me.isLead;
  let q = db.from("watch_flags").select("id, kind, client_id, line, account, title, body, detail, severity, opened_at, clients!inner(name, slug)").is("resolved_at", null).order("opened_at", { ascending: false }).limit(500);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const [{ data: rows }, { data: seats }, { data: pauseRows }] = await Promise.all([
    q,
    db.from("client_assignments").select("client_id, role").eq("profile_id", me.id),
    db.from("watch_pauses").select("id, client_id, service, until, reason, clients!inner(name, slug)").is("cleared_at", null).gte("until", new Date().toISOString().slice(0, 10)).order("until"),
  ]);
  const seatsBy = new Map<string, string[]>();
  for (const s of seats ?? []) seatsBy.set(s.client_id as string, [...(seatsBy.get(s.client_id as string) ?? []), s.role as string]);
  const flags: WatchFlag[] = ((rows ?? []) as unknown as (Record<string, unknown> & { clients: { name: string; slug: string } })[])
    .map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      clientId: r.client_id as string,
      client: r.clients.name,
      slug: r.clients.slug,
      line: (r.line as string | null) ?? null,
      account: (r.account as string | null) ?? null,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      severity: r.severity as WatchFlag["severity"],
      openedAt: r.opened_at as string,
    }))
    .filter((f) => {
      if (me.isExec) return true;
      // People in change history: execs (and leads, who can place them)
      if (f.kind === "unrecognized") return sees;
      const line = f.line ? LINE_OF_SERVICE[f.line] : null;
      return !line || actableLines(me, seatsBy.get(f.clientId) ?? []).has(line);
    });
  const order = { critical: 0, warn: 1, info: 2 } as const;
  flags.sort((a, b) => order[a.severity] - order[b.severity] || b.openedAt.localeCompare(a.openedAt));
  const pauses: WatchPause[] = ((pauseRows ?? []) as unknown as (Record<string, unknown> & { clients: { name: string; slug: string } })[]).map((p) => ({ id: p.id as string, clientId: p.client_id as string, client: p.clients.name, slug: p.clients.slug, service: p.service as string, until: p.until as string, reason: p.reason as string }));
  return { flags, pauses, canDecide: sees };
}

/** Execs and leads: every client where Kaizen OS and Stripe disagree on what they buy */
export async function loadMismatches(db: SupabaseClient): Promise<{ rows: WatchMismatch[]; syncedAt: string | null }> {
  const { data } = await db.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only, billed_services, billed_synced_at, creative_package").is("archived_at", null).in("status", ["active", "onboarding"]).order("name");
  const rows: WatchMismatch[] = [];
  let syncedAt: string | null = null;
  for (const c of data ?? []) {
    if (c.billed_synced_at && (!syncedAt || c.billed_synced_at > syncedAt)) syncedAt = c.billed_synced_at as string;
    for (const m of serviceMismatches({ ...c, billed_services: (c.billed_services ?? {}) as Billed })) rows.push({ ...m, clientId: c.id as string, client: c.name as string, slug: c.slug as string });
  }
  return { rows, syncedAt };
}

/** Open flags per client, for the chips on the clients list (one read, never per card) */
export async function watchChips(db: SupabaseClient): Promise<Record<string, { title: string; critical: boolean }[]>> {
  const { data } = await db.from("watch_flags").select("client_id, title, severity, kind").is("resolved_at", null).neq("kind", "creative_sprint").limit(1000);
  const out: Record<string, { title: string; critical: boolean }[]> = {};
  for (const f of data ?? []) (out[f.client_id as string] ??= []).push({ title: f.title as string, critical: f.severity === "critical" });
  for (const k of Object.keys(out)) out[k].sort((a, b) => Number(b.critical) - Number(a.critical));
  return out;
}
