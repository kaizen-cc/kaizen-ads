// Browser-side helpers for creative uploads: read size and length, make a thumbnail, group files into designs.
// Everything here runs on the creative's machine before the upload starts, so the server never processes media.

import type { Format } from "@/lib/stages";

export type Probe = { width: number | null; height: number | null; durationMs: number | null; thumb: Blob | null };

const KNOWN: [string, number][] = [
  ["1x1", 1],
  ["4x5", 4 / 5],
  ["9x16", 9 / 16],
  ["16x9", 16 / 9],
  ["2x3", 2 / 3],
  ["191x100", 1.91],
];

/** 1080×1350 → "4x5". Anything that isn't a standard ratio keeps its pixel size. */
export function aspectOf(width: number | null, height: number | null) {
  if (!width || !height) return null;
  const r = width / height;
  const hit = KNOWN.find(([, k]) => Math.abs(r - k) / k < 0.03);
  return hit ? hit[0] : `${width}x${height}`;
}

/** "4x5" → "4:5", "191x100" → "1.91:1", a pixel size stays "1200×628". */
export const aspectLabel = (a: string | null) =>
  !a ? "—" : a === "191x100" ? "1.91:1" : KNOWN.some(([k]) => k === a) ? a.replace("x", ":") : a.replace("x", "×");

const THUMB = 640;

function canvasThumb(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, THUMB / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
}

export async function probe(file: File): Promise<Probe> {
  try {
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const thumb = await canvasThumb(bmp, bmp.width, bmp.height);
      const out = { width: bmp.width, height: bmp.height, durationMs: null, thumb };
      bmp.close();
      return out;
    }
    if (file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.src = url;
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("unreadable video"));
        });
        // A frame a moment in, so the poster isn't a black first frame
        video.currentTime = Math.min(1, video.duration / 3 || 0);
        await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
        const thumb = await canvasThumb(video, video.videoWidth, video.videoHeight);
        return { width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(video.duration * 1000), thumb };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    // Formats the browser can't preview (e.g. some .mov or .psd) still upload, just without a thumbnail
  }
  return { width: null, height: null, durationMs: null, thumb: null };
}

// ─── Grouping ───────────────────────────────────────────────────────────────

export type Picked = { file: File; folder: string | null }; // folder: the top folder it was dropped in, if any

export type StagedFile = Picked & Probe & { id: string; aspect: string | null; preview: string | null }; // preview: a local URL for the thumbnail
export type StagedDesign = { key: string; name: string; files: StagedFile[]; variationOf: string | null };

// Size words people put in file names: "calzone_9x16.mp4", "Calzone - Story.png", "calzone-1080x1350.jpg"
const SIZE_TOKENS = /(?:^|[\s_\-.()[\]])(?:\d{1,2}x\d{1,2}|\d{3,4}x\d{3,4}|square|feed|story|stories|reel|reels|vertical|portrait|landscape|sq|vert)(?=$|[\s_\-.()[\]])/gi;

const base = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
const tidy = (s: string) =>
  s
    .replace(SIZE_TOKENS, " ")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Sizes of one idea become one design: files are grouped by their name without size words,
 * or by their folder when the name is only a size. A carousel is one design per folder, cards in name order.
 */
export function groupFiles(files: StagedFile[], format: Format): StagedDesign[] {
  const groups = new Map<string, StagedFile[]>();
  for (const f of files) {
    const stem = tidy(base(f.file.name)).toLowerCase();
    const key = format === "carousel" ? (f.folder ?? "carousel") : stem || f.folder?.toLowerCase() || base(f.file.name).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups].map(([key, list], i) => {
    const sorted = list.slice().sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
    const stem = format === "carousel" ? (sorted[0].folder ?? "") : tidy(base(sorted[0].file.name)) || sorted[0].folder || "";
    return { key, name: title(stem) || `Design ${i + 1}`, files: sorted, variationOf: null };
  });
}

/** Files and folders from a drop. Folders are read recursively; the top folder name is kept for grouping. */
export async function filesFromDrop(items: DataTransferItemList): Promise<Picked[]> {
  const out: Picked[] = [];
  const read = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve) => {
      const reader = dir.createReader();
      const all: FileSystemEntry[] = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), () => resolve(all));
      next();
    });
  const walk = async (entry: FileSystemEntry, top: string | null): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      if (!file.name.startsWith(".")) out.push({ file, folder: top });
    } else if (entry.isDirectory) {
      for (const child of await read(entry as FileSystemDirectoryEntry)) await walk(child, top ?? entry.name);
    }
  };
  const list = [...items];
  const entries = list.map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) {
    // Browsers without folder access on drop still give plain files
    return list.map((i) => i.getAsFile()).filter((f): f is File => Boolean(f)).map((file) => ({ file, folder: null }));
  }
  for (const e of entries) await walk(e, null);
  return out;
}

export const isMedia = (f: File) => f.type.startsWith("image/") || f.type.startsWith("video/") || /\.(psd|ai|pdf|mov|mp4|m4v|webm|png|jpe?g|gif|webp|heic)$/i.test(f.name);

/** Storage-safe file name that still reads like the original. */
export const safeName = (name: string) => name.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(-120);
