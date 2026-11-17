import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
// A first look for a client's logo reads their website (up to 20 seconds)
export const maxDuration = 30;

// GET /api/clients/<id>/logo: the client's logo for their card on the Clients page, the same one their reports carry
// (uploaded on the client page, else found in the Brand Bible, on their website or in their Drive, and kept a month).
// The card adds ?v=<when it was last looked for>, so the browser keeps it until it changes. None found: 404, and the
// card shows the client's initial instead.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !adminConfigured()) return new Response("Not found", { status: 404 });
  // Only a client this person can see (the database's own rule)
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", id).maybeSingle();
  if (!client) return new Response("Not found", { status: 404 });
  const { reportBrand } = await import("@/lib/reports/brand-server");
  const brand = await reportBrand(createAdminClient(), id).catch(() => null);
  const m = brand?.logo?.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) return new Response("Not found", { status: 404, headers: { "cache-control": "private, max-age=3600" } });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "content-type": m[1], "cache-control": "private, max-age=604800, immutable" },
  });
}
