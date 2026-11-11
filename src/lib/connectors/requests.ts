import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { ROLES } from "@/lib/roles";
import { offeredTo } from "./core";
import { askNotices, cleanNote, declinedNotices, groupRequests, planRequest, readyNotices, REF_RE, type Notice, type RequestGroup, type RequestRow } from "./requests-core";
import { chatConnectHref, requestsHref, browseHref } from "./shared";

// Requests to enable a connector (ai_connector_requests): a person asks from Kaizen AI's Browse connectors, every exec
// (the owner included) hears on the bell and by email, and enabling or declining tells everyone who asked. Before the
// migration is applied, reads come back empty and asking says the update is needed.

const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
const COLS = "id, profile_id, ref, title, icon_url, note, status, created_at";
export const REQUESTS_NOT_READY = "Requests need the latest database update first.";
const missing = (e: { code?: string } | null) => e?.code === "42P01" || e?.code === "PGRST205";
const roleLabel = (r: string | null | undefined) => ROLES.find((x) => x.value === r)?.label ?? "Someone on the team";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function execs(admin: SupabaseClient) {
  const { data } = await admin.from("profiles").select("id, email").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null);
  return (data ?? []) as { id: string; email: string | null }[];
}

/** The bell, and the same lines by email (a request is something to act on, so it doesn't wait for the digest) */
async function deliver(admin: SupabaseClient, notices: Notice[], button: string) {
  if (!notices.length) return;
  const { error } = await admin.from("notifications").upsert(notices, { onConflict: "profile_id,key", ignoreDuplicates: true });
  if (error) console.error("[connectors] request notice", error.message);
  const { data: people } = await admin.from("profiles").select("id, email").in("id", [...new Set(notices.map((n) => n.profile_id))]);
  for (const n of notices) {
    const to = (people ?? []).find((p) => p.id === n.profile_id)?.email as string | undefined;
    if (!to) continue;
    const url = `${SITE()}${n.href}`;
    await sendEmail({
      to,
      subject: n.title.slice(0, 200),
      text: `${n.title}\n\n${n.body}\n\n${button}: ${url}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 14px">Kaizen AI · Connectors</p><p style="font-size:17px;font-weight:600;margin:0 0 8px">${esc(n.title)}</p><p style="font-size:14px;color:#4a4450;white-space:pre-wrap;margin:0 0 18px">${esc(n.body)}</p><a href="${url}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#17131a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none">${esc(button)}</a></div>`,
    }).catch(() => null);
  }
}

/** The refs this person has pending (empty before the migration) */
export async function myPendingRefs(admin: SupabaseClient, profileId: string): Promise<Set<string>> {
  const { data, error } = await admin.from("ai_connector_requests").select("ref").eq("profile_id", profileId).eq("status", "pending");
  return new Set(error ? [] : (data ?? []).map((r) => r.ref as string));
}

/** What a ref points at: a Directory entry, or a connector the team has */
async function target(admin: SupabaseClient, ref: string): Promise<{ title: string; icon_url: string | null; connector: { id: string; key: string; name: string; enabled: boolean; roles: string[] | null } | null } | null> {
  if (ref.startsWith("connector:")) {
    const { data } = await admin.from("ai_connectors").select("id, key, name, icon_url, enabled, roles").eq("id", ref.slice(10)).maybeSingle();
    return data ? { title: data.name as string, icon_url: (data.icon_url as string | null) ?? null, connector: data as { id: string; key: string; name: string; enabled: boolean; roles: string[] | null } } : null;
  }
  const { data: e } = await admin.from("ai_connector_registry").select("name, title, icon_url, url").eq("name", ref).maybeSingle();
  if (!e) return null;
  const { data: c } = await admin.from("ai_connectors").select("id, key, name, enabled, roles").eq("registry_name", ref).maybeSingle();
  return { title: String(e.title || e.name).slice(0, 60), icon_url: (e.icon_url as string | null) ?? null, connector: (c as { id: string; key: string; name: string; enabled: boolean; roles: string[] | null } | null) ?? null };
}

/**
 * Ask for a connector: one pending request per person per connector (asking again updates the note and tells no one
 * again). A new one goes to every exec on the bell and by email, with Enable one click away.
 */
