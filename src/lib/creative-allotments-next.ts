import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreativeRole } from "@/lib/roles";
import type { NextItem } from "@/lib/next-for-me";
import { loadAllotmentDesk } from "@/lib/creative-allotments-load";
import { allotmentNext } from "@/lib/creative-allotments-items";

/**
 * The creative team's allotment gaps and accounts needing fresh creative, as Next for me items: Now when the reset is
 * close and the gap is real, Keep an eye on when some is due this week to stay on pace. They clear by themselves when
 * briefs are sent or creatives delivered (the gap is recounted on every load).
 */
export async function allotmentNextItems(db: SupabaseClient, me: { id: string; role: string; isExec?: boolean }): Promise<{ bucket: "now" | "watch"; item: NextItem }[]> {
  if (!isCreativeRole(me.role)) return [];
  return allotmentNext(await loadAllotmentDesk(db, me));
}
