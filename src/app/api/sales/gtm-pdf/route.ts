import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// GET /api/sales/gtm-pdf?brief=<sales call brief id>: the go-to-market strategy PDF for that call, downloaded from the
// "Sales call brief" item. For the person running the call (and the executives); a short-lived signed link each time.

export async function GET(request: Request) {
  let me;
  try {
    me = await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  const brief = new URL(request.url).searchParams.get("brief") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(brief) || !adminConfigured()) return new Response("Not found", { status: 404 });
  const admin = createAdminClient();
  const { data: b } = await admin.from("sales_call_briefs").select("owner_id, prospect_id").eq("id", brief).maybeSingle();
  if (!b?.prospect_id || (b.owner_id !== me.id && !me.isExec)) return new Response("Not found", { status: 404 });
  const { data: g } = await admin.from("prospect_gtms").select("document_id").eq("prospect_id", b.prospect_id).eq("status", "done").not("document_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!g?.document_id) return new Response("The strategy isn't ready yet.", { status: 404 });
  const { data: d } = await admin.from("kaizen_documents").select("bucket, path, file_name").eq("id", g.document_id).maybeSingle();
  if (!d?.path) return new Response("Not found", { status: 404 });
  const { data: link } = await admin.storage.from(d.bucket as string).createSignedUrl(d.path as string, 300, { download: (d.file_name as string) || true });
  return link?.signedUrl ? Response.redirect(link.signedUrl, 302) : new Response("The PDF couldn't be opened. Try again.", { status: 502 });
}
