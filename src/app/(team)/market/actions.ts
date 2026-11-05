"use server";

import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Briefing a client on a market ad starts from its quick preview (src/components/quick-brief-sheet.tsx): the full
// brief is written in the background only when someone chooses it (startBrief in src/app/(team)/brief-job-actions.ts).

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
  const me = await requireStaff();
  const { loadClientMarket } = await import("@/lib/market");
  const { formatsFor, marketFormatOf } = await import("@/lib/creative-formats");
  const allowed = formatsFor(me);
  const db = adminConfigured() ? createAdminClient() : await createClient();
  // Only the formats this person works in (a designer never sees video examples)
  return (await loadClientMarket(db, clientId, { limit: 400, compute: adminConfigured() && aiEnabled() ? createAdminClient() : undefined })).filter((a) => allowed.has(marketFormatOf(a)));
}
