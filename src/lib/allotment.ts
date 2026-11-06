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
  /** The billing cycle being counted (YYYY-MM-DD; the end is the day it resets) */
  cycle?: { start: string; end: string } | null;
  /** On the board or in Asana and not delivered yet (requested, in production, in review, with the client), per pool,
   *  whatever cycle it was asked in: what's already coming, so nobody overproduces against what's left */
  progress?: { images: number; videos: number };
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
  period_start?: string | null;
  period_end?: string | null;
  progress_images?: number;
  progress_videos?: number;
};

export const toAllotment = (r: UsageRow): Allotment => ({
  images: r.images_per_month,
  videos: r.videos_per_month,
  imagesUsed: r.images_used,
  videosUsed: r.videos_used,
  until: r.package_until ?? null,
  waiting: r.asana_waiting_images || r.asana_waiting_videos ? { images: r.asana_waiting_images ?? 0, videos: r.asana_waiting_videos ?? 0 } : undefined,
  cycle: r.period_start && r.period_end ? { start: r.period_start, end: r.period_end } : null,
  progress: { images: r.progress_images ?? 0, videos: r.progress_videos ?? 0 },
});

/** What's in progress for one pool (0 when nothing, or not known) */
export const inProgress = (a: Pick<Allotment, "progress"> | null | undefined, key: "images" | "videos") => Math.max(0, Number(a?.progress?.[key]) || 0);

/** "Images 0/25 used · 14 in progress · Videos 2/5 used": every pool, with what's on its way next to what's used */
export function allotmentWithProgress(a: (PoolCounts & Pick<Allotment, "progress">) | null | undefined) {
  const pools = allotmentPools(a);
  if (!pools.length) return null;
  return pools
    .map((p) => {
      const n = inProgress(a, p.key);
      return `${p.label} ${p.used}/${p.cap} used${p.over ? ` · ${p.over} over` : ""}${n ? ` · ${n} in progress` : ""}`;
    })
    .join(" · ");
}

/** How far through its billing cycle a client is (0 to 1); the calendar month when no cycle is known. */
export function cycleElapsed(cycle: { start: string; end: string } | null | undefined, now = new Date()) {
  if (!cycle) return now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const a = new Date(`${cycle.start}T00:00:00`).getTime();
  const b = new Date(`${cycle.end}T00:00:00`).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - a) / Math.max(1, b - a)));
}

