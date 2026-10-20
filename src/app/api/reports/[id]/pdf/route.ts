import { requireStaff } from "@/lib/auth";
import { pdfDisposition } from "@/lib/reports/format";
import { renderReportPdf } from "@/lib/reports/pdf";
import { loadReport } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/reports/<id>/pdf: one report as a PDF, for the team (the buyer checking it, or sending it by hand).
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/[id]/pdf">) {
  await requireStaff();
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const report = await loadReport(createAdminClient(), id);
  if (!report) return new Response("This report hasn't been written yet", { status: 404 });
  const pdf = await renderReportPdf(report.input);
  return new Response(pdf as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(report.fileName, true), "cache-control": "private, no-store" },
  });
}
