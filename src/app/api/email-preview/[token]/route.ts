import { PREVIEW_CSP, previewHtml } from "@/lib/email-design/core";
import { loadDesignHtml } from "@/lib/email-design/store";
import { previewSecret, readPreviewToken } from "@/lib/email-design/token";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// GET /api/email-preview/<token>: one version of a Kaizen AI email design for a week, without signing in, so Figma's
// html.to.design plugin can import it by its address. The signed token is the permission (one design, one version);
// it's served under the same sandbox as the in-app preview and never indexed. Public in src/proxy.ts.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = readPreviewToken(previewSecret(), token);
  if (!t || !adminConfigured()) return new Response("This preview link has expired. Make a new one in Kaizen AI.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const html = await loadDesignHtml(createAdminClient(), t.id, t.version);
  if (!html) return new Response("Not found", { status: 404 });
  // Framed by anything (Figma's plugin loads it), but still no scripts, forms or anything but pictures and fonts
  const csp = PREVIEW_CSP.replace("frame-ancestors 'self'; ", "");
  return new Response(previewHtml(html), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "cache-control": "private, max-age=300", "referrer-policy": "no-referrer" } });
}
