import type { Format } from "@/lib/stages";

/** Variations per format are capped; more than this should be its own design. */
export const MAX_VARIATIONS = 5;

/** A client's monthly creative allotment and what this month's requests already used. null = not set yet. */
export type Allotment = {
  images: number | null;
  videos: number | null;
  imagesUsed: number;
  videosUsed: number;
  until: string | null;
  /** Briefed in Asana, production not started: not counted yet, but spoken for */
  waiting?: { images: number; videos: number };
};

/** until: a sprint package's last day (YYYY-MM-DD); null = ongoing. */
export type UsageRow = {
  client_id: string;
  images_per_month: number | null;
  videos_per_month: number | null;
  images_used: number;
  videos_used: number;
  package_until?: string | null;
  asana_waiting_images?: number;
  asana_waiting_videos?: number;
};

export const toAllotment = (r: UsageRow): Allotment => ({
  images: r.images_per_month,
  videos: r.videos_per_month,
  imagesUsed: r.images_used,
  videosUsed: r.videos_used,
  until: r.package_until ?? null,
  waiting: r.asana_waiting_images || r.asana_waiting_videos ? { images: r.asana_waiting_images ?? 0, videos: r.asana_waiting_videos ?? 0 } : undefined,
});

/** "Nov 30" (or "Nov 30, 2027" outside this year) for a YYYY-MM-DD day. */
export function untilLabel(day: string) {
  const d = new Date(`${day}T12:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

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
  const lines = [line("Images and carousels", a.images, a.imagesUsed, request?.images), line("Videos", a.videos, a.videosUsed, request?.videos)];
  if (a.waiting) lines.push(`Also briefed in Asana and not started yet (they'll count once production starts): ${a.waiting.images} images, ${a.waiting.videos} videos. Treat them as spoken for.`);
  return lines.join("\n");
}
