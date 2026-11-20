import "server-only";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DeckDocument, type DeckInput } from "./deck-doc";
import { lookFor } from "@/lib/reports/weekly-doc";
import { deckFileName, pickImage, type Slide } from "./deck-core";
import { AI_BUCKET } from "./files";
import type { Attachment } from "./types";

// make_deck's work on the server: the attached pictures the slides name, the client's logo and colour beside Kaizen's, the
// PDF drawn, and kept in the private ai-files bucket under the person's own folder (<profile id>/decks/), with a signed
// link good for a week.

Font.registerHyphenationCallback((word) => [word]);

const WEEK = 7 * 24 * 3600;

/** A picture as a JPEG for the deck, at most 1400 pixels on a side, with its size */
async function asJpeg(bytes: ArrayBuffer | Buffer) {
  const img = sharp(Buffer.from(bytes as ArrayBuffer)).rotate().resize(1400, 1400, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { jpg: data, width: info.width, height: info.height };
}

/**
 * The pictures the slides name, as JPEGs keyed by the name the slide used: an attached picture (by name or number), or a
 * Meta ad's own picture ("ad:<ad_id>", from custom_report_data's creatives: Meta's link, read fresh). One that can't be
 * read is left out.
 */
async function slidePictures(admin: SupabaseClient, slides: Slide[], files: Attachment[], adPictures: boolean) {
  const out = new Map<string, { jpg: Buffer; width: number; height: number }>();
  const wanted = [...new Set(slides.flatMap((sl) => (sl.kind === "image_notes" && sl.image ? [sl.image] : [])))];
  const ads = adPictures ? wanted.filter((w) => /^ad:\d{5,25}$/i.test(w.trim())) : [];
  const fromMeta = ads.length ? await import("@/lib/context/meta").then((m) => m.adPreviews(ads.map((a) => a.trim().slice(3)))).catch(() => null) : null;
  for (const name of wanted) {
    try {
      if (ads.includes(name)) {
        const urls = fromMeta?.get(name.trim().slice(3))?.images ?? [];
        for (const url of urls.slice(0, 3)) {
          // Only Meta's own picture links (never a link from the model)
          if (!/^https:\/\/[^/]*(fbcdn\.net|fbsbx\.com|facebook\.com|cdninstagram\.com)\//i.test(url)) continue;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
          if (!res?.ok) continue;
          out.set(name, await asJpeg(await res.arrayBuffer()));
          break;
        }
        continue;
      }
      const f = pickImage(files, name);
      if (!f) continue;
      const { data } = await admin.storage.from(AI_BUCKET).download(f.path);
      if (!data) continue;
      out.set(name, await asJpeg(await data.arrayBuffer()));
    } catch {
      // drawn as "Picture not available"
    }
  }
  return out;
}

export type MadeDeck = { url: string; path: string; slides: number; missingPictures: string[]; pptx: { url: string; path: string } | null };

async function signed(admin: SupabaseClient, path: string, bytes: Uint8Array | Buffer, type: string, download: string) {
  const { error } = await admin.storage.from(AI_BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (error) throw new Error(`Couldn't save the deck: ${error.message}`);
  const { data, error: signError } = await admin.storage.from(AI_BUCKET).createSignedUrl(path, WEEK, { download });
  if (signError || !data) throw new Error("The deck was saved but its link couldn't be made. Try again.");
  return data.signedUrl;
}

/** The deck as a PDF, and as an editable PowerPoint unless only the PDF is wanted */
export async function makeDeckPdf(opts: { admin: SupabaseClient; profileId: string; title: string; subtitle: string; client: { id: string; name: string } | null; slides: Slide[]; files: Attachment[]; pptx?: boolean; /** Meta ads' own pictures ("ad:<id>"): not for the email and social teams */ adPictures?: boolean }): Promise<MadeDeck> {
  const { admin, profileId, title, subtitle, client, slides, files } = opts;
  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, pics, mark] = await Promise.all([client ? reportBrand(admin, client.id).catch(() => null) : Promise.resolve(null), slidePictures(admin, slides, files, opts.adPictures === true), agencyLogo()]);
  const images = new Map([...pics].map(([k, v]) => [k, `data:image/jpeg;base64,${v.jpg.toString("base64")}`]));
  const input: DeckInput = { title, subtitle, client: client?.name ?? null, brand: { logo: brand?.logo ?? null, light: brand?.light ?? false, color: brand?.color ?? null, agencyLogo: mark }, slides };
  const pdf = await renderToBuffer(<DeckDocument input={input} images={images} />);
  const stamp = Date.now();
  const path = `${profileId}/decks/${stamp}-${deckFileName(title)}`;
  const url = await signed(admin, path, pdf, "application/pdf", deckFileName(title));
  let pptx: MadeDeck["pptx"] = null;
  if (opts.pptx !== false) {
    const { deckPptx } = await import("./deck-pptx");
    const look = lookFor({ brand: input.brand, whiteLabel: false });
    const bytes = deckPptx({ title, client: client?.name ?? null, look, slides, pictures: new Map([...pics].map(([k, v]) => [k, { bytes: new Uint8Array(v.jpg), width: v.width, height: v.height }])) });
    const name = deckFileName(title).replace(/\.pdf$/, ".pptx");
    const ppath = `${profileId}/decks/${stamp}-${name}`;
    pptx = { path: ppath, url: await signed(admin, ppath, bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", name) };
  }
  const missingPictures = slides.flatMap((s) => (s.kind === "image_notes" && s.image && !images.has(s.image) ? [s.image] : []));
  return { url, path, slides: slides.length, missingPictures, pptx };
}
