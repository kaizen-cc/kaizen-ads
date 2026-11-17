import "server-only";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DeckDocument, type DeckInput } from "./deck-doc";
import { deckFileName, pickImage, type Slide } from "./deck-core";
import { AI_BUCKET } from "./files";
import type { Attachment } from "./types";

// make_deck's work on the server: the attached pictures the slides name, the client's logo and colour beside Kaizen's, the
// PDF drawn, and kept in the private ai-files bucket under the person's own folder (<profile id>/decks/), with a signed
// link good for a week.

Font.registerHyphenationCallback((word) => [word]);

const WEEK = 7 * 24 * 3600;

/** The attached pictures the slides name, as JPEG data URIs keyed by the name the slide used (one that can't be read is left out) */
async function slidePictures(admin: SupabaseClient, slides: Slide[], files: Attachment[]) {
  const out = new Map<string, string>();
  for (const sl of slides) {
    if (sl.kind !== "image_notes" || !sl.image || out.has(sl.image)) continue;
    const f = pickImage(files, sl.image);
    if (!f) continue;
    try {
      const { data } = await admin.storage.from(AI_BUCKET).download(f.path);
      if (!data) continue;
      const jpg = await sharp(Buffer.from(await data.arrayBuffer())).rotate().resize(1400, 1400, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      out.set(sl.image, `data:image/jpeg;base64,${jpg.toString("base64")}`);
    } catch {
      // drawn as "Picture not available"
    }
  }
  return out;
}

export type MadeDeck = { url: string; path: string; slides: number; missingPictures: string[] };

export async function makeDeckPdf(opts: { admin: SupabaseClient; profileId: string; title: string; subtitle: string; client: { id: string; name: string } | null; slides: Slide[]; files: Attachment[] }): Promise<MadeDeck> {
  const { admin, profileId, title, subtitle, client, slides, files } = opts;
  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, images, mark] = await Promise.all([client ? reportBrand(admin, client.id).catch(() => null) : Promise.resolve(null), slidePictures(admin, slides, files), agencyLogo()]);
  const input: DeckInput = { title, subtitle, client: client?.name ?? null, brand: { logo: brand?.logo ?? null, light: brand?.light ?? false, color: brand?.color ?? null, agencyLogo: mark }, slides };
  const pdf = await renderToBuffer(<DeckDocument input={input} images={images} />);
  const path = `${profileId}/decks/${Date.now()}-${deckFileName(title)}`;
  const { error } = await admin.storage.from(AI_BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: false });
  if (error) throw new Error(`Couldn't save the deck: ${error.message}`);
  const { data, error: signError } = await admin.storage.from(AI_BUCKET).createSignedUrl(path, WEEK, { download: deckFileName(title) });
  if (signError || !data) throw new Error("The deck was saved but its link couldn't be made. Try again.");
  const missingPictures = slides.flatMap((s) => (s.kind === "image_notes" && s.image && !images.has(s.image) ? [s.image] : []));
  return { url: data.signedUrl, path, slides: slides.length, missingPictures };
}
