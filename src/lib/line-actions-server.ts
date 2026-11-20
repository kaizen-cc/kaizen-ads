import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mayActOnLine, mayAskTeammate, mayAudit, type ActLine, type LineVerdict, type LineWho } from "@/lib/line-actions";

// The server's side of who may act on a client's line (src/lib/line-actions.ts): the seats the person holds on the
// client are read here, so every audit, sprint, request and ask is checked the same way wherever it starts.

export type Actor = LineWho & { id: string };

/** The seat roles this person holds on the client */
export async function seatsOnClient(admin: SupabaseClient, profileId: string, clientId: string | null | undefined): Promise<string[]> {
  if (!clientId || !profileId) return [];
  const { data } = await admin.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", profileId);
  return (data ?? []).map((r) => r.role as string);
}

/** The person by id (for library functions handed only an id) */
async function actorById(admin: SupabaseClient, id: string): Promise<Actor | null> {
  const { data } = await admin.from("profiles").select("id, role, is_exec, is_active").eq("id", id).maybeSingle();
  if (!data?.is_active) return null;
  return { id: data.id as string, role: data.role as string, isExec: Boolean(data.is_exec) };
}

const NOT_STAFF: LineVerdict = { ok: false, reason: "Only active team members can do this." };

export async function mayAuditOn(admin: SupabaseClient, who: Actor | string, clientId: string, line: ActLine): Promise<LineVerdict> {
  const me = typeof who === "string" ? await actorById(admin, who) : who;
  if (!me) return NOT_STAFF;
  return mayAudit(me, line, await seatsOnClient(admin, me.id, clientId));
}

export async function mayActOn(admin: SupabaseClient, who: Actor | string, clientId: string, line: ActLine, doing?: string): Promise<LineVerdict> {
  const me = typeof who === "string" ? await actorById(admin, who) : who;
  if (!me) return NOT_STAFF;
  return mayActOnLine(me, line, await seatsOnClient(admin, me.id, clientId), doing);
}

export async function mayAskOn(admin: SupabaseClient, me: Actor, clientId: string | null | undefined, kind: "task" | "ask" | "fyi" = "task"): Promise<LineVerdict> {
  // An ask that isn't about a client isn't a client chat's deployment
  if (!clientId) return { ok: true, reason: null };
  return mayAskTeammate(me, await seatsOnClient(admin, me.id, clientId), kind);
}
