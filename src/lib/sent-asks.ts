import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Reminders, checklists and tasks one person's assistant (or an agent on their call) sent to a teammate, seen from the
// sender's side: who has it, how far through the checklist they are, and the same thread of comments. The recipient
// ticks and replies on their Next for me; the sender sees the progress here and can tick or comment too (creative
// team, Nov 20 2026: a checklist sent to someone wasn't clickable on the sender's side).

export type SentAsk = {
  id: string;
  title: string;
  detail: string | null;
  to: string;
  toId: string;
  status: "open" | "done" | "dismissed";
  checklist: { text: string; done: boolean }[];
  client: { name: string; slug: string } | null;
  due: string | null;
  at: string;
  doneAt: string | null;
};

/** What this person sent to others: everything still open, and what was finished or set aside in the last week */
export async function loadSentAsks(db: SupabaseClient, me: string): Promise<SentAsk[]> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data, error } = await db
    .from("agent_asks")
    .select("id, title, detail, status, checklist, due_on, created_at, done_at, owner_id, owner:profiles!agent_asks_owner_id_fkey(full_name), clients(name, slug)")
    .eq("asked_by", me)
    .neq("owner_id", me)
    .or(`status.eq.open,done_at.gte.${weekAgo}`)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return [];
  type Row = { id: string; title: string; detail: string | null; status: SentAsk["status"]; checklist: { text: string; done: boolean }[] | null; due_on: string | null; created_at: string; done_at: string | null; owner_id: string; owner: { full_name: string } | null; clients: { name: string; slug: string } | null };
  return ((data ?? []) as unknown as Row[]).map((r) => ({ id: r.id, title: r.title, detail: r.detail, to: r.owner?.full_name ?? "A teammate", toId: r.owner_id, status: r.status, checklist: Array.isArray(r.checklist) ? r.checklist : [], client: r.clients, due: r.due_on, at: r.created_at, doneAt: r.done_at }));
}

/** The address that opens one sent item on the sender's Overview */
export const sentHref = (id: string) => `/pipeline?tab=work&sent=${id}#sent`;
