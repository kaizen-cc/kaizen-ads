import { requireStaff } from "@/lib/auth";
import { auditFeed } from "@/lib/audit-queue";
import { withTimeout } from "@/lib/fail-fast";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A poll: it answers in seconds or not at all, so a struggling database never holds a function for minutes
export const maxDuration = 15;

/** My audits for the notifications: running, queued (in order) and just finished. */
export async function GET() {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ max: 3, running: [], queued: [], finished: [] });
  try {
    return Response.json(await withTimeout(auditFeed(createAdminClient(), me.id), 8000), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "slow" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
