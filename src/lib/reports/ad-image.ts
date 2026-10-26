import "server-only";
import sharp from "sharp";
import type { ReportMetrics } from "./metrics";

// A report's top-ad images, served through the app: Meta's image links are signed and expire within days, so the
// report page and the client's live page ask for a fresh one each time (cached for an hour), with the link saved at
// drafting as the fallback.

/** Whether an ad is one of the report's top ads (only those are served), and its saved image link. */
export function topAdOf(metrics: ReportMetrics | null | undefined, adId: string) {
  return metrics?.topAds.find((a) => a.id === adId) ?? null;
}

export async function adImageResponse(adId: string, saved: string | null, cache: "public" | "private") {
  const { adPreviews, metaConfigured } = await import("@/lib/context/meta");
  const fresh = metaConfigured() ? (await adPreviews([adId]).catch(() => null))?.get(adId)?.image : null;
  for (const url of [fresh, saved]) {
    if (!url) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const jpeg = await sharp(Buffer.from(await res.arrayBuffer())).resize(600, 600, { fit: "cover" }).jpeg({ quality: 84 }).toBuffer();
      return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg", "cache-control": `${cache}, max-age=3600`, "x-robots-tag": "noindex" } });
    } catch {
      // try the next link
    }
  }
  return new Response("No image", { status: 404, headers: { "cache-control": "no-store" } });
}