/** "Nov 30" (or "Nov 30, 2027" outside this year) for a YYYY-MM-DD day. */
export function untilLabel(day: string) {
  const d = new Date(`${day}T12:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

// THE ALLOTMENT RULE (owner's policy, Nov 2026). A brief is ONE concept; several distinct concepts are several briefs.
// Every version of that concept counts (the net new design and each of its variations), a carousel once per slide.
// Sizes of one version (4:5 and 9:16) are free, and so are copy-only edits and print or organic-only work.
// Images and carousels share the image pool; videos have their own. The database counts the same way
// (requests.allotment_units, read by client_allotment_usage): keep the two in step.

/** A carousel's slides when nobody set them (the request form's default). */
export const DEFAULT_CARDS = 5;
const whole = (n: number | null | undefined) => Math.max(0, Math.floor(Number(n) || 0));
/** A carousel's slides, as the database allows them (2 to 10). */
export const slidesOf = (cards: number | null | undefined) => (cards == null ? DEFAULT_CARDS : Math.min(10, Math.max(2, whole(cards))));

export type FormatCounts = { new: number; variations?: number; cards?: number | null };

/** What one format of a request takes from the allotment: every version, a carousel once per slide. */
export function unitsFor(format: Format, c: FormatCounts | null | undefined) {
  if (!c) return 0;
  const versions = whole(c.new) + whole(c.variations);
  return format === "carousel" ? versions * slidesOf(c.cards) : versions;
}

/** What a request takes from each pool: every version counts, a carousel once per slide; sizes are free. */
export function draws(formats: Partial<Record<Format, FormatCounts>>) {
  return {
    images: unitsFor("image", formats.image) + unitsFor("carousel", formats.carousel),
    videos: unitsFor("video", formats.video),
  };
}

/** "1 concept, 3 versions" or "1 concept, carousel, 2 versions of 6 slides": how a brief says what it asks for. */
export function conceptLine(format: Format, c: FormatCounts) {
  const versions = whole(c.new) + whole(c.variations);
  const v = `${versions} version${versions === 1 ? "" : "s"}`;
  if (format !== "carousel") return `1 concept, ${v}`;
  const slides = slidesOf(c.cards);
  return versions === 1 ? `1 concept, carousel, ${slides} slides` : `1 concept, carousel, ${v} of ${slides} slides`;
}

/** The rule in one paragraph, for every AI that writes or checks a brief. */
export const ALLOTMENT_RULE =
  "One concept per brief: a brief is one idea (one angle, one concept); several distinct concepts are several briefs. Every version of that concept counts toward the monthly allotment (the net new design and each variation of it), and a carousel counts once per slide. Sizes (4:5 and 9:16 of the same version) don't count, and neither do copy-only edits or print and organic-only work. Images and carousels share the image allotment; videos have their own.";

export const left = (cap: number | null, used: number) => (cap === null ? null : cap - used);

// THE ONE WAY TO SHOW AN ALLOTMENT (owner's rule, Nov 2026): per pool, never images and videos summed into one number,
// and never an overage clamped to 0. Every screen that shows a client's allotment reads it through these.

/** What a pool needs: its cap (null = not set) and what this cycle used. */
export type PoolCounts = { images: number | null; videos: number | null; imagesUsed: number; videosUsed: number };

export type Pool = {
  key: "images" | "videos";
  /** Images or Videos (images and carousels share the image pool) */
  label: string;
  cap: number;
  used: number;
  /** Left this cycle, never below 0 */
  left: number;
  /** Past the cap this cycle (0 when within it) */
  over: number;
  /** over: past the cap; full: exactly at it; ok: room left */
  state: "over" | "full" | "ok";
  /** The line to show, e.g. Images 86/50 · 36 over, or Videos 7/10 */
  text: string;
};

/** A client_allotment_usage row as pool counts. */
export const usageCounts = (r: { images_per_month: number | null; videos_per_month: number | null; images_used: number | null; videos_used: number | null } | null | undefined): PoolCounts | null =>
  r ? { images: r.images_per_month, videos: r.videos_per_month, imagesUsed: r.images_used ?? 0, videosUsed: r.videos_used ?? 0 } : null;

/** One pool's state: what's used against its cap, what's left (never below 0) and how far over (never hidden). */
export function allotmentPool(key: Pool["key"], cap: number, usedRaw: number): Pool {
  const used = Math.max(0, Number(usedRaw) || 0);
  const label = key === "images" ? "Images" : "Videos";
  const over = Math.max(0, used - cap);
  const state = over > 0 ? "over" : used === cap ? "full" : "ok";
  return { key, label, cap, used, left: Math.max(0, cap - used), over, state, text: `${label} ${used}/${cap}${over ? ` · ${over} over` : ""}` };
}

/** The pools to show: each with a cap set and something to say (a cap above 0, or something used against it). */
export function allotmentPools(a: PoolCounts | null | undefined): Pool[] {
  if (!a) return [];
  const pool = (key: Pool["key"], cap: number | null, used: number) => (cap === null || cap === undefined || (cap <= 0 && !(Number(used) > 0)) ? null : allotmentPool(key, cap, used));
  return [pool("images", a.images, a.imagesUsed), pool("videos", a.videos, a.videosUsed)].filter((p): p is Pool => p !== null);
}

/** Every pool on one line, e.g. Images 86/50 · 36 over · Videos 7/10; null when no pool is set. */
export function allotmentLine(a: PoolCounts | null | undefined) {
  const pools = allotmentPools(a);
  return pools.length ? pools.map((p) => p.text).join(" · ") : null;
}

/** Any pool past its cap this cycle. */
export const allotmentOver = (a: PoolCounts | null | undefined) => allotmentPools(a).some((p) => p.over > 0);

/** Theme classes for a pool's state: over in red, exactly at the cap in green (used in full, as planned). Amber is only ever "behind pace". */
export const POOL_TONE: Record<Pool["state"], string> = { over: "text-bad", full: "text-ok", ok: "" };

/** For the AI: one line per pool, with what this request would take if given. */
export function describeAllotment(a: Allotment | null, request?: { images: number; videos: number }) {
  if (!a || (a.images === null && a.videos === null)) return "No monthly allotment is set for this client yet, so you can't check it.";
  const cycle = a.cycle ? ` (this billing cycle, ${untilLabel(a.cycle.start)} to ${untilLabel(a.cycle.end)}, when it resets)` : "";
  const line = (label: string, cap: number | null, used: number, req?: number) =>
    cap === null
      ? `${label}: not set`
      : `${label}: ${cap} per month${cycle}, ${used} used, ${cap - used} left${req !== undefined ? `; this request takes ${req}, leaving ${cap - used - req}` : ""}`;
  const lines = [line("Images and carousels", a.images, a.imagesUsed, request?.images), line("Videos", a.videos, a.videosUsed, request?.videos), `How it counts: ${ALLOTMENT_RULE}`];
  if (a.waiting) lines.push(`Also briefed in Asana and not started yet (they'll count once production starts): ${a.waiting.images} images, ${a.waiting.videos} videos. Treat them as spoken for.`);
  const pi = inProgress(a, "images");
  const pv = inProgress(a, "videos");
  if (pi || pv)
    lines.push(
      `In progress right now (on the board or in Asana, not delivered yet: requested, in production, in review, with the client): ${pi} images and carousel slides, ${pv} videos. Some may already count in "used" above (asked this cycle); the rest are still coming. Before suggesting more, weigh what's already coming: don't overproduce. A request that adds to a pool with a lot in progress needs a reason, and say in why what's in progress.`,
    );
  return lines.join("\n");
}
