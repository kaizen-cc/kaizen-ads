"use server";

import { revalidatePath } from "next/cache";
import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, suggestRefresh, type OpenSuggestion } from "@/lib/suggestions";

/** The strategist writes a refresh for one tiring ad. Asking again for the same ad opens the draft already written. */
export async function briefRefresh(clientId: string, adId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  // Only for clients this person works on (the watch list's own rules)
  const { data: watched } = await supabase.from("ad_fatigue").select("ad_id").eq("client_id", clientId).eq("ad_id", adId).maybeSingle();
  if (!watched) return { ok: false, error: "That ad isn't on your watch list." };
  const { data: existing } = await supabase
    .from("creative_suggestions")
    .select("id")
    .eq("kind", "refresh")
    .eq("status", "open")
    .eq("client_id", clientId)
    .eq("source->>adId", adId)
    .limit(1);
  try {
    const id = existing?.[0]?.id ?? (await suggestRefresh(createAdminClient(), clientId, adId, me.id));
    const suggestion = await loadSuggestion(supabase, id);
    return suggestion ? { ok: true, suggestion } : { ok: false, error: "Couldn't open the brief." };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't write it. Try again." };
  }
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
