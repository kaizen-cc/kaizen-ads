import type { Format } from "@/lib/stages";

/** Variations per format are capped; more than this should be its own design. */
export const MAX_VARIATIONS = 5;

/** A client's monthly creative allotment and what this month's requests already used. null = not set yet. */
export type Allotment = { images: number | null; videos: number | null; imagesUsed: number; videosUsed: number };

export type UsageRow = { client_id: string; images_per_month: number | null; videos_per_month: number | null; images_used: number; videos_used: number };

export const toAllotment = (r: UsageRow): Allotment => ({
  images: r.images_per_month,
  videos: r.videos_per_month,
  imagesUsed: r.images_used,
  videosUsed: r.videos_used,
});

/** Only net new designs draw on the allotment. Images and carousels share the image pool. */
export function draws(formats: Partial<Record<Format, { new: number }>>) {
  return {
    images: (formats.image?.new ?? 0) + (formats.carousel?.new ?? 0),
    videos: formats.video?.new ?? 0,
  };
}

export const left = (cap: number | null, used: number) => (cap === null ? null : cap - used);

/** For the AI: one line per pool, with what this request would take if given. */
export function describeAllotment(a: Allotment | null, request?: { images: number; videos: number }) {
  if (!a || (a.images === null && a.videos === null)) return "No monthly allotment is set for this client yet, so you can't check it.";
  const line = (label: string, cap: number | null, used: number, req?: number) =>
    cap === null
      ? `${label}: not set`
      : `${label}: ${cap} per month, ${used} used, ${cap - used} left${req !== undefined ? `; this request takes ${req}, leaving ${cap - used - req}` : ""}`;
  return [line("Images and carousels", a.images, a.imagesUsed, request?.images), line("Videos", a.videos, a.videosUsed, request?.videos)].join("\n");
}
