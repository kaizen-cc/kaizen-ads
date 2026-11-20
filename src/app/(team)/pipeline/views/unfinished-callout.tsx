import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { can } from "@/lib/chat-permissions";
import { UnfinishedBriefs } from "@/components/unfinished-briefs";

/** On everyone's Today who briefs: the briefs they started and didn't send, waiting (src/lib/brief-drafts.ts) */
export async function UnfinishedCallout({ db, me }: { db: SupabaseClient; me: Staff }) {
  if (!can(me, "brief").ok) return null;
  const { listBriefDrafts } = await import("@/lib/brief-drafts");
  const drafts = await listBriefDrafts(db, me.id, 6).catch(() => []);
  if (!drafts.length) return null;
  return <UnfinishedBriefs compact drafts={drafts.map((d) => ({ id: d.id, client: d.client, title: d.title, updatedAt: d.updatedAt }))} />;
}
