import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { ReadyToApprove } from "@/components/ready-to-approve";

/**
 * The drafted briefs on the Overview of the approvers who aren't leaders (the lead graphic designer, the lead video
 * editor, a client's Meta buyer): they sit here until someone approves, edits or rejects them. The leaders and the
 * executives see them in their Suggested briefs. Nothing shows when nothing waits.
 */
export async function ReadyCallout({ db, me }: { db: SupabaseClient; me: Staff }) {
  if (!(me.role === "lead_graphic_designer" || me.role === "lead_video_editor" || me.role === "media_buyer")) return null;
  const { loadReady } = await import("@/lib/brief-drafting");
  const groups = await loadReady(db, { limit: 30 }).catch(() => []);
  if (!groups.length) return null;
  return <ReadyToApprove groups={groups} today={new Date().toISOString().slice(0, 10)} compact />;
}
