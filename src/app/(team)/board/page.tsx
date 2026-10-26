import { isExecOrLead, requireStaff } from "@/lib/auth";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadShadows } from "@/lib/asana";
import { BoardClient } from "./board-client";
import { toTicket, type BoardRow } from "./to-ticket";

// Writing a video script with the AI can take a minute
export const maxDuration = 800; // room for the AI creative review that starts at review, and for planning a launch (video uploads to Meta)

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
  // Tickets migrated from Asana past production: do they have their creative and copy yet?
  const { data: migrated } = await supabase.from("asana_tasks").select("request_id, url").not("request_id", "is", null);
  const migratedIds = (migrated ?? []).map((m) => m.request_id as string);
  const [{ data: withDesigns }, { data: withCopy }] = migratedIds.length
    ? await Promise.all([supabase.from("designs").select("request_id").in("request_id", migratedIds), supabase.from("copy_sets").select("request_id, status").in("request_id", migratedIds)])
    : [{ data: [] }, { data: [] }];
  const PAST_PRODUCTION = ["internal_review", "copy", "copy_review", "ready_for_client", "client_review", "client_revision", "ready_for_launch"];
  const PAST_COPY = ["copy_review", "ready_for_client", "client_review", "ready_for_launch"];
  const migrationOf = (id: string, stage: string) => {
    const m = (migrated ?? []).find((x) => x.request_id === id);
    if (!m) return null;
    const needsCreative = PAST_PRODUCTION.includes(stage) && !(withDesigns ?? []).some((d) => d.request_id === id);
    const needsCopy = PAST_COPY.includes(stage) && !(withCopy ?? []).some((c) => c.request_id === id);
    return needsCreative || needsCopy ? { url: m.url as string | null, needsCreative, needsCopy } : null;
  };
  const rows = [...(moving ?? []), ...(one && !(moving ?? []).some((r) => r.id === one.id) ? [one] : [])];
  return (
    <BoardClient
      tickets={(rows as BoardRow[]).map((r) => ({ ...toTicket(r), migration: migrationOf(r.id, r.stage) }))}
      clients={clients ?? []}
      people={(people ?? []).map((p) => ({ id: p.id, name: p.full_name, role: roleLabel(p.role as TeamRole) }))}
      canRequest
      can={{ review: isExecOrLead(me), approveCopy: isExecOrLead(me) || me.isCopywriter, exec: me.isExec }}
      shadows={shadows}
      me={{ id: me.id, lead: isExecOrLead(me) }}
    />
  );
}
