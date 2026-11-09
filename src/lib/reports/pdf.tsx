import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import { ReportDocument, type ReportPdfInput } from "./report-doc";

// The client report's PDF, on the server: its document (report-doc.tsx, the same one the studio draws) with each top
// ad's picture fetched and turned into a small JPEG; one that fails is left out.

export { EDIT_HOST, type ReportPart, type ReportPdfInput } from "./report-doc";

/** An ad image as a small JPEG, or null when it can't be fetched (expired CDN links are common). */
async function adImage(url: string | null, dark = false, size = 240): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    const img = sharp(raw).resize(size, size, { fit: "cover" });
    // A flat picture (Meta's grey stand-in for a video it has no thumbnail for) is never the ad; a nearly black one (a
    // video's first frame) is skipped while there's another to try
    const { channels } = await img.clone().stats();
    if (channels.slice(0, 3).every((c) => c.stdev < 3)) return null;
    if (!dark && channels.slice(0, 3).every((c) => c.mean < 14)) return null;
    return `data:image/jpeg;base64,${(await img.jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Each part's top ad pictures, as data URIs. Meta's image links are signed and expire within days, so fresh ones are asked
 *  for; the saved link is the fallback */
export async function reportImages(input: ReportPdfInput): Promise<(string | null)[][]> {
  const ids = input.parts.flatMap((p) => (p.platform !== "google" ? p.metrics.topAds.slice(0, 3).map((a) => a.id) : []));
  const { adPreviews, metaConfigured } = await import("@/lib/context/meta");
  const fresh = ids.length && metaConfigured() ? await adPreviews(ids).catch(() => new Map<string, { images: string[] }>()) : new Map<string, { images: string[] }>();
  // The monthly deck shows the creative large
  const size = input.kind === "monthly" ? 520 : 240;
  const imageOf = async (a: { id: string; image: string | null }) => {
    for (const url of [...(fresh.get(a.id)?.images ?? []), a.image]) {
      const got = await adImage(url, false, size);
      if (got) return got;
    }
    // Every picture dark: it's a dark ad, so the first one after all
    const first = fresh.get(a.id)?.images[0] ?? a.image;
    return first ? adImage(first, true, size) : null;
  };
  return Promise.all(input.parts.map((p) => (p.platform !== "google" ? Promise.all(p.metrics.topAds.slice(0, 3).map(imageOf)) : Promise.resolve([]))));
}

/** The report as a PDF. Weekly: one part. Monthly: a landscape deck of one or two parts (Meta, Google). */
export async function renderReportPdf(input: ReportPdfInput, images?: (string | null)[][]): Promise<Uint8Array> {
  return new Uint8Array(await renderToBuffer(<ReportDocument input={input} images={images ?? (await reportImages(input))} />));
}
