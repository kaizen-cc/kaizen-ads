import type { SupabaseClient } from "@supabase/supabase-js";

// What a client has on Drive to make creative from (photos, video, design files), catalogued by the Drive sync. The
// strategist reads it before writing a brief, so a concept is made from what we have, and what we don't have is asked
// of the client (a shot list).

export type AssetSummary = {
  total: number;
  byKind: Record<"image" | "video" | "design" | "other", number>;
  folders: { folder: string; images: number; videos: number; latest: string | null }[];
  recent: { name: string; kind: string; folder: string | null; at: string | null; url: string | null }[];
  newest: string | null; // when the latest raw asset landed
};

export async function loadAssets(db: SupabaseClient, clientId: string): Promise<AssetSummary> {
  const { data } = await db.from("client_assets").select("name, kind, folder, url, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3000);
  const rows = data ?? [];
  const byKind = { image: 0, video: 0, design: 0, other: 0 };
  const folders = new Map<string, { folder: string; images: number; videos: number; latest: string | null }>();
  for (const r of rows) {
    byKind[r.kind as keyof typeof byKind]++;
    const key = r.folder ?? "(top level)";
    const f = folders.get(key) ?? { folder: key, images: 0, videos: 0, latest: null };
    if (r.kind === "image") f.images++;
    if (r.kind === "video") f.videos++;
    if (!f.latest || (r.created_at && r.created_at > f.latest)) f.latest = r.created_at;
    folders.set(key, f);
  }
  return {
    total: rows.length,
    byKind,
    folders: [...folders.values()].sort((a, b) => b.images + b.videos - (a.images + a.videos)).slice(0, 25),
    recent: rows.slice(0, 40).map((r) => ({ name: r.name, kind: r.kind, folder: r.folder, at: r.created_at, url: r.url })),
    newest: rows[0]?.created_at ?? null,
  };
}

/** Nothing new on Drive in 45 days (or nothing at all): time to ask the client for fresh footage. */
export const assetsStale = (newest: string | null) => !newest || Date.parse(newest) < Date.now() - 45 * 86_400_000;

/** The assets on Drive as lines for a prompt. */
export function assetsBlock(a: AssetSummary) {
  if (!a.total) return "<assets_on_drive>\nNothing catalogued on Drive for this client yet (no folder linked, or it's empty). Assume we have no raw photos or footage: plan for stock, graphic design, or assets requested from the client.\n</assets_on_drive>";
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
  return [
    "<assets_on_drive>",
    `${a.byKind.image} photos/images, ${a.byKind.video} videos, ${a.byKind.design} design files. Newest raw asset: ${day(a.newest)}.`,
    "By folder:",
    ...a.folders.map((f) => `- ${f.folder}: ${f.images} images, ${f.videos} videos (latest ${day(f.latest)})`),
    "Most recent files:",
    ...a.recent.map((r) => `- [${r.kind}] ${r.folder ? `${r.folder} / ` : ""}${r.name} (${day(r.at)})`),
    "</assets_on_drive>",
  ].join("\n");
}
