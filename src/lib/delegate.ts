import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeTeam, clientTeam } from "@/lib/assistant/routing-server";
import { tellTeammate } from "@/lib/assistant/handoff-server";
import { cleanDue, delegateCandidates, delegatedDetail, delegatedTitle, delegationState } from "@/lib/delegate-core";

type Me = { id: string; fullName: string; role: string; isExec: boolean };

/** The people the delegator can hand an item to, the client's seat holders first */
export async function loadDelegates(admin: SupabaseClient, me: Me, clientId: string | null) {
  const [team, ct] = await Promise.all([activeTeam(admin), clientId ? clientTeam(admin, clientId) : Promise.resolve(null)]);
  return delegateCandidates({ id: me.id, role: me.role, isExec: me.isExec }, team.map((p) => ({ id: p.id, name: p.fullName, role: String(p.role) })), ct?.seats.map((s) => s.profileId) ?? []);
}

/**
 * Hands an item on someone's Overview to a teammate (send_to_teammate's path): a task on their Next for me, a bell
 * notice and a Slack DM, credited to the delegator. The item's ref ties it back so it shows "Delegated to ..." and
 * clears when they mark it done.
 */
export async function delegateItem(admin: SupabaseClient, me: Me, input: { ref: string; clientId: string | null; title: string; to: string; note?: string | null; due?: string | null; why?: string | null }) {
  const picks = await loadDelegates(admin, me, input.clientId);
  const to = picks.find((p) => p.id === input.to);
  if (!to) return { ok: false as const, error: "You can't hand it to that person. Pick someone from the list." };
  const title = delegatedTitle(me.fullName, input.title);
  const { data, error } = await admin
    .from("agent_asks")
    .insert({ kind: "task", owner_id: to.id, asked_by: me.id, client_id: input.clientId, title: input.title.replace(/^Brief ready:\s*/i, "Brief: ").slice(0, 300), detail: delegatedDetail({ from: me.fullName, note: input.note, why: input.why }), due_on: cleanDue(input.due), source_ref: input.ref })
    .select("id")
    .single();
  if (error || !data) return { ok: false as const, error: "It didn't save. Try again." };
  const told = await tellTeammate(admin, { ownerId: to.id, askId: data.id as string, title, body: `${input.note?.trim() || input.title} (delegated by ${me.fullName})` });
  return { ok: true as const, askId: data.id as string, to: to.name, slack: told.slack };
}

/** The delegator's delegations of these items: which show "Delegated to ..." and which are done and clear */
export async function loadDelegations(db: SupabaseClient, me: string, refs: string[]) {
  if (!refs.length) return (ref: string | undefined) => delegationState(ref, []);
  const { data, error } = await db.from("agent_asks").select("id, source_ref, status, owner:profiles!agent_asks_owner_id_fkey(full_name)").eq("asked_by", me).in("source_ref", refs).limit(100);
  const rows = error ? [] : ((data ?? []) as unknown as { id: string; source_ref: string; status: string; owner: { full_name: string } | null }[]).map((r) => ({ id: r.id, source_ref: r.source_ref, status: r.status, ownerName: r.owner?.full_name ?? null }));
  return (ref: string | undefined) => delegationState(ref, rows);
}
