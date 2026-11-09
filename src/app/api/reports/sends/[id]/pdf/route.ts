import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { canReportOn } from "@/lib/reports/access";
import { pdfDisposition } from "@/lib/reports/format";
import { sendPdf } from "@/lib/reports/send";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/reports/sends/<id>/pdf: the PDF exactly as it went to the client in that send (the frozen copy; for sends
// from before copies were kept, the sent report drawn again, which can't have changed). Same rule as the report itself.
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/sends/[id]/pdf">) {
  const me = await requireStaff();
  if (!canSeeReports(me)) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const admin = createAdminClient();
  const { data: s } = await admin.from("report_sends").select("id, report_id, bundle_id, kind, pdf_path, file_name").eq("id", id).maybeSingle();
  if (!s) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const q = admin.from("reports").select("owner_id, kpi_targets(id, client_id, platform, owner_id)");
  const { data: rows } = s.report_id ? await q.eq("id", s.report_id) : s.bundle_id ? await q.eq("bundle_id", s.bundle_id) : { data: [] };
  let allowed = false;
  for (const r of rows ?? []) {
    const t = r.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
    if (r.owner_id === me.id || (t && (await canReportOn(db, me, t)))) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return new Response("Not found", { status: 404 });
  const pdf = await sendPdf(admin, s as { pdf_path: string | null; report_id: string | null; bundle_id: string | null; kind: string });
  if (!pdf) return new Response("The PDF for this send couldn't be found", { status: 404 });
  return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition((s.file_name as string | null) ?? "Report.pdf", true), "cache-control": "private, no-store" } });
}
