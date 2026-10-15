import { requireStaff } from "@/lib/auth";
import { daysAgoIso } from "@/lib/dates";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { BoardClient } from "./board-client";
import { toTicket, type BoardRow } from "./to-ticket";

// Writing a video script with the AI can take a minute
export const maxDuration = 120;

export default async function Board() {
  await requireStaff();
  const supabase = await createClient();
  const twoWeeksAgo = daysAgoIso(14);

  const [{ data: rows }, { data: clients }, { data: people }] = await Promise.all([
    // Everything still moving, plus what launched in the last two weeks
    supabase.from("board_requests").select("*").or(`stage.neq.launched,launched_at.gte.${twoWeeksAgo}`).order("created_at", { ascending: false }).limit(1000),
    supabase.from("clients").select("id, name, slug").in("status", ["active", "onboarding"]).order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);

  return (
    <BoardClient
      tickets={((rows ?? []) as BoardRow[]).map(toTicket)}
      clients={clients ?? []}
      people={(people ?? []).map((p) => ({ id: p.id, name: p.full_name, role: roleLabel(p.role as TeamRole) }))}
      canRequest
    />
  );
}
