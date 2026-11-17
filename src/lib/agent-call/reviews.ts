import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTrainAgent } from "@/lib/agent-access";
import type { Staff } from "@/lib/auth";
import { CALL_LIMIT_SECONDS, pendingOf, type LearnedItem } from "./core";

// The calls whose learnings still wait for this person to keep or toss (they hung up without deciding, the tab
// closed, the phone dropped): for their Overview's Next for me and the agent's page. Their own calls only, on agents
// they may train.

export type CallReview = { callId: string; roleKey: string; roleLabel: string; icon: string | null; startedAt: string; items: LearnedItem[] };

export async function loadCallReviews(admin: SupabaseClient, me: Staff, roleKey?: string): Promise<CallReview[]> {
  let q = admin.from("ai_role_calls").select("id, role_key, started_at, ended_at, learned").eq("profile_id", me.id).is("reviewed_at", null).order("started_at", { ascending: false }).limit(20);
  if (roleKey) q = q.eq("role_key", roleKey);
  const { data, error } = await q;
  if (error || !data?.length) return [];
  // A call still going isn't ready; one past its time without a hang-up is (the sweep closes it soon)
  const stale = Date.now() - (CALL_LIMIT_SECONDS + 120) * 1000;
  const rows = data.filter((c) => (c.ended_at || Date.parse(c.started_at as string) < stale) && canTrainAgent(me, c.role_key as string));
  const ready = rows.map((c) => ({ c, items: pendingOf((c.learned ?? []) as LearnedItem[]) })).filter((x) => x.items.length);
  if (!ready.length) return [];
  const { data: roles } = await admin.from("ai_roles").select("key, label, icon").in("key", [...new Set(ready.map((x) => x.c.role_key as string))]);
  const roleBy = new Map((roles ?? []).map((r) => [r.key as string, r]));
  return ready.map(({ c, items }) => ({
    callId: c.id as string,
    roleKey: c.role_key as string,
    roleLabel: (roleBy.get(c.role_key as string)?.label as string | undefined) ?? "agent",
    icon: (roleBy.get(c.role_key as string)?.icon as string | null | undefined) ?? null,
    startedAt: c.started_at as string,
    items,
  }));
}

