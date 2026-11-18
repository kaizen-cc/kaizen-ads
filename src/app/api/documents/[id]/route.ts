import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// GET /api/documents/<id>: a Kaizen document (create_document) opened in the browser, or saved with ?download=1.
// Read through the person's own session first (their documents, and their clients' ones), then a fresh short-lived
// signed link to the private file, so the card's buttons keep working long after the chat.

export async function GET(request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  try {
    await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !adminConfigured()) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const { data: d } = await db.from("kaizen_documents").select("bucket, path, file_name").eq("id", id).maybeSingle();
  if (!d?.path) return new Response("Not found", { status: 404 });
  const { signedDocumentUrl } = await import("@/lib/documents/server");
  const url = await signedDocumentUrl(createAdminClient(), { bucket: d.bucket as string, path: d.path as string, file_name: (d.file_name as string | null) ?? null }, new URL(request.url).searchParams.has("download"));
  if (!url) return new Response("The file couldn't be opened. Try again.", { status: 502 });
  return Response.redirect(url, 302);
}