export async function askToEnable(admin: SupabaseClient, me: Staff, ref: string, note: unknown): Promise<{ ok: true; already: boolean } | { ok: false; error: string; enabled?: boolean }> {
  if (!REF_RE.test(ref)) return { ok: false, error: "That connector isn't in the Directory." };
  const t = await target(admin, ref);
  if (!t) return { ok: false, error: "That connector isn't in the Directory any more." };
  if (t.connector && offeredTo(t.connector, me.role, me.isExec)) return { ok: false, error: `${t.title} is already enabled for you. Connect it from the plug menu.`, enabled: true };
  const { data: mine, error } = await admin.from("ai_connector_requests").select("id, ref, status").eq("profile_id", me.id).eq("ref", ref);
  if (error) return { ok: false, error: missing(error) ? REQUESTS_NOT_READY : error.message };
  const plan = planRequest((mine ?? []) as Pick<RequestRow, "id" | "ref" | "status">[], ref);
  const text = cleanNote(note);
  const now = new Date().toISOString();
  if (plan.kind === "update") {
    const { error: e } = await admin.from("ai_connector_requests").update({ note: text, updated_at: now }).eq("id", plan.id);
    return e ? { ok: false, error: e.message } : { ok: true, already: true };
  }
  const { data: row, error: e } = await admin
    .from("ai_connector_requests")
    .insert({ profile_id: me.id, ref, title: t.title, icon_url: t.icon_url, note: text, status: "pending" })
    .select("id")
    .single();
  if (e || !row) {
    // Two clicks at once: the unique index keeps one, which is the request
    if (e?.code === "23505") return { ok: true, already: true };
    return { ok: false, error: missing(e) ? REQUESTS_NOT_READY : (e?.message ?? "Couldn't send the request.") };
  }
  const notices = askNotices(await execs(admin), { id: row.id as string, title: t.title, ref, roleLabel: roleLabel(me.role), note: text, requester: me.id }, requestsHref(ref));
  await deliver(admin, notices, "Enable or decline");
  return { ok: true, already: false };
}

/** The pending requests, grouped by connector, for Settings (empty before the migration) */
export async function pendingRequests(admin: SupabaseClient): Promise<RequestGroup[]> {
  const { data, error } = await admin.from("ai_connector_requests").select(`${COLS}, profiles!ai_connector_requests_profile_id_fkey(full_name, role)`).eq("status", "pending").order("created_at").limit(300);
  if (error) return [];
  return groupRequests(
    (data ?? []).map((r) => {
      const p = (r as unknown as { profiles: { full_name: string | null; role: string | null } | null }).profiles;
      return { ...(r as unknown as RequestRow), name: p?.full_name ?? "Someone", role: roleLabel(p?.role) };
    }),
  );
}

/** The ref a request is for (the bell's Enable carries the request's id) */
export async function refOfRequest(admin: SupabaseClient, id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await admin.from("ai_connector_requests").select("ref").eq("id", id).maybeSingle();
  return (data?.ref as string | undefined) ?? null;
}

/** The roles of the people waiting on this ref (to widen a role-limited connector to them) */
export async function askerRoles(admin: SupabaseClient, ref: string): Promise<string[]> {
  const { data, error } = await admin.from("ai_connector_requests").select("profiles!ai_connector_requests_profile_id_fkey(role)").eq("ref", ref).eq("status", "pending");
  if (error) return [];
  return [...new Set((data ?? []).map((r) => (r as unknown as { profiles: { role: string | null } | null }).profiles?.role).filter((x): x is string => Boolean(x)))];
}

/** It's enabled: the pending requests close and everyone who asked hears it's ready, with the link to connect */
export async function settleEnabled(admin: SupabaseClient, ref: string, c: { key: string; name: string }, by: string) {
  const { data, error } = await admin.from("ai_connector_requests").select("id, profile_id").eq("ref", ref).eq("status", "pending");
  if (error || !data?.length) return 0;
  await admin.from("ai_connector_requests").update({ status: "enabled", decided_by: by, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", data.map((r) => r.id as string));
  await deliver(admin, readyNotices(data as { id: string; profile_id: string }[], c, chatConnectHref(c.key), by), `Connect ${c.name}`);
  return data.length;
}

/** Declined: the pending requests close with the reason, and everyone who asked hears it */
export async function settleDeclined(admin: SupabaseClient, ref: string, reason: unknown, by: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { data, error } = await admin.from("ai_connector_requests").select("id, profile_id, title").eq("ref", ref).eq("status", "pending");
  if (error) return { ok: false, error: missing(error) ? REQUESTS_NOT_READY : error.message };
  if (!data?.length) return { ok: true, count: 0 };
  const why = cleanNote(reason);
  await admin.from("ai_connector_requests").update({ status: "declined", reason: why, decided_by: by, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", data.map((r) => r.id as string));
  await deliver(admin, declinedNotices(data as { id: string; profile_id: string }[], String(data[0].title), why, browseHref(), by), "Browse connectors");
  return { ok: true, count: data.length };
}
