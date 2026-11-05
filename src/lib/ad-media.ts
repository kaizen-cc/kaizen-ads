import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// A Meta ad's picture, kept. Meta's image links (fbcdn) expire after a few days, so the links saved with the ad stop
// loading; this asks Meta for the ad's current creative (its image, a video's poster, the post's picture), keeps a copy
// in storage, and reads that from then on (refreshed after 30 days). Shared by /api/ad-media/<adId> and anything on the
// server that needs the picture itself (the brief PDF).

const KEEP_DAYS = 30;
const BUCKET = "ad-media";

export type AdMedia = { bytes: Uint8Array; mime: string };

/** The ad's picture, or null when nothing can be read (tried again after a day) */
export async function readAdMedia(admin: SupabaseClient, adId: string): Promise<AdMedia | null> {
  if (!/^\d{5,25}$/.test(adId)) return null;

  const serve = async (path: string, mime: string | null): Promise<AdMedia | null> => {
    const { data } = await admin.storage.from(BUCKET).download(path);
    if (!data) return null;
    return { bytes: new Uint8Array(await data.arrayBuffer()), mime: mime ?? data.type ?? "image/jpeg" };
  };

  const { data: kept } = await admin.from("ad_media").select("path, mime, fetched_at, error").eq("ad_id", adId).maybeSingle();
  const fresh = kept && Date.now() - Date.parse(kept.fetched_at as string) < KEEP_DAYS * 86_400_000;
  if (kept?.path && fresh) {
    const r = await serve(kept.path as string, (kept.mime as string | null) ?? null);
    if (r) return r;
  }
  // Tried recently and nothing could be read: don't ask Meta again for a day
  if (kept && !kept.path && Date.now() - Date.parse(kept.fetched_at as string) < 86_400_000) return null;

  try {
    const { adPreviews, metaGraph } = await import("@/lib/context/meta");
    const read = (await adPreviews([adId])).get(adId);
    // Every shape of creative: the creative's own picture first (image, link, video poster, dynamic asset), then a second
    // chance for boosted posts and Instagram posts (the post's full picture, the IG media or its video thumbnail, a
    // carousel's first card), then the ad's own preview thumbnail, and last the picture saved with the ad when it was
    // first read (kept in storage for many ads; an fbcdn link may still be live)
    const second = async () => {
      const out: string[] = [];
      type Cr = { object_story_id?: string; effective_object_story_id?: string; effective_instagram_media_id?: string; instagram_permalink_url?: string; thumbnail_url?: string; object_story_spec?: { template_data?: { picture?: string } } };
      const ad = await metaGraph<{ creative?: Cr }>(adId, { fields: "creative.thumbnail_width(1080).thumbnail_height(1080){object_story_id,effective_object_story_id,effective_instagram_media_id,thumbnail_url,object_story_spec}" }).catch(() => null);
      const c = ad?.creative;
      const story = c?.effective_object_story_id ?? c?.object_story_id;
      if (story) {
        const post = await metaGraph<{ full_picture?: string; attachments?: { data?: { media?: { image?: { src?: string } }; subattachments?: { data?: { media?: { image?: { src?: string } } }[] } }[] } }>(story, { fields: "full_picture,attachments{media,subattachments}" }).catch(() => null);
        if (post?.full_picture) out.push(post.full_picture);
        const att = post?.attachments?.data?.[0];
        const src = att?.media?.image?.src ?? att?.subattachments?.data?.[0]?.media?.image?.src;
        if (src) out.push(src);
      }
      if (c?.effective_instagram_media_id) {
        const m = await metaGraph<{ media_type?: string; media_url?: string; thumbnail_url?: string; children?: { data?: { media_type?: string; media_url?: string; thumbnail_url?: string }[] } }>(c.effective_instagram_media_id, { fields: "media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}" }).catch(() => null);
        const first = m?.children?.data?.[0];
        for (const x of [m, first]) if (x) out.push(...[x.media_type === "VIDEO" ? x.thumbnail_url : x.media_url, x.thumbnail_url].filter((u): u is string => Boolean(u)));
      }
      const tpl = c?.object_story_spec?.template_data?.picture;
      if (tpl && /^https?:/.test(tpl)) out.push(tpl);
      if (c?.thumbnail_url) out.push(c.thumbnail_url);
      const { data: saved } = await admin.from("client_ledger").select("detail").eq("kind", "creative").eq("key", adId).limit(1).maybeSingle();
      const img = (saved?.detail as { image?: string } | null)?.image;
      if (img && /^https?:/.test(img)) out.push(img);
      return out;
    };
    const tried = new Set<string>();
    const urls = async function* () {
      for (const u of read?.images ?? []) yield u;
      for (const u of await second()) yield u;
    };
    for await (const url of urls()) {
      if (tried.has(url)) continue;
      tried.add(url);
      const res = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) continue;
      const mime = res.headers.get("content-type") ?? "image/jpeg";
      if (!mime.startsWith("image/")) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 500) continue;
      const path = `${adId}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`;
      await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
      await admin.from("ad_media").upsert({ ad_id: adId, path, mime, source: url.slice(0, 1000), error: null, fetched_at: new Date().toISOString() });
      return { bytes, mime };
    }
    // An older copy is better than nothing
    if (kept?.path) {
      const r = await serve(kept.path as string, (kept.mime as string | null) ?? null);
      if (r) return r;
    }
    await admin.from("ad_media").upsert({ ad_id: adId, path: kept?.path ?? null, mime: kept?.mime ?? null, error: tried.size ? `none of ${tried.size} pictures could be fetched` : "the ad couldn't be read", fetched_at: new Date().toISOString() });
  } catch (e) {
    console.error("[ad-media]", adId, e instanceof Error ? e.message : e);
  }
  return null;
}
