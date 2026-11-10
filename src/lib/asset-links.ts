import { composeBrief, parseBrief, type SpecAsset } from "./brief-spec";

// Every asset a brief lists carries its Drive link (the lead video editor's feedback, Nov 10 2026: "Dan Interview,
// Mar 2025" with nothing to click). The writers name assets exactly as the Drive catalogue lists them (file names,
// folder paths); this finds the file (or, failing that, the folder) each "Have" line names and puts its link at the
// end of the line, where the brief check, the ticket, Ready to send and the PDF read it. A line that names nothing in
// the catalogue gets no link: never a guess. Pure: tested in tests/asset-links.test.ts.

/** One file in the client's Drive catalogue (client_assets), with its folder's link when the sync knows it */
export type CatalogFile = { name: string; kind: string; folder: string | null; url: string | null; folderUrl: string | null };

const LINK = /https?:\/\/[^\s<>"')]+/;

/** Words only: no extension, no punctuation, lower case ("Dan_Interview-Mar2025.MP4" is "dan interview mar2025") */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Folder names too generic to stand for a specific folder on their own */
const GENERIC = new Set(["photos", "photo", "videos", "video", "images", "image", "raw", "footage", "assets", "files", "media", "content", "misc", "other", "new", "old", "final", "finals", "drive", "uploads", "client uploads", "b roll", "broll"]);

/** A line's text and the link at its end (or anywhere in it) */
export function splitLink(line: string): { text: string; url: string | null } {
  const m = LINK.exec(line);
  if (!m) return { text: line.trim(), url: null };
  const url = m[0].replace(/[.,;:!?]+$/, "");
  return { text: line.replace(m[0], " ").replace(/\s+([,.;:])/g, "$1").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim().replace(/[\s,;:-]+$/, ""), url };
}

const has = (hay: string, needle: string) => needle.length >= 4 && ` ${hay} `.includes(` ${needle} `);

/**
 * The Drive link for an asset line: the file it names (the longest name that appears in it), or else the folder it
 * names ("(Drive: Interviews / Dan)", or a specific folder's own name). Null when it names nothing in the catalogue.
 */
export function linkFor(item: string, files: CatalogFile[]): string | null {
  const t = normName(splitLink(item).text);
  if (!t) return null;
  let best: { url: string; len: number } | null = null;
  for (const f of files) {
    if (!f.url) continue;
    const n = normName(f.name);
    // A short name ("IMG 1", "logo") is too loose to match on
    if (n.length < 6) continue;
    if (has(t, n) && (!best || n.length > best.len)) best = { url: f.url, len: n.length };
  }
  if (best) return best.url;
  // The folder: its whole path, or its last part when that's specific enough
  const drive = /\bdrive\s*:\s*([^)\n]+)/i.exec(item)?.[1] ?? "";
  const named = normName(drive);
  let folder: { url: string; len: number } | null = null;
  for (const f of files) {
    if (!f.folder || !f.folderUrl) continue;
    const path = normName(f.folder);
    const last = normName(f.folder.split("/").pop() ?? "");
    const hit = (named && (named === path || named === last || has(named, path))) || (!GENERIC.has(path) && path.includes(" ") && has(t, path)) || (!GENERIC.has(last) && last.includes(" ") && has(t, last));
    if (hit && (!folder || path.length > folder.len)) folder = { url: f.folderUrl, len: path.length };
  }
  return folder?.url ?? null;
}

/** The "Have" assets with their Drive link added at the end of the line (a line that has one keeps it) */
export function linkAssetItems(assets: SpecAsset[], files: CatalogFile[]): SpecAsset[] {
  if (!files.length) return assets;
  return assets.map((a) => {
    if (a.status !== "have" || LINK.test(a.item)) return a;
    const url = linkFor(a.item, files);
    return url ? { ...a, item: `${a.item} ${url}` } : a;
  });
}

/** Strings ("Dan interview, Mar 2025 (Drive: Interviews)") with their links added, for draft.assets.have */
export const linkHaveLines = (lines: string[], files: CatalogFile[]) => linkAssetItems(lines.map((item) => ({ item, status: "have" as const })), files).map((a) => a.item);

/** A brief's Assets section with each "Have" line linked; a brief that doesn't read as sections (or needs none) stays as it is */
export function linkBriefAssets(brief: string, files: CatalogFile[]): string {
  if (!files.length || !brief.trim()) return brief;
  try {
    const p = parseBrief(brief);
    if (!p.structured || !p.spec.assets.length) return brief;
    const assets = linkAssetItems(p.spec.assets, files);
    if (assets.every((a, i) => a.item === p.spec.assets[i].item)) return brief;
    return composeBrief(p.overview, { ...p.spec, assets });
  } catch {
    return brief;
  }
}

const SIG = (s: string) => normName(s).split(" ").filter((w) => w.length > 3);

/**
 * A short line about an asset (the PDF's, restructured by the AI) given the link of the brief's own asset line it
 * describes, when it lost it: the brief line sharing the most words, at least two.
 */
export function attachLinks(lines: string[], briefAssets: SpecAsset[]): string[] {
  const linked = briefAssets.map((a) => splitLink(a.item)).filter((x): x is { text: string; url: string } => Boolean(x.url));
  if (!linked.length) return lines;
  return lines.map((l) => {
    if (LINK.test(l)) return l;
    const w = new Set(SIG(l));
    let best: { url: string; n: number } | null = null;
    for (const a of linked) {
      const n = SIG(a.text).filter((x) => w.has(x)).length;
      if (n >= 2 && (!best || n > best.n)) best = { url: a.url, n };
    }
    return best ? `${l} ${best.url}` : l;
  });
}

/** What a link opens, in two words ("Open file", "Open folder") */
export const linkWord = (url: string) => (/\/folders\//.test(url) ? "Open folder" : /drive\.google\.com|docs\.google\.com/.test(url) ? "Open in Drive" : "Open link");
