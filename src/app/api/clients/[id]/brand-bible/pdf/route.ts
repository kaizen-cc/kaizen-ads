import { requireStaff } from "@/lib/auth";
import { renderBiblePdf } from "@/lib/brand-bible-pdf";
import { pdfDisposition } from "@/lib/reports/format";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/clients/<id>/brand-bible/pdf: the client's Brand Bible as a PDF, for anyone on the team who works on them
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const [{ data: client }, { data: b }] = await Promise.all([
    db.from("clients").select("name").eq("id", id).maybeSingle(),
    db.from("client_brand_bibles").select("status, version, markdown, read_this_first, generated_at").eq("client_id", id).maybeSingle(),
  ]);
  if (!client || !b?.markdown) return new Response("Not found", { status: 404 });
  const pdf = await renderBiblePdf({ client: client.name, version: b.version, status: b.status, generatedAt: b.generated_at, markdown: b.markdown, readThisFirst: b.read_this_first ?? "" });
  return new Response(pdf as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(`${client.name} Brand Bible ${b.version}.pdf`), "cache-control": "private, no-store" },
  });
}
