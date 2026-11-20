import "server-only";
import sharp from "sharp";
import type { SocialMetrics } from "./core";
import { postFrame, postKey } from "./social-report";

// The social report's post pictures, framed for the cards: a 4:5 portrait (Instagram's feed shape), or a square when three
// posts share a row (postFrame). A
// picture close to that shape fills the frame; any other (a square with a text banner, a wide Facebook photo) is shown
// whole, centred over a soft blurred copy of itself, so a banner or a face is never cut off. One that fails is left out.

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

/** A picture framed to the card's shape as a JPEG data URI (cover when its shape is close, else contained on its own blur) */
export async function framePicture(buf: Buffer, frame = postFrame(1)): Promise<string | null> {
  const FRAME_W = frame.w;
  const FRAME_H = frame.h;
  const img = sharp(buf).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return null;
  const { channels } = await img.clone().stats();
  // A flat picture (a grey stand-in) is never the content
  if (channels.slice(0, 3).every((c) => c.stdev < 3)) return null;
  const ratio = meta.width / meta.height;
  const target = FRAME_W / FRAME_H;
  let out: Buffer;
  if (Math.abs(ratio - target) / target <= 0.06) {
    out = await img.resize(FRAME_W, FRAME_H, { fit: "cover", position: "attention" }).jpeg({ quality: 84 }).toBuffer();
  } else {
    const back = await img.clone().resize(FRAME_W, FRAME_H, { fit: "cover" }).blur(28).modulate({ brightness: 0.82, saturation: 0.9 }).toBuffer();
    const front = await img.clone().resize(FRAME_W, FRAME_H, { fit: "inside" }).toBuffer();
    out = await sharp(back).composite([{ input: front, gravity: "centre" }]).jpeg({ quality: 84 }).toBuffer();
  }
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function fetchFramed(url: string | null, frame: { w: number; h: number }): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await framePicture(Buffer.from(await res.arrayBuffer()), frame);
  } catch {
    return null;
  }
}

/**
 * The pictures of every post card the report draws, by post: the top posts (up to six, two rows of three) and each
 * location's best post. The picture the sync kept is read first (Meta's own links stop working after a few days), the
 * post's stored link only when none was kept. Before, only the first three were fetched, so a second row always said
 * "No preview".
 */
export async function socialPictures(m: SocialMetrics, clientId?: string | null): Promise<Record<string, string | null>> {
  const top = m.posts.slice(0, 6);
  const extra = (m.locations ?? []).map((l) => l.posts[0]).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const posts = [...new Map([...top, ...extra].map((p) => [postKey(p), p])).values()];
  const frame = postFrame(Math.min(3, Math.max(1, top.length)));
  let kept = new Map<string, Buffer>();
  if (clientId) {
    const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
    if (adminConfigured()) kept = await within(20_000, import("@/lib/social/pictures").then((x) => x.postPictureBytes(createAdminClient(), clientId, posts)), new Map<string, Buffer>()).catch(() => new Map<string, Buffer>());
  }
  const got = await Promise.all(
    posts.map(async (p) => {
      const buf = kept.get(postKey(p));
      const fromKept = buf ? await framePicture(buf, frame).catch(() => null) : null;
      return fromKept ?? within(20_000, fetchFramed(p.thumbnail, frame), null);
    }),
  );
  return Object.fromEntries(posts.map((p, i) => [postKey(p), got[i]]));
}
