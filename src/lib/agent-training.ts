import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeChange, isHeadTrainer, type Snapshot } from "@/lib/agent-access";
import { roleLabel, type TeamRole } from "@/lib/roles";

// A change to an AI agent's playbook, kept with what it replaced and what it wrote (agent_changes), so an exec can see
// the before and after and put it back in one click. A head's change also lands in the execs' quiet daily digest.

type Me = { id: string; role: string; isExec: boolean };

const AGENT_FIELDS = "instructions, model, effort";
const ITEM_FIELDS = "agent_key, kind, title, body, active";

/** The record as it is now: agent:<key> (instructions and brain), item:<id>, or role:<key> (its core) */
export async function snapshot(admin: SupabaseClient, record: string): Promise<Snapshot> {
  const [type, id] = [record.slice(0, record.indexOf(":")), record.slice(record.indexOf(":") + 1)];
  if (!id) return null;
  if (type === "agent") return ((await admin.from("ai_agents").select(AGENT_FIELDS).eq("key", id).maybeSingle()).data as Snapshot) ?? null;
  if (type === "item") return ((await admin.from("ai_knowledge").select(ITEM_FIELDS).eq("id", id).maybeSingle()).data as Snapshot) ?? null;
  if (type === "role") return ((await admin.from("ai_roles").select("core").eq("key", id).maybeSingle()).data as Snapshot) ?? null;
  return null;
}

const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

/** Labels for the digest line: the agent (role) and the skill a record belongs to */
async function labelsFor(admin: SupabaseClient, c: { agentKey?: string | null; roleKey?: string | null }) {
  let roleKey = c.roleKey ?? null;
  let skillLabel: string | null = null;
  if (c.agentKey) {
    const { data } = await admin.from("ai_agents").select("label, role_key").eq("key", c.agentKey).maybeSingle();
    skillLabel = (data?.label as string | undefined) ?? null;
    roleKey = roleKey ?? ((data?.role_key as string | null) ?? null);
  }
  const { data: role } = roleKey ? await admin.from("ai_roles").select("label").eq("key", roleKey).maybeSingle() : { data: null };
  return { roleLabel: (role?.label as string | undefined) ?? null, skillLabel };
}

/**
 * Keep a saved change in the agent's history, with its before and after, and (when a head made it) tell the execs in
 * the day's digest. Never throws: a failed log never undoes a saved change.
 */
export async function logTraining(admin: SupabaseClient, c: { me: Me; agentKey?: string | null; roleKey?: string | null; target: string; record: string; before: Snapshot }) {
  try {
    const after = await snapshot(admin, c.record);
    const head = isHeadTrainer(c.me);
    const who = roleLabel(c.me.role as TeamRole);
    const summary = describeChange({ who, record: c.record, before: c.before, after, ...(await labelsFor(admin, c)) });
    const { recordChange } = await import("@/lib/agent-evals");
    await recordChange(admin, {
      agentKey: c.agentKey ?? null,
      roleKey: c.roleKey ?? null,
      target: c.target,
      by: c.me.id,
      extra: { record: c.record, before: c.before, after, changed_as: c.me.role, by_head: head, summary },
    });
    if (head) await digestForExecs(admin);
  } catch (e) {
    console.error("[agent training] log", e instanceof Error ? e.message : e);
  }
}

/**
 * The execs' quiet digest of what the heads changed today: one notice per exec per day (not an alert, never emailed),
 * rewritten as changes come in, pointing to Settings › AI agents › Changes where each can be reverted.
 */
export async function digestForExecs(admin: SupabaseClient) {
  const today = nyDate(new Date());
  const { data: rows } = await admin
    .from("agent_changes")
    .select("summary, changed_at, reverted_at")
    .eq("by_head", true)
    .gte("changed_at", new Date(Date.now() - 30 * 3_600_000).toISOString())
    .order("changed_at", { ascending: true });
  const lines = (rows ?? []).filter((r) => nyDate(new Date(r.changed_at as string)) === today && r.summary).map((r) => `${r.summary}${r.reverted_at ? " (reverted)" : ""}`);
  if (!lines.length) return;
  const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_exec", true);
  if (!execs?.length) return;
  const title = lines.length === 1 ? "A head trained an AI agent today" : `Heads made ${lines.length} changes to the AI agents today`;
  await admin.from("notifications").upsert(
    execs.map((x) => ({ profile_id: x.id, kind: "agent", title, body: lines.join(" · ").slice(0, 1500), href: "/settings?tab=agents&section=changes", key: `agent-heads:${today}`, priority: "normal", read_at: null })),
    { onConflict: "profile_id,key" },
  );
}

