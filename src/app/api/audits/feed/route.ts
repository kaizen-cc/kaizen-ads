import { requireStaff } from "@/lib/auth";
import { auditFeed } from "@/lib/audit-queue";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

/** My audits for the notifications: running, queued (in order) and just finished. */
export async function GET() {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ max: 3, running: [], queued: [], finished: [] });
  return Response.json(await auditFeed(createAdminClient(), me.id), { headers: { "cache-control": "no-store" } });
}
