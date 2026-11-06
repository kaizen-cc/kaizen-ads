import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { canReportOn } from "@/lib/reports/access";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/reports/<id>/deck: the monthly recap filled into our PowerPoint template, downloaded as a .pptx (Drive's
// export of the Google Slides copy). The same rule as the report itself: its buyer, the leads of its line, execs.
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/[id]/deck">) {
  const me = await requireStaff();
  // Reports are only for executives and media buyers
  if (!canSeeReports(me)) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const { data: r } = await db.from("reports").select("owner_id, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  const t = r?.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!r || (r.owner_id !== me.id && !(t && (await canReportOn(db, me, t))))) return new Response("Not found", { status: 404 });
  const { data: deck } = await createAdminClient().from("recap_decks").select("presentation_id, clients(name)").eq("report_id", id).maybeSingle();
  if (!deck?.presentation_id) return new Response("Fill the template first", { status: 404 });
  try {
    const { deckPptx } = await import("@/lib/ai-tools/recap-deck");
    const file = await deckPptx(deck.presentation_id as string);
    const c = (Array.isArray(deck.clients) ? deck.clients[0] : deck.clients) as { name?: string } | null;
    const name = `${(c?.name ?? "Client").replace(/[^\w .-]/g, "")} - Monthly recap.pptx`;
    return new Response(file.body, { headers: { "content-type": file.type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
  } catch (e) {
    return new Response(`Couldn't export it from Google: ${e instanceof Error ? e.message : "error"}`, { status: 502 });
  }
}
