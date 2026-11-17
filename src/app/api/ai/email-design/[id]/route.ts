import { requireStaff } from "@/lib/auth";
import { designFileName, PREVIEW_CSP, previewHtml } from "@/lib/email-design/core";
import { loadDesign, loadDesignHtml, mayOpenDesign } from "@/lib/email-design/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/ai/email-design/<id>?v=<version>: one version of a Kaizen AI email design, for its maker, an exec or anyone
// who can see its client. As a preview (the card's frames; &dark=1 shows it in dark mode) it's served under a strict
// sandbox: no scripts, no forms, only pictures and fonts load. &as=html gives the production HTML as text (Copy HTML),
// &as=file downloads it as an .html file.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await requireStaff();
  const { id } = await params;
  if (!adminConfigured()) return new Response("Not found", { status: 404 });
  const admin = createAdminClient();
  const meta = await loadDesign(admin, id);
  if (!meta || !(await mayOpenDesign(me, meta, await createClient(), admin))) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const n = Number(url.searchParams.get("v")) || meta.versions.at(-1)!.n;
  const html = await loadDesignHtml(admin, meta.id, n);
  if (!html) return new Response("Not found", { status: 404 });
  const as = url.searchParams.get("as");
  const base = { "content-security-policy": PREVIEW_CSP, "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "referrer-policy": "no-referrer" };
  if (as === "html") return new Response(html, { headers: { ...base, "content-type": "text/plain; charset=utf-8" } });
  if (as === "file") return new Response(html, { headers: { ...base, "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${designFileName(meta.clientName, meta.title, n)}"` } });
  return new Response(previewHtml(html, { dark: url.searchParams.get("dark") === "1" }), { headers: { ...base, "content-type": "text/html; charset=utf-8", "x-frame-options": "SAMEORIGIN" } });
}
