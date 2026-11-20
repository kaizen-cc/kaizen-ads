import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type ImportCounts } from "@/lib/kaizen-ai/imports-summary";

// Execs on the Team page: who has brought their Claude history into Kaizen AI (chats, projects and the projects'
// documents), so Kaizen AI's take-up can be followed. Imports are private to each person, so this is read with the
// server key (only execs reach it). Only people who ever started an import are counted; everyone else is "not yet".
// Before the projects migration, projects and documents read as none.

export async function importsByPerson(admin: SupabaseClient): Promise<Map<string, ImportCounts>> {
  const out = new Map<string, ImportCounts>();
  const { data: runs, error } = await admin.from("ai_imports").select("profile_id").limit(5000);
  if (error) return out;
  const ids = [...new Set((runs ?? []).map((r) => r.profile_id as string))];
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: n, error: e } = await q;
    return e ? 0 : (n ?? 0);
  };
  await Promise.all(
    ids.map(async (id) => {
      const [chats, projects, docs] = await Promise.all([
        count(admin.from("ai_threads").select("id", { head: true, count: "exact" }).eq("profile_id", id).eq("source", "claude")),
        count(admin.from("ai_projects").select("id", { head: true, count: "exact" }).eq("created_by", id).eq("source", "claude")),
        count(admin.from("ai_project_docs").select("id, ai_projects!inner(created_by, source)", { head: true, count: "exact" }).eq("ai_projects.created_by", id).eq("ai_projects.source", "claude")),
      ]);
      out.set(id, { chats, projects, docs });
    }),
  );
  return out;
}
