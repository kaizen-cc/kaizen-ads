import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import { ChannelDocument, shotKey, type ChannelImages, type ChannelPdfInput } from "./channel-doc";
import { shotCampaigns } from "./email-cards";

// A channel report as a PDF on the server: its document (channel-doc.tsx) with each email's and post's picture fetched and
// made a small JPEG (one that fails is left out, never holding the report up), and the client's logo and colour beside
// Kaizen's (the same brand the ads reports use).

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

/** A picture as a small JPEG: square, or `tall` (2:3, kept from the top, the way an email's top half reads) */
async function picture(url: string | null, size = 320, tall = false): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const img = sharp(Buffer.from(await res.arrayBuffer())).resize(size, tall ? Math.round(size * 1.5) : size, { fit: "cover", position: tall ? "top" : "centre" });
    const { channels } = await img.clone().stats();
    // A flat picture (a grey stand-in) is never the content
    if (channels.slice(0, 3).every((c) => c.stdev < 3)) return null;
    return `data:image/jpeg;base64,${(await img.jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The campaign cards' pictures: the top of each email as drawn and saved (email-shots.ts), drawn now when it isn't saved
 * yet and a browser is at hand, else the email's first picture. Keyed shot:<campaign id>.
 */
async function emailShots(input: ChannelPdfInput): Promise<ChannelImages> {
  const m = input.metrics;
  if (m.platform !== "klaviyo" || !m.detail) return {};
  const ids = shotCampaigns(m.detail.campaigns, { currency: m.currency, revenueMeasured: m.revenueMeasured !== false }).filter((c) => c.channel !== "sms").map((c) => c.id);
  if (!ids.length) return {};
  const out: ChannelImages = {};
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  if (input.clientId && adminConfigured()) {
    const { emailShotData } = await import("./email-shots");
    const got = await within(40_000, emailShotData(createAdminClient(), input.clientId, ids, { budgetMs: 30_000 }).catch(() => new Map<string, string>()), new Map<string, string>());
    for (const [id, uri] of got) out[shotKey(id)] = uri;
  }
  // The fallback: the email's first real picture, kept from the top
  const missing = ids.filter((id) => !out[shotKey(id)]);
  const hero = await Promise.all(missing.map((id) => within(12_000, picture(m.campaigns.find((c) => c.id === id)?.image ?? null, 400, true), null)));
  missing.forEach((id, i) => (out[shotKey(id)] = hero[i]));
  return out;
}

/** The pictures the document draws, by what they picture */
export async function channelImages(input: ChannelPdfInput): Promise<ChannelImages> {
  const m = input.metrics;
  // Social: each post framed 4:5 whole, never cropped (social-pictures.ts)
  if (m.platform === "social") return (await import("./social-pictures")).socialPictures(m);
  // An email report with its detail shows each card's email (emailShots); an older one shows the campaigns' first pictures
  const jobs: [string, string | null][] = m.detail ? [] : m.campaigns.slice(0, 6).map((c) => [c.id, c.image]);
  const [got, shots] = await Promise.all([Promise.all(jobs.map(([, url]) => within(20_000, picture(url), null))), emailShots(input)]);
  return { ...Object.fromEntries(jobs.map(([k], i) => [k, got[i]])), ...shots };
}

/** The client's logo and colour, and Kaizen's logo, on the input (a white label client's never gets Kaizen's) */
export async function withBrand(input: ChannelPdfInput): Promise<ChannelPdfInput> {
  if (input.brand !== undefined) return input;
  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  const client = input.clientId && adminConfigured() ? await reportBrand(createAdminClient(), input.clientId).catch(() => null) : null;
  return { ...input, brand: { logo: client?.logo ?? null, light: client?.light ?? false, color: client?.color ?? null, agencyLogo: input.whiteLabel ? null : await agencyLogo() } };
}

/** What the studio needs to draw the PDF in the browser: the input with its brand, and the pictures (read once) */
export async function prepareChannel(input: ChannelPdfInput): Promise<{ input: ChannelPdfInput; images: ChannelImages }> {
  const [branded, images] = await Promise.all([withBrand(input), channelImages(input)]);
  return { input: branded, images };
}

export async function renderChannelPdf(input: ChannelPdfInput): Promise<Uint8Array> {
  const [branded, images] = await Promise.all([withBrand(input), channelImages(input)]);
  return new Uint8Array(await renderToBuffer(<ChannelDocument input={branded} images={images} />));
}
