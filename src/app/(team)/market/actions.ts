"use server";

import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, suggestFromMarket, type OpenSuggestion } from "@/lib/suggestions";

/**
 * The strategist writes the whole request for the picked client from a live market ad, with the Motion link in its
 * references. Picking the same ad and client again opens the draft already written.
 */
export async function briefFromMarket(adId: string, clientId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("creative_suggestions")
    .select("id")
    .eq("kind", "market")
    .eq("status", "open")
    .eq("client_id", clientId)
    .eq("created_by", me.id)
    .eq("source->>marketAdId", adId)
    .limit(1);
  try {
    const id = existing?.[0]?.id ?? (await suggestFromMarket(createAdminClient(), clientId, adId, me.id));
    const suggestion = await loadSuggestion(supabase, id);
    return suggestion ? { ok: true, suggestion } : { ok: false, error: "Couldn't open the brief." };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't write it. Try again." };
  }
}
