import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaFormat } from "./core";

// Keeps meta_ads current for one account: every live, paused or held ad with its status, its ad set's learning phase
// and its creative (type, picture, headline, copy). Only rows that changed are written (most runs change a handful),
// and ads Meta no longer lists are left as they were (an ad that ended keeps its last state). Read only on Meta.

const clip = (s: string | null | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);

export async function syncAdCatalog(admin: SupabaseClient, clientId: string, adAccountId: string) {
  const account = adAccountId.replace(/^act_/, "");
  const { adCatalog } = await import("@/lib/context/meta");
  const ads = await adCatalog(account);
  if (!ads.length) return { ads: 0, written: 0 };
  const now = new Date().toISOString();
  const rows = ads.map((a) => {
    const c = a.creative ?? {};
    const link = c.object_story_spec?.link_data;
    const video = c.object_story_spec?.video_data;
    const cards = link?.child_attachments?.length ?? 0;
    return {
      ad_id: a.id,
      client_id: clientId,
      ad_account_id: account,
      name: clip(a.name, 300) ?? a.id,
      effective_status: a.effective_status ?? null,
      learning: a.adset?.learning_stage_info?.status ?? null,
      campaign_id: a.campaign?.id ?? null,
      campaign_name: clip(a.campaign?.name, 300),
      adset_id: a.adset?.id ?? null,
      adset_name: clip(a.adset?.name, 300),
      format: metaFormat(c.object_type, cards, Boolean(c.video_id || video || c.asset_feed_spec?.videos?.length)),
      thumbnail_url: c.thumbnail_url ?? c.image_url ?? null,
      headline: clip(c.title ?? link?.name ?? video?.title ?? c.asset_feed_spec?.titles?.[0]?.text, 300),
      body: clip(c.body ?? link?.message ?? video?.message ?? c.asset_feed_spec?.bodies?.[0]?.text, 2000),
      created_time: a.created_time ?? null,
    };
  });
  // IO-light: compare with what's stored and write only what changed (the thumbnail link rotates, so it alone never counts)
  const { data: stored } = await admin.from("meta_ads").select("ad_id, name, effective_status, learning, campaign_name, adset_name, format, headline, body").eq("client_id", clientId).eq("ad_account_id", account).limit(5000);
  const by = new Map((stored ?? []).map((s) => [s.ad_id as string, s]));
  const same = (r: (typeof rows)[number]) => {
    const s = by.get(r.ad_id);
    return Boolean(s) && (["name", "effective_status", "learning", "campaign_name", "adset_name", "format", "headline", "body"] as const).every((k) => (s![k] ?? null) === (r[k] ?? null));
  };
  const changed = rows.filter((r) => !same(r)).map((r) => ({ ...r, seen_at: now, updated_at: now }));
  for (let i = 0; i < changed.length; i += 500) {
    const { error } = await admin.from("meta_ads").upsert(changed.slice(i, i + 500), { onConflict: "ad_id" });
    if (error) throw new Error(`Saving Meta ads: ${error.message}`);
  }
  return { ads: rows.length, written: changed.length };
}
