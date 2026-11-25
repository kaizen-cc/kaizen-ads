import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Each connected person's own Asana > My tasks, mirrored every half hour with their own token, read-only (Nov 25 2026:
// an exec's Claude runs create "[Call 11/24] …" tasks in client projects and his My tasks that the OS never saw, so it
// made the same items again and couldn't close its own when he finished them in Asana). Open tasks and ones completed
// in the last three days, in Kaizen's workspace. The dedupe against reality (src/lib/reality-check.ts), the floating
// sweep, the meaning-level dedupe and the recaps read them.

type Admin = SupabaseClient;
type Task = { gid: string; name: string; notes?: string; due_on: string | null; completed?: boolean; completed_at?: string | null; permalink_url?: string; created_at?: string; modified_at?: string; memberships?: { project?: { name?: string } }[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The client a task is about: its project's or its own name holding the client's name (longest name first) */
export function clientOfTask(t: { name: string; projects: readonly string[] }, clients: readonly { id: string; name: string }[]): string | null {
  const hay = norm(`${t.projects.join(" ")} ${t.name}`);
  return clients.filter((c) => norm(c.name).length >= 4 && hay.includes(norm(c.name))).sort((a, b) => b.name.length - a.name.length)[0]?.id ?? null;
}

export async function syncPersonAsana(admin: Admin, opts: { people?: number; onlyProfile?: string } = {}) {
  let q = admin.from("asana_user_tokens").select("profile_id, last_synced_at, confirmed").neq("confirmed", false);
  if (opts.onlyProfile) q = q.eq("profile_id", opts.onlyProfile);
  const { data: people } = await q.limit(200);
  if (!people?.length) return { people: 0, tasks: 0 };
  // The ones read longest ago first, a few per run (each is a handful of Asana calls)
  const { data: last } = await admin.from("asana_person_tasks").select("profile_id, synced_at").in("profile_id", people.map((p) => p.profile_id as string)).order("synced_at", { ascending: false }).limit(2000);
  const lastOf = new Map<string, string>();
  for (const r of last ?? []) if (!lastOf.has(r.profile_id as string)) lastOf.set(r.profile_id as string, r.synced_at as string);
  const order = people.map((p) => p.profile_id as string).sort((a, b) => (lastOf.get(a) ?? "").localeCompare(lastOf.get(b) ?? ""));
  const { data: clients } = await admin.from("clients").select("id, name").is("archived_at", null).limit(1000);
  const { asanaTokenFor } = await import("@/lib/asana-user");
  const { asanaForPerson } = await import("@/lib/asana");
  const { asana, asanaAll, kaizenWorkspace } = await import("@/lib/asana");
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let total = 0;
  let done = 0;
  for (const pid of order.slice(0, opts.people ?? 6)) {
    // Their own token only: never the shared token's "me" (that's the bot account's tasks)
    const token = (await asanaTokenFor(admin, pid).catch(() => null))?.access_token ?? null;
    if (!token) continue;
    const tasks = await asanaForPerson(pid, token, async () => {
      const ws = await kaizenWorkspace();
      if (!ws) return null;
      const list = await asana<{ gid: string }>("/users/me/user_task_list", { workspace: ws });
      if (!list?.data?.gid) return null;
      return asanaAll<Task>(`/user_task_lists/${list.data.gid}/tasks`, { completed_since: since, opt_fields: "name,notes,due_on,completed,completed_at,permalink_url,created_at,modified_at,memberships.project.name" });
    }).catch((e) => {
      console.error("[asana-person]", pid, e instanceof Error ? e.message : e);
      return null;
    });
    if (!tasks) continue;
    const now = new Date().toISOString();
    const rows = tasks
      .filter((t) => t.name?.trim())
      .map((t) => {
        const projects = (t.memberships ?? []).map((m) => m.project?.name ?? "").filter(Boolean);
        return {
          gid: t.gid,
          profile_id: pid,
          name: t.name.slice(0, 500),
          notes: t.notes?.slice(0, 4000) ?? null,
          project: projects[0] ?? null,
          client_id: clientOfTask({ name: t.name, projects }, (clients ?? []) as { id: string; name: string }[]),
          due_on: t.due_on,
          completed: Boolean(t.completed),
          completed_at: t.completed_at ?? null,
          url: t.permalink_url ?? `https://app.asana.com/0/0/${t.gid}`,
          asana_created_at: t.created_at ?? null,
          asana_modified_at: t.modified_at ?? null,
          synced_at: now,
        };
      });
    for (let i = 0; i < rows.length; i += 500) await admin.from("asana_person_tasks").upsert(rows.slice(i, i + 500), { onConflict: "gid,profile_id" });
    // Gone from their list (reassigned, deleted, done long ago): dropped
    await admin.from("asana_person_tasks").delete().eq("profile_id", pid).lt("synced_at", now);
    total += rows.length;
    done++;
  }
  return { people: done, tasks: total };
}
