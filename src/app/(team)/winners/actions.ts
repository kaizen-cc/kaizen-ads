"use server";

import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adDetail, metaConfigured, type AdDetail } from "@/lib/context/meta";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, suggestFromWinner, type OpenSuggestion, type WinnerSource } from "@/lib/suggestions";
import { notLive } from "@/lib/live-guard";

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

/**
 * The strategist writes the whole request for the picked client from the winning ad. Picking the same ad and client
 * again opens the draft already written.
 */
export async function briefFromWinner(w: WinnerSource, clientId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("creative_suggestions")
    .select("id")
    .eq("kind", "winner")
    .eq("status", "open")
    .eq("client_id", clientId)
    .eq("created_by", me.id)
    .eq("source->>adId", w.adId)
    .limit(1);
  try {
    const id = existing?.[0]?.id ?? (await suggestFromWinner(createAdminClient(), clientId, w, me.id));
    const suggestion = await loadSuggestion(supabase, id);
    return suggestion ? { ok: true, suggestion } : { ok: false, error: "Couldn't open the brief." };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't write it. Try again." };
  }
}
