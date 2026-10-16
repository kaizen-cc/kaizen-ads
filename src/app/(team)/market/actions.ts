"use server";

import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, suggestFromMarket, type OpenSuggestion } from "@/lib/suggestions";
import { notLive } from "@/lib/live-guard";

/**
 * The strategist writes the whole request for the picked client from a live market ad, with the Motion link in its
 * references. Picking the same ad and client again opens the draft already written.
 */
export async function briefFromMarket(adId: string, clientId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
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

export type MarketRead = { observation: string | null; why: string | null; hook: string | null; angle: string | null; takeaways: string[] };

/** The AI's read of a market ad (written ahead after each sync; written now if it isn't there yet). */
export async function marketRead(adId: string): Promise<MarketRead | null> {
  await requireStaff();
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const { data } = await db.from("market_ads").select("observation, why, hook, angle, takeaways, read_at").eq("id", adId).maybeSingle();
  if (data?.why) return { observation: data.observation, why: data.why, hook: data.hook, angle: data.angle, takeaways: data.takeaways ?? [] };
  if (!aiEnabled() || !adminConfigured()) return null;
  try {
    const { analyzeMarketAd } = await import("@/lib/market");
    return await analyzeMarketAd(createAdminClient(), adId);
  } catch (e) {
    console.error("[market] read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** The market for one client: their matched brands' live ads (worked out now if they haven't been yet). */
export async function clientMarket(clientId: string): Promise<import("@/lib/market").MarketAd[]> {
  await requireStaff();
  const { loadClientMarket } = await import("@/lib/market");
  const db = adminConfigured() ? createAdminClient() : await createClient();
  return loadClientMarket(db, clientId, { limit: 400, compute: adminConfigured() && aiEnabled() ? createAdminClient() : undefined });
}
