import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/clients/<id>/export: the client's latest account package (Brand Bible, change log, where we left off,
// everything they ran) as a Markdown file, for anyone on the team who works on them
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const [{ data: client }, { data: last }] = await Promise.all([
    db.from("clients").select("name").eq("id", id).maybeSingle(),
    db.from("client_exports").select("markdown, created_at").eq("client_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!client || !last) return new Response("Not found", { status: 404 });
  const name = `${client.name} account package ${String(last.created_at).slice(0, 10)}.md`.replace(/[^\w .()-]+/g, "");
  return new Response(last.markdown as string, {
    headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" },
  });
}