const same = (a: Snapshot, b: Snapshot, fields: string[]) => fields.every((f) => JSON.stringify(a?.[f] ?? null) === JSON.stringify(b?.[f] ?? null));

/**
 * Put a change back (execs): the record returns to what it was before. A new item is turned off, never deleted. If the
 * record has changed again since, the later change has to be reverted first. The revert is itself kept in the history.
 */
export async function revertChange(admin: SupabaseClient, me: Me, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: ch } = await admin.from("agent_changes").select("id, agent_key, role_key, target, record, before, after, reverted_at").eq("id", id).maybeSingle();
  if (!ch?.record) return { ok: false, error: "That change can't be reverted (it was made before changes were kept in full)." };
  if (ch.reverted_at) return { ok: true };
  const record = ch.record as string;
  const before = (ch.before ?? null) as Snapshot;
  const after = (ch.after ?? null) as Snapshot;
  const now = await snapshot(admin, record);
  const key = record.slice(record.indexOf(":") + 1);
  const at = new Date().toISOString();
  let error: { message: string } | null = null;
  if (record.startsWith("agent:")) {
    const f = ["instructions", "model", "effort"];
    if (!same(now, after, f)) return { ok: false, error: "It has changed again since. Revert the later change first." };
    error = (await admin.from("ai_agents").update({ instructions: before?.instructions ?? "", model: before?.model, effort: before?.effort, updated_by: me.id, updated_at: at }).eq("key", key)).error;
  } else if (record.startsWith("role:")) {
    if (!same(now, after, ["core"])) return { ok: false, error: "It has changed again since. Revert the later change first." };
    error = (await admin.from("ai_roles").update({ core: before?.core ?? "", updated_by: me.id, updated_at: at }).eq("key", key)).error;
  } else if (record.startsWith("item:")) {
    if (!now) return { ok: false, error: "That item isn't there any more." };
    if (!same(now, after, ["kind", "title", "body", "active"])) return { ok: false, error: "It has changed again since. Revert the later change first." };
    const patch = before ? { kind: before.kind, title: before.title, body: before.body, active: before.active, updated_at: at } : { active: false, updated_at: at };
    error = (await admin.from("ai_knowledge").update(patch).eq("id", key)).error;
  } else return { ok: false, error: "Unknown change." };
  if (error) return { ok: false, error: error.message };
  await admin.from("agent_changes").update({ reverted_at: at, reverted_by: me.id }).eq("id", id);
  await logTraining(admin, { me, agentKey: ch.agent_key as string | null, roleKey: ch.role_key as string | null, target: ch.target as string, record, before: now });
  return { ok: true };
}

export type HeadChange = { id: string; at: string; summary: string; by: string | null; before: Snapshot; after: Snapshot; record: string; revertedAt: string | null; revertedBy: string | null };

/** The heads' recent changes, newest first, for the execs' Changes view */
export async function loadHeadChanges(admin: SupabaseClient, limit = 60): Promise<HeadChange[]> {
  const { data } = await admin
    .from("agent_changes")
    .select("id, changed_at, summary, record, before, after, reverted_at, by:profiles!agent_changes_changed_by_fkey(full_name), rev:profiles!agent_changes_reverted_by_fkey(full_name)")
    .eq("by_head", true)
    .order("changed_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    at: r.changed_at as string,
    summary: (r.summary as string | null) ?? "",
    by: (r.by as unknown as { full_name: string } | null)?.full_name ?? null,
    before: (r.before ?? null) as Snapshot,
    after: (r.after ?? null) as Snapshot,
    record: (r.record as string | null) ?? "",
    revertedAt: (r.reverted_at as string | null) ?? null,
    revertedBy: (r.rev as unknown as { full_name: string } | null)?.full_name ?? null,
  }));
}
