import { pdfDisposition } from "@/lib/reports/format";
import { renderReportPdf } from "@/lib/reports/pdf";
import { loadBundle } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /r/<token>/pdf: the client's monthly recap as a PDF, every platform in it. No sign-in: the token is the key,
// and only a sent bundle's finished reports are in it.
export async function GET(_request: Request, ctx: RouteContext<"/r/[token]/pdf">) {
  const { token } = await ctx.params;
  if (!adminConfigured()) return new Response("Not found", { status: 404 });
  const bundle = await loadBundle(createAdminClient(), token);
  if (!bundle || !bundle.ready || !bundle.input.parts.length) return new Response("Not found", { status: 404 });
  const pdf = await renderReportPdf(bundle.input);
  return new Response(pdf as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(bundle.fileName), "cache-control": "private, no-store", "x-robots-tag": "noindex" },
  });
}
