// Over the allotment, on purpose (owner, Nov 19 2026): a client already at or past its cap gets no drafted briefs, but
// anyone can still brief them for a reason of their own. Then the request says so plainly: how far over the client is
// this cycle, what this request adds, and who pushed it through and why. Pure (tested in tests/allotment-over.test.ts);
// the request form, the request actions, the drafter and the AI brief tools all read the same lines.

import { draws, type FormatCounts } from "@/lib/allotment";

export type Pool = "images" | "videos";
export type OverLine = { pool: Pool; cap: number; used: number; adds: number; after: number; over: number; already: boolean };
type Usage = { images: number | null; videos: number | null; imagesUsed: number; videosUsed: number };

const WORD: Record<Pool, [string, string]> = { images: ["image", "images"], videos: ["video", "videos"] };
const w = (pool: Pool, n: number) => WORD[pool][n === 1 ? 0 : 1];

/** Where a pool stands this cycle: over its cap, exactly at it (covered), or with room */
export function poolState(cap: number | null, used: number): "none" | "room" | "covered" | "over" {
  if (!cap) return "none";
  return used > cap ? "over" : used === cap ? "covered" : "room";
}

/** Whether the drafter should leave a client alone: every pool it has a cap on is used up (covered or over) */
export function allotmentFull(u: Usage): boolean {
  const pools = (["images", "videos"] as Pool[]).filter((p) => (p === "images" ? u.images : u.videos));
  return pools.length > 0 && pools.every((p) => (p === "images" ? u.imagesUsed : u.videosUsed) >= ((p === "images" ? u.images : u.videos) ?? 0));
}

/** The pools this request takes over the cap (or that are already over and it adds to), with the numbers */
export function overAllotment(u: Usage | null | undefined, formats: Partial<Record<"image" | "video" | "carousel", FormatCounts>> | null): OverLine[] {
  if (!u) return [];
  const adds = formats ? draws(formats) : { images: 0, videos: 0 };
  const out: OverLine[] = [];
  for (const pool of ["images", "videos"] as Pool[]) {
    const cap = (pool === "images" ? u.images : u.videos) ?? 0;
    if (!cap) continue;
    const used = pool === "images" ? u.imagesUsed : u.videosUsed;
    const add = adds[pool];
    const after = used + add;
    // Over now, or this request takes it over; a pool this request doesn't touch only counts when already over
    if (after > cap && (add > 0 || used > cap)) out.push({ pool, cap, used, adds: add, after, over: after - cap, already: used >= cap });
  }
  return out;
}

/** "34 of 25 images this cycle, this adds 4 more (13 over)" */
export function overText(l: OverLine): string {
  const base = `${l.used} of ${l.cap} ${w(l.pool, l.cap)} this cycle`;
  return l.adds > 0 ? `${base}, this adds ${l.adds} more (${l.after - l.cap} over)` : `${base} (${l.used - l.cap} over already)`;
}

/** The disclaimer, in one line: "Over allotment: 34 of 25 images this cycle, this adds 4 more (13 over)" */
export function overDisclaimer(lines: readonly OverLine[]): string | null {
  return lines.length ? `Over allotment: ${lines.map(overText).join("; ")}` : null;
}

/** What goes at the top of the brief, the ticket and the Asana task when someone pushes it through anyway */
export function overNote(lines: readonly OverLine[], by: string, reason: string | null | undefined): string | null {
  const d = overDisclaimer(lines);
  if (!d) return null;
  return `${d}. Pushed through by ${by}${reason?.trim() ? `: ${reason.trim().slice(0, 300)}` : " (no reason given)"}.`;
}

/** Why a client's card has no drafted briefs: "No briefs suggested: over the allotment by 9 images this cycle (34 of 25)" */
export function noBriefsWhy(pools: readonly { pool: Pool; cap: number; used: number }[]): string | null {
  const over = pools.filter((p) => p.cap > 0 && p.used >= p.cap);
  if (!over.length || over.length !== pools.filter((p) => p.cap > 0).length) return null;
  const parts = over.map((p) => (p.used > p.cap ? `over the allotment by ${p.used - p.cap} ${w(p.pool, p.used - p.cap)} this cycle (${p.used} of ${p.cap})` : `the ${w(p.pool, 2)} allotment is fully briefed (${p.used} of ${p.cap})`));
  return `No briefs suggested: ${parts.join(", and ")}`;
}
