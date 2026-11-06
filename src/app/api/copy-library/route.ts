import { getViewer } from "@/lib/auth";
import { loadCopyLibrary } from "@/lib/copy-library";
import { createClient } from "@/lib/supabase/server";

// GET /api/copy-library?client=<id>: one client's Copy library; no client: every client the person can see (the
// cross-client library on Ideas). ?variations=<line key>&client=<id>: the variations written from that line. Read
// through the person's own session, so only clients they can see. Fetched by the page after it opens (it's a lot of rows).
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "staff") return Response.json({ error: "Not allowed" }, { status: 401 });
  const url = new URL(request.url);
  const client = url.searchParams.get("client");
  if (client && !/^[0-9a-f-]{36}$/i.test(client)) return Response.json({ error: "Bad client" }, { status: 400 });
  const db = await createClient();
  const key = url.searchParams.get("variations");
  if (key && client) {
    const { data } = await db.from("copy_library_variations").select("id, variations, note, created_at, profiles(full_name)").eq("client_id", client).eq("line_key", key).order("created_at", { ascending: false }).limit(10);
    return Response.json({ variations: data ?? [] }, { headers: { "cache-control": "no-store" } });
  }
  const lib = await loadCopyLibrary(db, client ? [client] : null);
  // The cross-client view sends the lines that matter: anything proven, starred, or the newest of the rest
  const lines = client ? lib.lines : lib.lines.filter((l, i) => l.badge !== "unproven" || l.starred || i < 1500).slice(0, 3000);
  return Response.json({ ...lib, lines }, { headers: { "cache-control": "no-store" } });
}
