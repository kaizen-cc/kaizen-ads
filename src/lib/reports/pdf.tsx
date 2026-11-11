import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import { ReportDocument, type ReportPdfInput } from "./report-doc";

// The client report's PDF, on the server: its document (report-doc.tsx, the same one the studio draws) with each ad's
// picture fetched and turned into a small JPEG (one that fails is left out), and the client's logo and colour beside
// Kaizen's (brand-server.ts).

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

/** The ads (or Google asset groups) whose pictures a part shows: the weekly's scorecard has them all, the others three */
const picturedAds = (input: ReportPdfInput, p: ReportPdfInput["parts"][number]) => (p.platform === "google" ? [] : input.kind === "weekly" ? p.metrics.topAds : p.metrics.topAds.slice(0, 3));

/**
 * Each part's pictures, as data URIs, in the order the document reads them (the ads in topAds order; on a Google
 * weekly, each ad group and asset group's picture in googleUnits order). Meta's image links are signed and expire within
 * days, so fresh ones are asked for; the saved link is the fallback
 */
export async function reportImages(input: ReportPdfInput): Promise<(string | null)[][]> {
  const ids = input.parts.flatMap((p) => (p.platform === "meta" ? picturedAds(input, p).map((a) => a.id) : []));
  const { adPreviews, metaConfigured } = await import("@/lib/context/meta");
  const fresh = ids.length && metaConfigured() ? await adPreviews(ids).catch(() => new Map<string, { images: string[] }>()) : new Map<string, { images: string[] }>();
  // The monthly deck shows the creative large; the weekly scorecard as a thumbnail
  const size = input.kind === "monthly" ? 520 : input.kind === "weekly" ? 160 : 240;
  const imageOf = async (a: { id: string; image: string | null }) => {
    for (const url of [...(fresh.get(a.id)?.images ?? []), a.image]) {
      const got = await adImage(url, false, size);
      if (got) return got;
    }
    // Every picture dark: it's a dark ad, so the first one after all
    const first = fresh.get(a.id)?.images[0] ?? a.image;
    return first ? adImage(first, true, size) : null;
  };
  return Promise.all(
    input.parts.map((p) => {
      if (p.platform === "google") return input.kind === "weekly" ? Promise.all((p.metrics.googleUnits ?? []).map((u) => (u.image ? adImage(u.image, true, size) : Promise.resolve(null)))) : Promise.resolve([]);
      return Promise.all(picturedAds(input, p).map(imageOf));
    }),
  );
}

/** The client's logo and colour, and Kaizen's logo, on the input (once; a white label client's never gets Kaizen's) */
export async function withBrand(input: ReportPdfInput): Promise<ReportPdfInput> {
  if (input.brand !== undefined) return input;
  const { agencyLogo, reportBrand } = await import("./brand-server");
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  const client = input.clientId && adminConfigured() ? await reportBrand(createAdminClient(), input.clientId).catch(() => null) : null;
  return { ...input, brand: { logo: client?.logo ?? null, light: client?.light ?? false, color: client?.color ?? null, agencyLogo: input.whiteLabel ? null : await agencyLogo() } };
}

/** What the document needs to be drawn (the server's PDF and the studio's preview): the input with its brand, and its pictures */
export async function prepareReport(input: ReportPdfInput) {
  const [branded, images] = await Promise.all([withBrand(input), reportImages(input)]);
  return { input: branded, images };
}

/** The report as a PDF. Weekly: one document, a section per platform. Monthly: a landscape deck. */
export async function renderReportPdf(input: ReportPdfInput, images?: (string | null)[][]): Promise<Uint8Array> {
  const ready = images ? { input: await withBrand(input), images } : await prepareReport(input);
  return new Uint8Array(await renderToBuffer(<ReportDocument input={ready.input} images={ready.images} />));
}
