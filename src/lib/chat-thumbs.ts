import "server-only";
import type { ChatImage } from "./chat-images";

/**
 * Small copies of the screenshots pasted with a chat message, kept on the message itself so the thread shows them
 * afterwards (the full pictures go to the model once and aren't stored). JPEG, at most 480px a side.
 */
export async function chatThumbs(images: ChatImage[] | undefined): Promise<string[]> {
  if (!images?.length) return [];
  const sharp = (await import("sharp")).default;
  const out: string[] = [];
  for (const im of images.slice(0, 6)) {
    try {
      const buf = await sharp(Buffer.from(im.data, "base64")).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer();
      out.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
    } catch {
      // A picture sharp can't read is left out of the thread (the model still saw it)
    }
  }
  return out;
}
