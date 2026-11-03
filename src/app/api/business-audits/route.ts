import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { runBusinessAudit } from "@/lib/business-audit";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The full business audit takes a minute or two: it runs here, after the reply, so it keeps going if the person leaves.
export const maxDuration = 800;

/** POST { clientId } starts one; GET ?id= reads where it is. */
export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Server key missing." }, { status: 500 });
  const { clientId } = (await request.json().catch(() => ({}))) as { clientId?: string };
  if (!clientId) return Response.json({ error: "Which client?" }, { status: 400 });
  // Only a client this person can see
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return Response.json({ error: "Client not found." }, { status: 404 });
  const admin = createAdminClient();
  const { data: running } = await admin.from("business_audits").select("id").eq("client_id", clientId).eq("status", "running").gte("created_at", new Date(Date.now() - 20 * 60_000).toISOString()).limit(1).maybeSingle();
  if (running) return Response.json({ id: running.id });
  const { data: row, error } = await admin.from("business_audits").insert({ client_id: clientId, created_by: me.id, step: "Starting" }).select("id").single();
  if (error || !row) return Response.json({ error: error?.message ?? "Couldn't start it." }, { status: 500 });
  after(() => runBusinessAudit(admin, row.id as string));
  return Response.json({ id: row.id });
}

export async function GET(request: Request) {
  await requireStaff();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Which audit?" }, { status: 400 });
  const { data } = await (await createClient()).from("business_audits").select("id, status, step, error").eq("id", id).maybeSingle();
  if (!data) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json(data);
}
