import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { pdfDisposition } from "@/lib/reports/format";
import { renderReportPdf } from "@/lib/reports/pdf";
import { loadReport } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canReportOn } from "@/lib/reports/access";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/reports/<id>/pdf: one report as a PDF, for the team (the buyer checking it, or sending it by hand).
export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]/pdf">) {
  const me = await requireStaff();
  // Reports are only for executives and media buyers
  if (!canSeeReports(me)) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  // The same rule as the report itself: its account's buyer, the leads of its line, execs
  const db = await createClient();
  const { data: r } = await db.from("reports").select("owner_id, bundle_id, kind, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  const t = r?.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!r || (r.owner_id !== me.id && !(t && (await canReportOn(db, me, t))))) return new Response("Not found", { status: 404 });
  const params = new URL(request.url).searchParams;
  // ?edit=1: the studio's preview, with an invisible link over each metric the buyer can change
  const edit = params.get("edit") === "1";
  // ?download=1: saved under its name (the studio's Download PDF), else opened in the browser
  const inline = params.get("download") !== "1";
  // ?whole=1 on a built report: the whole thing as it goes to the client (every service, one PDF)
  if (params.get("whole") && r.kind === "built" && r.bundle_id) {
    const { builtFileName, builtPdf } = await import("@/lib/reports/builder");
    const admin = createAdminClient();
    const [pdf, name] = await Promise.all([builtPdf(admin, r.bundle_id, edit), builtFileName(admin, r.bundle_id)]);
    return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(name, inline), "cache-control": "private, no-store" } });
  }
  const report = await loadReport(createAdminClient(), id, edit);
  if (!report) return new Response("This report hasn't been written yet", { status: 404 });
  const pdf = await renderReportPdf(report.input);
  return new Response(pdf as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(report.fileName, inline), "cache-control": "private, no-store" },
  });
}
