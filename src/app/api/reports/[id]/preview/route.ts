import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { canReportOn } from "@/lib/reports/access";
import { reportImages } from "@/lib/reports/pdf";
import { loadReport } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/reports/<id>/preview: what the studio needs to draw the report's PDF in the browser (the document's input,
// with the click targets, and the top ads' pictures), read once; every edit after that is drawn there, at once.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireStaff();
  // Reports are only for executives and media buyers
  if (!canSeeReports(me)) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const { data: r } = await db.from("reports").select("owner_id, bundle_id, kind, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  const t = r?.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!r || (r.owner_id !== me.id && !(t && (await canReportOn(db, me, t))))) return new Response("Not found", { status: 404 });
  const admin = createAdminClient();
  let input;
  if (new URL(request.url).searchParams.get("whole") && r.kind === "built" && r.bundle_id) input = await (await import("@/lib/reports/builder")).builtInput(admin, r.bundle_id, true);
  else input = (await loadReport(admin, id, true))?.input;
  if (!input) return new Response("This report hasn't been written yet", { status: 404 });
  return Response.json({ input, images: await reportImages(input) }, { headers: { "cache-control": "private, no-store" } });
}
