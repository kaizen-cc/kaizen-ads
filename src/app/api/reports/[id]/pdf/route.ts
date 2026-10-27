import { requireStaff } from "@/lib/auth";
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
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  // The same rule as the report itself: its account's buyer, the leads of its line, execs
  const db = await createClient();
  const { data: r } = await db.from("reports").select("owner_id, bundle_id, kind, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  const t = r?.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!r || (r.owner_id !== me.id && !(t && (await canReportOn(db, me, t))))) return new Response("Not found", { status: 404 });
  // ?whole=1 on a built report: the whole thing as it goes to the client (every service, one PDF)
  if (new URL(request.url).searchParams.get("whole") && r.kind === "built" && r.bundle_id) {
    const { builtPdf } = await import("@/lib/reports/builder");
    const pdf = await builtPdf(createAdminClient(), r.bundle_id);
    return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition("Report.pdf", true), "cache-control": "private, no-store" } });
  }
  const report = await loadReport(createAdminClient(), id);
  if (!report) return new Response("This report hasn't been written yet", { status: 404 });
  const pdf = await renderReportPdf(report.input);
  return new Response(pdf as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(report.fileName, true), "cache-control": "private, no-store" },
  });
}
