import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { ReadyToApprove } from "@/components/ready-to-approve";

/**
 * The drafted briefs on a media buyer's Overview (the clients they hold the Meta seat on): they sit here until someone
 * approves, edits or rejects them. The creative leads have them inside each client's row, the head of Meta and the
 * executives in their Suggested briefs. Nothing shows when nothing waits.
 */
export async function ReadyCallout({ db, me }: { db: SupabaseClient; me: Staff }) {
  // The creative leads see theirs inside each client's row (Overview › Clients)
  if (me.role !== "media_buyer") return null;
  const { loadReady } = await import("@/lib/brief-drafting");
  const groups = await loadReady(db, { limit: 30 }).catch(() => []);
  if (!groups.length) return null;
  return <ReadyToApprove groups={groups} today={new Date().toISOString().slice(0, 10)} compact />;
}
