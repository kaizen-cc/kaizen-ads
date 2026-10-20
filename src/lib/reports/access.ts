import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isExecOrLead, type Staff } from "@/lib/auth";

// Who can draft, see and send an account's reports: its buyer (the KPI's owner, or whoever holds the client's Meta or
// Google buyer slot for that platform), the leads of that line (the Head of Meta for Meta, the Head of Google for
// Google, other leads for all), and execs. One rule for the Reports page, a report itself, and recaps on demand.

type T = { id: string; client_id: string; platform: string; owner_id: string | null };

const lineOf = (me: Staff) => (me.role === "head_of_meta" ? "meta" : me.role === "head_of_google" ? "google" : null);

/** The accounts (KPI targets with an ad account) this person can report on, with their client's name. */
export async function reportableTargets(db: SupabaseClient, me: Staff) {
  let q = db.from("kpi_targets").select("id, client_id, platform, label, owner_id, clients!inner(name, archived_at)").eq("active", true).not("ad_account_id", "is", null).is("clients.archived_at", null);
  const line = lineOf(me);
  if (line) q = q.eq("platform", line);
  const { data } = await q;
  const rows = (data ?? []) as unknown as (T & { label: string | null; clients: { name: string } })[];
  if (isExecOrLead(me)) return rows;
  const mine = await assignedClients(db, me.id);
  return rows.filter((t) => t.owner_id === me.id || mine.get(t.platform)?.has(t.client_id));
}

/** The clients someone holds the Meta or Google buyer slot on, by platform. */
async function assignedClients(db: SupabaseClient, profileId: string) {
  const { data } = await db.from("client_assignments").select("client_id, role").eq("profile_id", profileId).in("role", ["meta_buyer", "google_buyer"]);
  const out = new Map<string, Set<string>>([
    ["meta", new Set()],
    ["google", new Set()],
  ]);
  for (const a of data ?? []) out.get(a.role === "google_buyer" ? "google" : "meta")!.add(a.client_id as string);
  return out;
}

/** Whether this person can work on this account's reports. */
export async function canReportOn(db: SupabaseClient, me: Staff, t: T) {
  const line = lineOf(me);
  if (me.isExec) return true;
  if (isExecOrLead(me)) return !line || line === t.platform;
  if (t.owner_id === me.id) return true;
  return (await assignedClients(db, me.id)).get(t.platform)?.has(t.client_id) ?? false;
}
