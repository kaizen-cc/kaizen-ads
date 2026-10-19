import { isExecOrLead, requireStaff } from "@/lib/auth";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadShadows } from "@/lib/asana";
import { BoardClient } from "./board-client";
import { toTicket, type BoardRow } from "./to-ticket";

// Writing a video script with the AI can take a minute
export const maxDuration = 300; // room for the AI creative review that starts when a ticket reaches review

export default async function Board({ searchParams }: PageProps<"/board">) {
  const me = await requireStaff();
  const supabase = await createClient();
  const { t } = await searchParams;
  const asked = typeof t === "string" && /^\d+$/.test(t) ? Number(t) : null;

  const [{ data: moving }, { data: one }, { data: clients }, { data: people }] = await Promise.all([
    // Everything still moving (launched work lives on each client's page)
    supabase.from("board_requests").select("*").neq("stage", "launched").order("created_at", { ascending: false }).limit(1000),
    // A ticket opened by its number, from anywhere (a launched one from the client page too)
    asked ? supabase.from("board_requests").select("*").eq("number", asked).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("clients").select("id, name, slug").in("status", ["active", "onboarding"]).order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);

  // Open Asana tasks not migrated yet: outline cards in their column while the team moves over
  const shadows = await loadShadows(supabase).catch(() => []);
  const rows = [...(moving ?? []), ...(one && !(moving ?? []).some((r) => r.id === one.id) ? [one] : [])];
  return (
    <BoardClient
      tickets={(rows as BoardRow[]).map(toTicket)}
      clients={clients ?? []}
      people={(people ?? []).map((p) => ({ id: p.id, name: p.full_name, role: roleLabel(p.role as TeamRole) }))}
      canRequest
      can={{ review: isExecOrLead(me), approveCopy: isExecOrLead(me) || me.isCopywriter }}
      shadows={shadows}
      me={{ id: me.id, lead: isExecOrLead(me) }}
    />
  );
}
