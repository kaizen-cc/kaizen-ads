import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTrainAgent } from "@/lib/agent-access";

// Whose messages an agent's chat shows. Its trainers (the execs and the head of its line) share one conversation with
// it, where edits are proposed and applied, as before. Everyone else on the team has their own conversation with it
// (their questions, their calls), which never shows up in the trainers' one.

type Me = { id: string; role: string | null | undefined; isExec?: boolean | null };
export type RoleChatRow = { id: number; role: string; content: string; changes: unknown; attachments: unknown; created_at: string; created_by: string | null; call_id: string | null };

export async function roleChatRows(admin: SupabaseClient, me: Me, roleKey: string, opts: { limit: number; newestFirst?: boolean }): Promise<RoleChatRow[]> {
  const trains = canTrainAgent(me, roleKey);
  let q = admin.from("ai_role_chats").select("id, role, content, changes, attachments, created_at, created_by, call_id, profiles:created_by(role, is_exec)").eq("role_key", roleKey);
  if (!trains) q = q.eq("created_by", me.id);
  // Read a little more for trainers: rows from people who don't train it are left out after
  const { data } = await q.order("created_at", { ascending: !opts.newestFirst }).limit(trains ? opts.limit * 2 : opts.limit);
  type Row = RoleChatRow & { profiles: { role: string | null; is_exec: boolean | null } | null };
  const rows = (data ?? []) as unknown as Row[];
  const kept = trains ? rows.filter((r) => !r.created_by || r.created_by === me.id || !r.profiles || canTrainAgent({ role: r.profiles.role, isExec: r.profiles.is_exec }, roleKey)) : rows;
  const out = opts.newestFirst ? kept.slice(0, opts.limit) : kept.slice(-opts.limit);
  return out.map((r) => ({ id: r.id, role: r.role, content: r.content, changes: r.changes, attachments: r.attachments, created_at: r.created_at, created_by: r.created_by, call_id: r.call_id }));
}
