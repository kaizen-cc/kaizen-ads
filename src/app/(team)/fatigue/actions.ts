"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, type OpenSuggestion } from "@/lib/suggestions";
import { notLive } from "@/lib/live-guard";

/**
 * The refresh already there for one tiring ad (the watcher sketches one on its own), to open. Nothing is written here:
 * a new refresh starts from its quick preview and is written only when someone chooses it (startBrief).
 */
export async function briefRefresh(clientId: string, adId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  await requireStaff();
  const supabase = await createClient();
  // Only for clients this person works on (the watch list's own rules)
  const { data: watched } = await supabase.from("ad_fatigue").select("ad_id").eq("client_id", clientId).eq("ad_id", adId).maybeSingle();
  if (!watched) return { ok: false, error: "That ad isn't on your watch list." };
  const { data: existing } = await supabase.from("creative_suggestions").select("id").eq("kind", "refresh").eq("status", "open").eq("client_id", clientId).eq("source->>adId", adId).limit(1);
  const suggestion = existing?.[0] ? await loadSuggestion(supabase, existing[0].id as string) : null;
  return suggestion ? { ok: true, suggestion } : { ok: false, error: "No refresh for this ad yet. Brief one from its quick preview." };
}

/** Not a problem (a planned rotation, a seasonal dip…): off the list unless it gets worse. */
export async function dismissFatigue(clientId: string, adId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase
    .from("ad_fatigue")
    .update({ state: "dismissed", dismissed_by: me.id, dismiss_reason: reason.trim().slice(0, 300) || null, updated_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("ad_id", adId);
  if (error) return { ok: false, error: error.message };
  // Its refresh brief written ahead isn't needed
  await supabase.from("creative_suggestions").update({ status: "expired" }).eq("kind", "refresh").eq("status", "open").eq("client_id", clientId).eq("source->>adId", adId);
  revalidatePath("/pipeline");
  return { ok: true };
}
