import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adInfo } from "@/lib/ad-media-info";

// Each video ad's length in seconds, read from Meta once and kept in ad_media (so average watch time can be shown as a
// share of the video). Only the ads asked for, a few new ones from Meta per call; the rest fill in on the next call.

const RETRY_DAYS = 7;

/**
 * ad id → video length in seconds, for the ads that are videos and whose length Meta gives. admin: the service-role
 * client (ad_media is server only). fetch: at most this many ads are read from Meta now.
 */
export async function videoLengths(admin: SupabaseClient, adIds: string[], fetch = 12): Promise<Map<string, number>> {
  const ids = [...new Set(adIds.filter(Boolean))];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await admin.from("ad_media").select("ad_id, video_id, info_at, video_seconds, video_seconds_at").in("ad_id", ids);
  const kept = new Map((data ?? []).map((r) => [r.ad_id as string, r]));
  const todo: string[] = [];
  for (const id of ids) {
    const r = kept.get(id);
    if (r?.video_seconds != null) out.set(id, Number(r.video_seconds));
    // Not looked at yet, or tried a while ago with nothing back
    else if (!r?.video_seconds_at || Date.now() - Date.parse(r.video_seconds_at as string) > RETRY_DAYS * 86_400_000) todo.push(id);
  }
  if (!todo.length) return out;
  const { metaConfigured, metaGraph } = await import("@/lib/context/meta");
  if (!metaConfigured()) return out;
  await Promise.all(
    todo.slice(0, fetch).map(async (id) => {
      // Whether it's a video, and which (read once a week by the preview too)
      const info = await adInfo(admin, id).catch(() => null);
      let seconds: number | null = null;
      if (info?.video) {
        const { data: m } = await admin.from("ad_media").select("video_id").eq("ad_id", id).maybeSingle();
        const vid = (m?.video_id as string | null) ?? null;
        // Instagram media don't give a length through the API; Page videos do
        if (vid && !vid.startsWith("ig:")) {
          const v = await metaGraph<{ length?: number }>(vid, { fields: "length" }).catch(() => null);
          if (v?.length && v.length > 0) seconds = Math.round(v.length * 10) / 10;
        }
      }
      await admin.from("ad_media").upsert({ ad_id: id, video_seconds: seconds, video_seconds_at: new Date().toISOString() }, { onConflict: "ad_id" });
      if (seconds != null) out.set(id, seconds);
    }),
  );
  return out;
}
