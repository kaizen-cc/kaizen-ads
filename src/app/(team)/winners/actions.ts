"use server";

import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adDetail, metaConfigured, type AdDetail } from "@/lib/context/meta";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** The ad in full from Meta: all its copy, the full image or the playable video, and Meta's own preview. */
export async function winnerAd(adId: string): Promise<AdDetail | null> {
  await requireStaff();
  if (!metaConfigured() || !/^\d+$/.test(adId)) return null;
  try {
    return await adDetail(adId);
  } catch (e) {
    console.error("[winners] couldn't read the ad:", e instanceof Error ? e.message : e);
    return null;
  }
}

// Briefing a client on a winner starts from its quick preview (src/components/quick-brief-sheet.tsx): the full brief
// is written in the background only when someone chooses it (startBrief in src/app/(team)/brief-job-actions.ts).

/** The AI's read of a winning ad (written ahead after each Meta sync; written now if it isn't there yet). */
export async function winnerInsight(w: import("@/lib/industry").Winner, extra: { text?: string | null; headline?: string | null; image?: string | null; cta?: string | null } = {}): Promise<import("@/lib/winner-insight").WinnerInsight | null> {
  await requireStaff();
  const { toInsight, analyzeWinner } = await import("@/lib/winner-insight");
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const { data } = await db.from("winner_insights").select("observation, creative, hook, angle, takeaways, generated_at").eq("ad_id", w.id).maybeSingle();
  if (data) return toInsight(data);
  if (!aiEnabled() || !adminConfigured()) return null;
  try {
    return await analyzeWinner(createAdminClient(), w, extra);
  } catch (e) {
    console.error("[winners] insight failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
