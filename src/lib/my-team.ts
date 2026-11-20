import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MakerTask } from "@/lib/maker-day";

// "My team" for the creative leads (the creative team, Nov 20 2026): the lead video editor sees every video editor's
// plate, the lead graphic designer every designer's (the Head of Creative both): their Asana tasks and board tickets,
// briefs they started and haven't sent, and what's overdue. Read with the server's rights after the role check, since
// a lead's own session can't read a teammate's tasks.

export const TEAM_OF: Record<string, readonly string[]> = {
  lead_video_editor: ["video_editor"],
  lead_graphic_designer: ["graphic_designer"],
  head_of_creative: ["video_editor", "graphic_designer", "lead_video_editor", "lead_graphic_designer"],
};

export const hasMyTeam = (role: string | null | undefined) => Boolean(TEAM_OF[String(role ?? "")]);

export type TeamMember = { id: string; name: string; role: string; tasks: MakerTask[]; overdue: number; onThem: number; briefs: { id: string; title: string; client: string | null; at: string }[] };

const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function loadMyTeam(admin: SupabaseClient, leadRole: string, leadId: string): Promise<TeamMember[]> {
  const roles = TEAM_OF[leadRole];
  if (!roles) return [];
  const { data: people } = await admin.from("profiles").select("id, full_name, role").eq("is_active", true).in("role", [...roles]).neq("id", leadId).order("full_name");
  const { makerTasks } = await import("@/lib/maker-day");
  const today = todayNY();
  return Promise.all(
    ((people ?? []) as { id: string; full_name: string; role: string }[]).map(async (p) => {
      // A lead maker's own plate reads like their team's (their role's work)
      const as = p.role === "lead_video_editor" ? "video_editor" : p.role === "lead_graphic_designer" ? "graphic_designer" : p.role;
      const [tasks, { data: drafts }] = await Promise.all([
        makerTasks(admin, { id: p.id, role: as as never }).catch(() => [] as MakerTask[]),
        admin.from("brief_drafts").select("id, title, updated_at, clients(name)").eq("profile_id", p.id).order("updated_at", { ascending: false }).limit(10),
      ]);
      return {
        id: p.id,
        name: p.full_name,
        role: p.role,
        tasks,
        overdue: tasks.filter((t) => t.due && t.due < today).length,
        onThem: tasks.filter((t) => t.onThem).length,
        briefs: ((drafts ?? []) as unknown as { id: string; title: string | null; updated_at: string; clients: { name: string } | null }[]).map((d) => ({ id: d.id, title: d.title || "Untitled brief", client: d.clients?.name ?? null, at: d.updated_at })),
      };
    }),
  );
}
