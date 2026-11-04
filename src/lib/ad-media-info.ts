import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// What a preview needs beyond the picture: whether the ad is a video (so it can be played) and where it sends people
// (so the ad opens its own page). Read from Meta once and kept a week; a video's file link expires, so it's asked for
// fresh each time someone presses play.

const KEEP_DAYS = 7;

type Creative = {
  video_id?: string;
  link_url?: string;
  effective_instagram_media_id?: string;
  object_story_spec?: { link_data?: { link?: string; child_attachments?: { link?: string }[] }; video_data?: { video_id?: string; call_to_action?: { value?: { link?: string } } } };
  asset_feed_spec?: { videos?: { video_id?: string }[]; link_urls?: { website_url?: string }[] };
};

export async function adInfo(admin: SupabaseClient, adId: string): Promise<{ video: boolean; link: string | null }> {
  const { data: kept } = await admin.from("ad_media").select("video_id, link, info_at").eq("ad_id", adId).maybeSingle();
  if (kept?.info_at && Date.now() - Date.parse(kept.info_at as string) < KEEP_DAYS * 86_400_000) return { video: Boolean(kept.video_id), link: (kept.link as string | null) ?? null };
  const { metaGraph } = await import("@/lib/context/meta");
  const ad = await metaGraph<{ creative?: Creative }>(adId, { fields: "creative{video_id,link_url,effective_instagram_media_id,object_story_spec{link_data{link,child_attachments{link}},video_data{video_id,call_to_action}},asset_feed_spec{videos{video_id},link_urls{website_url}}}" }).catch(() => null);
  const c = ad?.creative;
  let video = c?.video_id ?? c?.object_story_spec?.video_data?.video_id ?? c?.asset_feed_spec?.videos?.[0]?.video_id ?? null;
  if (!video && c?.effective_instagram_media_id) {
    const m = await metaGraph<{ media_type?: string }>(c.effective_instagram_media_id, { fields: "media_type" }).catch(() => null);
    if (m?.media_type === "VIDEO" || m?.media_type === "REELS") video = `ig:${c.effective_instagram_media_id}`;
  }
  const link = c?.object_story_spec?.link_data?.link ?? c?.object_story_spec?.video_data?.call_to_action?.value?.link ?? c?.asset_feed_spec?.link_urls?.[0]?.website_url ?? c?.object_story_spec?.link_data?.child_attachments?.[0]?.link ?? c?.link_url ?? null;
  const clean = link && /^https?:\/\//.test(link) ? link : null;
  if (ad) await admin.from("ad_media").upsert({ ad_id: adId, video_id: video, link: clean, info_at: new Date().toISOString() }, { onConflict: "ad_id" });
  return { video: Boolean(video), link: clean };
}

/** A fresh link to the ad's video file, or null when it isn't a video */
export async function adVideoSource(admin: SupabaseClient, adId: string): Promise<string | null> {
  await adInfo(admin, adId);
  const { data } = await admin.from("ad_media").select("video_id").eq("ad_id", adId).maybeSingle();
  const id = data?.video_id as string | null;
  if (!id) return null;
  const { metaGraph } = await import("@/lib/context/meta");
  if (id.startsWith("ig:")) {
    const m = await metaGraph<{ media_url?: string }>(id.slice(3), { fields: "media_url" }).catch(() => null);
    return m?.media_url ?? null;
  }
  const v = await metaGraph<{ source?: string }>(id, { fields: "source" }).catch(() => null);
  return v?.source ?? null;
}
