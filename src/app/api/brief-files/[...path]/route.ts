import { requireStaff } from "@/lib/auth";
import { BRIEF_BUCKET } from "@/lib/brief-files";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// GET /api/brief-files/<client id>/<batch>/<file>: a file someone added to a brief (in Talk it through or the revise
// chat), opened from the brief's references, the ticket and the PDF. Staff who can see the client only; it sends them
// on to a short-lived signed link, so the bucket stays private. The files live in src/lib/brief-files.ts.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, ctx: RouteContext<"/api/brief-files/[...path]">) {
  try {
    await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  const { path } = await ctx.params;
  const full = (path ?? []).join("/");
  const clientId = path?.[0] ?? "";
  if (!UUID.test(clientId) || !/^[\w./-]+$/.test(full) || full.includes("..") || !adminConfigured()) return new Response("Not found", { status: 404 });
  // Only a client this person works on (read through their own access)
  const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return new Response("Not found", { status: 404 });
  const { data, error } = await createAdminClient().storage.from(BRIEF_BUCKET).createSignedUrl(full, 3600);
  if (error || !data?.signedUrl) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 302, headers: { location: data.signedUrl, "cache-control": "private, max-age=1800" } });
}
