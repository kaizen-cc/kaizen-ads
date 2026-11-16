import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import { ChannelDocument, postKey, type ChannelImages, type ChannelPdfInput } from "./channel-doc";

// A channel report as a PDF on the server: its document (channel-doc.tsx) with each email's and post's picture fetched and
// made a small JPEG (one that fails is left out, never holding the report up), and the client's logo and colour beside
// Kaizen's (the same brand the ads reports use).

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

async function picture(url: string | null, size = 320): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const img = sharp(Buffer.from(await res.arrayBuffer())).resize(size, size, { fit: "cover" });
    const { channels } = await img.clone().stats();
    // A flat picture (a grey stand-in) is never the content
    if (channels.slice(0, 3).every((c) => c.stdev < 3)) return null;
    return `data:image/jpeg;base64,${(await img.jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/** The pictures the document draws, by what they picture */
export async function channelImages(input: ChannelPdfInput): Promise<ChannelImages> {
  const m = input.metrics;
  // An email report with its detail draws tables, not pictures: only an older one shows the campaigns' emails
  const jobs: [string, string | null][] = m.platform === "klaviyo" ? (m.detail ? [] : m.campaigns.slice(0, 6).map((c) => [c.id, c.image])) : m.posts.slice(0, 3).map((p) => [postKey(p), p.thumbnail]);
  const got = await Promise.all(jobs.map(([, url]) => within(20_000, picture(url), null)));
  return Object.fromEntries(jobs.map(([k], i) => [k, got[i]]));
}

/** The client's logo and colour, and Kaizen's logo, on the input (a white label client's never gets Kaizen's) */
async function withBrand(input: ChannelPdfInput): Promise<ChannelPdfInput> {
  if (input.brand !== undefined) return input;
  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  const client = input.clientId && adminConfigured() ? await reportBrand(createAdminClient(), input.clientId).catch(() => null) : null;
  return { ...input, brand: { logo: client?.logo ?? null, light: client?.light ?? false, color: client?.color ?? null, agencyLogo: input.whiteLabel ? null : await agencyLogo() } };
}

export async function renderChannelPdf(input: ChannelPdfInput): Promise<Uint8Array> {
  const [branded, images] = await Promise.all([withBrand(input), channelImages(input)]);
  return new Uint8Array(await renderToBuffer(<ChannelDocument input={branded} images={images} />));
}
