import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { runAudit } from "@/lib/audit";
import { requestAudit } from "@/lib/audit-queue";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// An audit takes a few minutes; it runs here, after the reply, so it can be started from any page (the KPI board,
// the audit page, or a notification) and keep going if the person leaves.
export const maxDuration = 800;

/** POST { targetId } to audit a KPI's account, or { auditId } to start a queued one. */
export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Server key missing." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { targetId?: string; auditId?: string };
  if (!body.targetId && !body.auditId) return Response.json({ error: "Which account?" }, { status: 400 });
  const admin = createAdminClient();
  const out = await requestAudit(await createClient(), admin, me, body);
  if ("started" in out && out.started && "id" in out) after(() => runAudit(admin, out.id));
  return Response.json(out);
}
