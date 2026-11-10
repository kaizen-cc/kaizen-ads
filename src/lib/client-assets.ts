import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogFile } from "@/lib/asset-links";

// What a client has on Drive to make creative from (photos, video, design files), catalogued by the Drive sync. The
// strategist reads it before writing a brief, so a concept is made from what we have, and what we don't have is asked
// of the client (a shot list). Each file comes with its Drive link (and its folder's, once the sync has stored the
// folder), so every asset a brief lists can be opened from the ticket, Ready to send and the PDF (src/lib/asset-links.ts).

export type AssetSummary = {
  total: number;
  byKind: Record<"image" | "video" | "design" | "other", number>;
  folders: { folder: string; images: number; videos: number; latest: string | null }[];
  recent: { name: string; kind: string; folder: string | null; at: string | null; url: string | null }[];
  /** A few files from each folder (the newest), so a brief can name a specific file rather than a whole folder */
  byFolder: { folder: string; files: { name: string; kind: string; at: string | null }[] }[];
  newest: string | null; // when the latest raw asset landed
  /** Every file with its links, to put the link on each asset a brief names */
  catalog: CatalogFile[];
};

type Row = { name: string; kind: string; folder: string | null; url: string | null; created_at: string | null; folder_id?: string | null };

/** The rows, with the folder's id when the column is there (it's added by a migration; older databases read without it) */
async function rows(db: SupabaseClient, clientId: string): Promise<Row[]> {
  const q = (cols: string) => db.from("client_assets").select(cols).eq("client_id", clientId).order("created_at", { ascending: false }).limit(3000);
  const withFolder = await q("name, kind, folder, url, created_at, folder_id");
  if (!withFolder.error) return (withFolder.data ?? []) as unknown as Row[];
  const { data } = await q("name, kind, folder, url, created_at");
  return (data ?? []) as unknown as Row[];
}

export const folderLink = (id: string | null | undefined) => (id && /^[\w-]{10,}$/.test(id) ? `https://drive.google.com/drive/folders/${id}` : null);

export async function loadAssets(db: SupabaseClient, clientId: string): Promise<AssetSummary> {
  const all = await rows(db, clientId);
  const byKind = { image: 0, video: 0, design: 0, other: 0 };
  const folders = new Map<string, { folder: string; images: number; videos: number; latest: string | null }>();
  const files = new Map<string, Row[]>();
  for (const r of all) {
    byKind[r.kind as keyof typeof byKind]++;
    const key = r.folder ?? "(top level)";
    const f = folders.get(key) ?? { folder: key, images: 0, videos: 0, latest: null };
    if (r.kind === "image") f.images++;
    if (r.kind === "video") f.videos++;
    if (!f.latest || (r.created_at && r.created_at > f.latest)) f.latest = r.created_at;
    folders.set(key, f);
    const list = files.get(key) ?? [];
    if (list.length < 6) list.push(r);
    files.set(key, list);
  }
  const top = [...folders.values()].sort((a, b) => b.images + b.videos - (a.images + a.videos)).slice(0, 25);
  return {
    total: all.length,
    byKind,
    folders: top,
    recent: all.slice(0, 40).map((r) => ({ name: r.name, kind: r.kind, folder: r.folder, at: r.created_at, url: r.url })),
    byFolder: top.slice(0, 14).map((f) => ({ folder: f.folder, files: (files.get(f.folder) ?? []).map((r) => ({ name: r.name, kind: r.kind, at: r.created_at })) })),
    newest: all[0]?.created_at ?? null,
    catalog: all.map((r) => ({ name: r.name, kind: r.kind, folder: r.folder, url: r.url, folderUrl: folderLink(r.folder_id) })),
  };
}

/** The catalogue alone, for linking a brief's assets after it's written */
export async function loadCatalog(db: SupabaseClient, clientId: string): Promise<CatalogFile[]> {
  return (await loadAssets(db, clientId).catch(() => null))?.catalog ?? [];
}

/** Nothing new on Drive in 45 days (or nothing at all): time to ask the client for fresh footage. */
export const assetsStale = (newest: string | null) => !newest || Date.parse(newest) < Date.now() - 45 * 86_400_000;

/** The assets on Drive as lines for a prompt. */
export function assetsBlock(a: AssetSummary) {
  if (!a.total) return "<assets_on_drive>\nNothing catalogued on Drive for this client yet (no folder linked, or it's empty). Assume we have no raw photos or footage: plan for stock, graphic design, or assets requested from the client.\n</assets_on_drive>";
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
  const listed = new Set<string>();
  const recent = (a.recent ?? []).filter((r) => {
    const k = `${r.folder ?? ""}/${r.name}`;
    return !(a.byFolder ?? []).some((f) => f.folder === (r.folder ?? "(top level)") && f.files.some((x) => x.name === r.name)) && !listed.has(k) && Boolean(listed.add(k));
  });
  return [
    "<assets_on_drive>",
    `${a.byKind.image} photos/images, ${a.byKind.video} videos, ${a.byKind.design} design files. Newest raw asset: ${day(a.newest)}.`,
    "Name an asset exactly as written here (file name, or folder path) so its link can be added; only what's listed is known about each file (its name, folder and date), so list it only when that clearly fits the angle.",
    "By folder (counts, then the newest files in it):",
    ...a.folders.map((f) => {
      const files = (a.byFolder ?? []).find((x) => x.folder === f.folder)?.files ?? [];
      return [`- ${f.folder}: ${f.images} images, ${f.videos} videos (latest ${day(f.latest)})`, ...files.map((x) => `  · [${x.kind}] ${x.name} (${day(x.at)})`)].join("\n");
    }),
    ...(recent.length ? ["Other recent files:", ...recent.slice(0, 20).map((r) => `- [${r.kind}] ${r.folder ? `${r.folder} / ` : ""}${r.name} (${day(r.at)})`)] : []),
    "</assets_on_drive>",
  ].join("\n");
}
