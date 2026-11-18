import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { requestSocialAudit, runSocialAudit } from "@/lib/social-ops/audit";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// A social audit takes a minute or two; it runs here, after the reply, so it keeps going if the person leaves the page.
export const maxDuration = 800;

/** POST { clientId } to audit a client's organic social accounts. Returns { id } (the audit to open) or { error }. */
export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Server key missing." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { clientId?: string };
  if (!body.clientId) return Response.json({ error: "Which client?" }, { status: 400 });
  const db = await createClient();
  // RLS decides whether this person can see the client at all
  const { data: c } = await db.from("clients").select("id").eq("id", body.clientId).maybeSingle();
  if (!c) return Response.json({ error: "You don't work on this client." }, { status: 403 });
  const admin = createAdminClient();
  const out = await requestSocialAudit(db, admin, body.clientId, me.id);
  if ("error" in out) return Response.json(out, { status: 400 });
  if (out.running) after(() => runSocialAudit(admin, out.id));
  return Response.json({ id: out.id });
}
