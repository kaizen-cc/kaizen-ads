"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { asRange, type AdPlatform } from "@/lib/ad-library/core";
import type { AdList, AdSheet } from "@/lib/ad-library/load";

// The client page's Ads tab: every ad in the client's accounts for a window, and one ad's sheet. Read with the person's
// own session (RLS: the clients they can see, and paid-ads numbers only for those who see them); Google is read live
// once the client is confirmed visible to them.

type Out<T> = { ok: true; data: T } | { ok: false; error: string };
const PLATFORMS: AdPlatform[] = ["meta", "google", "tiktok"];

async function gate(clientId: string, platform: string) {
  const me = await requireStaff();
  if (!seesAccountNumbers(me)) return { error: "Account numbers aren't part of your view." } as const;
  if (!PLATFORMS.includes(platform as AdPlatform)) return { error: "Unknown platform." } as const;
  const db = await createClient();
  const { data } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!data) return { error: "That client isn't one you can see." } as const;
  return { db, platform: platform as AdPlatform } as const;
}

export async function listClientAds(clientId: string, platform: string, days: number): Promise<Out<AdList>> {
  const g = await gate(clientId, platform);
  if ("error" in g) return { ok: false, error: g.error! };
  try {
    const { loadAds } = await import("@/lib/ad-library/load");
    return { ok: true, data: await loadAds(g.db, clientId, g.platform, asRange(days)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The ads couldn't be read." };
  }
}

export async function clientAdSheet(clientId: string, platform: string, adId: string): Promise<Out<AdSheet>> {
  const g = await gate(clientId, platform);
  if ("error" in g) return { ok: false, error: g.error! };
  if (!/^[\w-]{3,40}$/.test(adId)) return { ok: false, error: "Unknown ad." };
  try {
    const { loadAdSheet } = await import("@/lib/ad-library/load");
    return { ok: true, data: await loadAdSheet(g.db, clientId, g.platform, adId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The ad couldn't be read." };
  }
}
