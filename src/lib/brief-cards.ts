import { splitLink } from "@/lib/asset-links";
import { folderLink } from "@/lib/client-assets";

// How a brief's lines read on its cards, the same in the PDF and on screen (the lead video editor's brief): a beat's
// time with an en dash ("0:00–0:05"), its source as the quote box's label ("Dan · Source 0:12–0:16"), and an asset line
// as a row of the Assets table (a short label, what it is, its link). Pure: tested in tests/brief-icons.test.ts.

/** Straight quotes made curly ("x" is “x”, it's is it’s) */
export const curly = (x: string) =>
  x
    .replace(/(^|[\s([{])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s([{])'/g, "$1‘")
    .replace(/'/g, "’");

/** A line said or shown on screen, in its curly quotes (kept as they are when it already has them) */
export function quoteLine(x: string) {
  const t = curly(x.trim());
  if (!t) return "";
  return /^[“‘]/.test(t) || /”$/.test(t) ? t : `“${t}”`;
}

/** "0:00-0:05" as "0:00–0:05" */
export const dashTime = (x: string) => x.trim().replace(/\s*-\s*/g, "–");

/** A beat's source as its quote box label: "Dan 0:12-0:16" is "Dan · Source 0:12–0:16" */
export function sourceLabel(source: string) {
  const t = source.trim();
  if (!t) return "Says";
  const m = /^(.*?)[\s,·]*(~?\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?)$/.exec(t);
  if (!m) return `Source · ${t}`;
  return m[1].trim() ? `${m[1].trim()} · Source ${dashTime(m[2])}` : `Source ${dashTime(m[2])}`;
}

/** An asset line as a row: a short label ("Dan interview"), what it is ("Full interview video"), its link, and Need */
export function assetRow(line: string) {
  const { text, url } = splitLink(line);
  const need = /^(Need|Client to shoot|Missing):\s*/i.exec(text);
  const rest = need ? text.slice(need[0].length) : text;
  // "Label (Drive: path), what it is", "Label: what it is", "Label - what it is" or just "Label"
  const m = /^([^,(:]{2,60}?)\s*(?:\(([^)]*)\))?\s*(?:,\s+|\s+-\s+|:\s+|$)(.*)$/.exec(rest);
  let label = (m?.[1] ?? rest).trim();
  let what = (m?.[3] ?? "").trim();
  // Something we still need reads "NEED | Seat views without dates or scoreboards"
  if (need) [label, what] = [need[1], what ? `${label}, ${what}` : label];
  return { label, what: what ? what[0].toUpperCase() + what.slice(1) : "", url, need: need ? need[1] : null };
}

/** The client's Drive on every brief: the headquarters folder (everything they shared) and the Ad Creatives folder */
export type ClientDrive = { headquarters: string | null; adCreatives: string | null };

/** The two links from the client's folder ids (a missing or malformed id gives no link) */
export function clientDriveOf(c: { drive_folder_id?: string | null; ad_creative_folder_id?: string | null } | null | undefined): ClientDrive {
  return { headquarters: folderLink(c?.drive_folder_id), adCreatives: folderLink(c?.ad_creative_folder_id) };
}

/** The Assets section's first rows, "Open in Drive" each, skipping a folder the client doesn't have */
export function driveRows(d: ClientDrive | null | undefined): { label: string; what: string; url: string }[] {
  const rows: { label: string; what: string; url: string | null }[] = [
    { label: "Client Drive (headquarters)", what: "Everything the client has shared", url: d?.headquarters ?? null },
    { label: "Ad Creatives folder", what: "Every ad made for the client", url: d?.adCreatives ?? null },
  ];
  return rows.filter((r): r is { label: string; what: string; url: string } => Boolean(r.url));
}

/** A step smaller for long text, so a field is shown in full rather than cut (base size, then one or two steps down) */
export function fitSize(text: string, base: number, roomy: number, step = 0.8) {
  const n = text.trim().length;
  return n <= roomy ? base : n <= roomy * 1.6 ? base - step : base - step * 2;
}
