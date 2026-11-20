import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { runBounded } from "@/lib/bounded";

// Every social post's picture, kept (owner, Nov 20 2026: "we NEED to show previews"). Meta's picture links (fbcdn,
// cdninstagram) are signed and stop working after a few days, so a report drawn or opened later showed "No preview".
// The sync saves each post's picture once, at most 1080 wide, in the private report-sends bucket at
// social-posts/<client>/<platform>-<post>.jpg; the PDF reads the file and the live page gets a signed link to it, the
// stored Meta link only being the fallback. Nothing here throws: a picture that can't be read is simply not kept yet.

const BUCKET = "report-sends";
const FOLDER = "social-posts";
const safe = (s: string) => s.replace(/[^\w-]/g, "").slice(0, 80);
const folderOf = (clientId: string) => `${FOLDER}/${safe(clientId)}`;
export const postPictureName = (platform: string, id: string) => `${safe(platform)}-${safe(id)}.jpg`;
export const postPictureKey = (p: { platform: string; id: string }) => `${p.platform}:${p.id}`;

/** The pictures already kept for a client, by file name */
async function kept(admin: SupabaseClient, clientId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await admin.storage.from(BUCKET).list(folderOf(clientId), { limit: 1000, offset });
    if (error || !data?.length) break;
    for (const f of data) out.add(f.name);
    if (data.length < 1000) break;
  }
  return out;
}

/** Keep the pictures of these posts that aren't kept yet (the newest first, at most `max` a run) */
export async function cachePostPictures(admin: SupabaseClient, clientId: string, posts: { platform: string; id: string; thumbnail: string | null; postedAt?: string | null }[], opts: { max?: number } = {}): Promise<{ saved: number; failed: number }> {
  const have = await kept(admin, clientId).catch(() => new Set<string>());
  const todo = posts
    .filter((p) => p.thumbnail && !have.has(postPictureName(p.platform, p.id)))
    .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
    .slice(0, opts.max ?? 80);
  let saved = 0;
  let failed = 0;
  await runBounded(todo, { limit: 4 }, async (p) => {
    try {
      const res = await fetch(p.thumbnail!, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenOS)" } });
      if (!res.ok) throw new Error(String(res.status));
      const jpg = await sharp(Buffer.from(await res.arrayBuffer())).rotate().resize({ width: 1080, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      const { error } = await admin.storage.from(BUCKET).upload(`${folderOf(clientId)}/${postPictureName(p.platform, p.id)}`, jpg, { contentType: "image/jpeg", upsert: true });
      if (error) throw new Error(error.message);
      saved++;
    } catch {
      failed++;
    }
  });
  return { saved, failed };
}

/** The kept pictures' bytes, by post key (for the PDF) */
export async function postPictureBytes(admin: SupabaseClient, clientId: string, posts: { platform: string; id: string }[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const have = await kept(admin, clientId).catch(() => new Set<string>());
  await Promise.all(
    posts
      .filter((p) => have.has(postPictureName(p.platform, p.id)))
      .map(async (p) => {
        const { data } = await admin.storage.from(BUCKET).download(`${folderOf(clientId)}/${postPictureName(p.platform, p.id)}`);
        if (data) out.set(postPictureKey(p), Buffer.from(await data.arrayBuffer()));
      }),
  );
  return out;
}

/** Signed links to the kept pictures, by post key (for the live page) */
export async function postPictureLinks(admin: SupabaseClient, clientId: string, posts: { platform: string; id: string }[], seconds = 6 * 3600): Promise<Record<string, string>> {
  const have = await kept(admin, clientId).catch(() => new Set<string>());
  const list = posts.filter((p) => have.has(postPictureName(p.platform, p.id)));
  if (!list.length) return {};
  const { data } = await admin.storage.from(BUCKET).createSignedUrls(list.map((p) => `${folderOf(clientId)}/${postPictureName(p.platform, p.id)}`), seconds);
  const out: Record<string, string> = {};
  (data ?? []).forEach((d, i) => {
    if (d.signedUrl) out[postPictureKey(list[i])] = d.signedUrl;
  });
  return out;
}
