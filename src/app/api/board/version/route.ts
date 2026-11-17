import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// GET /api/board/version: a fingerprint of the tickets this person can see (the latest move or change, and how many
// there are). The board asks every few seconds while it's on screen and refreshes only when it changed: a client's
// approval, an upload, a finished AI review or copy, a launch show up on their own, without a reload.
// ?board=email: the same for the Email Board's tickets (its KPI tabs refresh the same way).
export async function GET(req: Request) {
  try {
    await requireStaff();
    const db = await createClient();
    if (new URL(req.url).searchParams.get("board") === "email") {
      const [{ data: moved, count }, { data: event }] = await Promise.all([
        db.from("email_tickets").select("updated_at", { count: "exact" }).is("deleted_at", null).order("updated_at", { ascending: false }).limit(1),
        db.from("email_ticket_events").select("created_at").order("created_at", { ascending: false }).limit(1),
      ]);
      const v = `${moved?.[0]?.updated_at ?? ""}|${count ?? 0}|${event?.[0]?.created_at ?? ""}`;
      return Response.json({ v }, { headers: { "cache-control": "private, no-store" } });
    }
    const [{ data: moved, count }, { data: event }] = await Promise.all([
      db.from("requests").select("stage_entered_at", { count: "exact" }).order("stage_entered_at", { ascending: false }).limit(1),
      db.from("request_events").select("created_at").order("created_at", { ascending: false }).limit(1),
    ]);
    const v = `${moved?.[0]?.stage_entered_at ?? ""}|${count ?? 0}|${event?.[0]?.created_at ?? ""}`;
    return Response.json({ v }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
}
