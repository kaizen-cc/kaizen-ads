// The creative leads (the Head of Creative, the lead graphic designer and the lead video editor). Their own words, Nov 20
// 2026: the Overview had too many layers and metrics. Their primary Overview is only the team's KPIs, the design
// allotment and video production, allotments up front. The copy library, verticals, tiring-ads replacement metrics and
// winners stay reachable under Ideas, never on the primary Overview.

export type CreativePool = "images" | "videos";

export const isCreativeLead = (role: string | null | undefined) => role === "head_of_creative" || role === "lead_graphic_designer" || role === "lead_video_editor";

/** The pools a creative lead watches first: design for the lead graphic designer, video for the lead video editor, both for the head */
export function leadPools(role: string | null | undefined): CreativePool[] {
  if (role === "lead_graphic_designer") return ["images"];
  if (role === "lead_video_editor") return ["videos"];
  return ["images", "videos"];
}

/** Where the things taken off their Overview live now */
export const MOVED_TO_IDEAS = [
  { label: "Winners", href: "/winners" },
  { label: "Tiring ads", href: "/board?view=kpis&ads=1#tiring" },
  { label: "Ideas", href: "/ideas" },
] as const;

type Pooled = { images: number | null; videos: number | null; imagesUsed: number; videosUsed: number };

/** One pool across every client: what's used of what's promised, and how many clients are behind where they should be by now */
export function poolTotals(rows: { counts: Pooled; elapsed: number; status?: string }[], pool: CreativePool) {
  let cap = 0;
  let used = 0;
  let behind = 0;
  let clients = 0;
  for (const r of rows) {
    const c = pool === "images" ? r.counts.images : r.counts.videos;
    const u = pool === "images" ? r.counts.imagesUsed : r.counts.videosUsed;
    if (!c || c <= 0) continue;
    clients++;
    cap += c;
    used += u;
    if (u < Math.floor(c * Math.min(1, Math.max(0, r.elapsed)))) behind++;
  }
  return { cap, used, behind, clients };
}
