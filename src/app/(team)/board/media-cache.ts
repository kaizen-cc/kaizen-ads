"use client";

import type { Design } from "./design-actions";
import type { ReviewComment } from "./review-actions";

// A ticket's creative and comments, kept in the browser: opening a ticket shows what was loaded before at once (the
// signed links last an hour; past 45 minutes it loads again), refreshes behind it, and the board fetches it ahead as a
// card is hovered. The covers are preloaded so the pictures are there when the drawer opens.

export type TicketMedia = { designs: Design[]; comments: ReviewComment[] };
const FRESH_MS = 45 * 60_000;
const cache = new Map<string, { at: number; data: TicketMedia }>();
const inflight = new Map<string, Promise<TicketMedia | null>>();
const preloaded = new Set<string>();

export function cachedMedia(id: string): TicketMedia | null {
  const hit = cache.get(id);
  return hit && Date.now() - hit.at < FRESH_MS ? hit.data : null;
}

/** Load (or reuse the request already on its way). force: always ask the server again. */
export function loadMedia(id: string, force = false): Promise<TicketMedia | null> {
  if (!force) {
    const hit = cachedMedia(id);
    if (hit) return Promise.resolve(hit);
  }
  const going = inflight.get(id);
  if (going) return going;
  const p = fetch(`/api/board/media/${id}`, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<TicketMedia>) : null))
    .then((data) => {
      if (data) {
        cache.set(id, { at: Date.now(), data });
        preloadCovers(data.designs);
      }
      return data;
    })
    .catch(() => null)
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export function updateMedia(id: string, change: Partial<TicketMedia>) {
  const hit = cache.get(id);
  if (hit) cache.set(id, { at: hit.at, data: { ...hit.data, ...change } });
}

/** Hovering a card or opening a ticket: fetch ahead, quietly. */
export const prefetchMedia = (id: string) => void loadMedia(id);

/** The pictures people see first: each design's cover thumbnail, then its full-size cover. */
export function preloadCovers(designs: Design[]) {
  if (typeof window === "undefined") return;
  const urls: string[] = [];
  for (const d of designs) {
    const v = d.versions[0];
    const cover = v?.files.find((f) => f.aspect === "4x5") ?? v?.files[0];
    if (cover?.thumbUrl) urls.push(cover.thumbUrl);
    if (cover?.url && cover.mime.startsWith("image/")) urls.push(cover.url);
  }
  for (const u of urls) {
    const key = u.split("?")[0];
    if (preloaded.has(key)) continue;
    preloaded.add(key);
    const img = new Image();
    img.decoding = "async";
    img.src = u;
  }
}
