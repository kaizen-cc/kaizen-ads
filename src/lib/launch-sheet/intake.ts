import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pdfLayout } from "./pdf-layout";
import { pdfToGrid } from "./grid";
import { csvToGrid, xlsxToGrid } from "./xlsx";
import { looksLikeLaunchSheet } from "./sheet";
import type { Cell, Grid } from "./types";

// Opening a launch sheet wherever it was shared: a file in the client's documents (client page chat) or in Kaizen AI's
// files, a Google Sheets link (read with the Sheets API: values, links and cell colors), or a Drive link to a PDF or
// Excel file. The PDF itself is kept for the model too, which sees each page as a picture (colors, layout) next to
// the text, links and colors read here.

export type SheetSource =
  | { kind: "file"; bucket: string; path: string; name: string; mime: string; docId?: string | null }
  | { kind: "link"; url: string; name: string; docId?: string | null };

export type Opened = { grid: Grid | null; pdf: string | null; name: string; note: string | null };

const MAX_PDF = 20_000_000;
const extOf = (name: string) => name.toLowerCase().split(/[?#]/)[0].split(".").pop() ?? "";

/** A file's bytes into a grid (and the PDF kept for the model) */
export async function openBytes(buf: Buffer, name: string, mime: string): Promise<Opened> {
  const ext = extOf(name);
  if (mime === "application/pdf" || ext === "pdf") {
    const grid = pdfToGrid(await pdfLayout(new Uint8Array(buf)));
    return { grid, pdf: buf.length <= MAX_PDF ? buf.toString("base64") : null, name, note: buf.length > MAX_PDF ? "The PDF is too big to show the model as pages; read from its text, links and colors." : null };
  }
  if (ext === "xlsx" || ext === "xlsm" || /spreadsheetml/.test(mime)) return { grid: xlsxToGrid(buf), pdf: null, name, note: null };
  if (["csv", "tsv", "txt"].includes(ext) || /^text\//.test(mime)) return { grid: csvToGrid(buf.toString("utf8")), pdf: null, name, note: null };
  return { grid: null, pdf: null, name, note: `${name} isn't a PDF, Excel, CSV or Google Sheet.` };
}

const SHEET_URL = /docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})/;
const DRIVE_FILE = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/;
export const isSheetLink = (u: string) => SHEET_URL.test(u) || DRIVE_FILE.test(u);

type GsCell = { formattedValue?: string; hyperlink?: string; effectiveFormat?: { backgroundColor?: { red?: number; green?: number; blue?: number } }; textFormatRuns?: { format?: { link?: { uri?: string } } }[] };
type GsSheet = { properties: { title: string; sheetId: number }; data?: { rowData?: { values?: GsCell[] }[] }[] };

const toHex = (c?: { red?: number; green?: number; blue?: number }) => {
  if (!c) return null;
  const [r, g, b] = [c.red ?? 0, c.green ?? 0, c.blue ?? 0].map((x) => Math.round(x * 255));
  if (r > 245 && g > 245 && b > 245) return null;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
};

/** A Google Sheet with its links and colors (the tab named in the link's gid, else the one that reads like a launch table) */
async function openGoogleSheet(id: string, gid: string | null): Promise<Opened> {
  const { driveToken } = await import("@/lib/context/google");
  const token = await driveToken();
  const fields = "properties.title,sheets(properties(title,sheetId),data(rowData(values(formattedValue,hyperlink,effectiveFormat.backgroundColor,textFormatRuns.format.link.uri))))";
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?includeGridData=true&fields=${encodeURIComponent(fields)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 404 ? "Kaizen's Google account can't open this sheet: share it with the agency's Google Workspace (or anyone with the link)." : `Google Sheets: ${res.status}`);
  const body = (await res.json()) as { properties?: { title?: string }; sheets?: GsSheet[] };
  const grids = (body.sheets ?? []).map((s) => {
    const rows: Cell[][] = (s.data?.[0]?.rowData ?? []).map((r) =>
      (r.values ?? []).map((v) => ({
        text: (v.formattedValue ?? "").trim(),
        links: [...new Set([v.hyperlink, ...(v.textFormatRuns ?? []).map((x) => x.format?.link?.uri)].filter((x): x is string => Boolean(x)))],
        color: toHex(v.effectiveFormat?.backgroundColor),
      })),
    );
    return { sheet: s, grid: { rows: rows.filter((r) => r.some((c) => c.text || c.links.length)), source: "gsheet" as const } };
  });
  const pick = grids.find((g) => gid != null && String(g.sheet.properties.sheetId) === gid) ?? grids.find((g) => looksLikeLaunchSheet(g.grid)) ?? grids[0];
  return { grid: pick?.grid ?? null, pdf: null, name: `${body.properties?.title ?? "Google Sheet"}${pick ? ` · ${pick.sheet.properties.title}` : ""}`, note: null };
}

/** A Drive file by id (PDF, Excel or CSV, or a Google Sheet) */
async function openDriveFile(id: string): Promise<Opened> {
  const { driveToken } = await import("@/lib/context/google");
  const token = await driveToken();
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!meta.ok) throw new Error("Kaizen's Google account can't open this file: share it with the agency's Google Workspace (or anyone with the link).");
  const f = (await meta.json()) as { name: string; mimeType: string };
  if (f.mimeType === "application/vnd.google-apps.spreadsheet") return openGoogleSheet(id, null);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive: ${res.status}`);
  return openBytes(Buffer.from(await res.arrayBuffer()), f.name, f.mimeType);
}

/** Opens a launch sheet from where it was shared */
export async function openSource(admin: SupabaseClient, src: SheetSource): Promise<Opened> {
  if (src.kind === "file") {
    const { data, error } = await admin.storage.from(src.bucket).download(src.path);
    if (error || !data) throw new Error("The file isn't there any more.");
    return openBytes(Buffer.from(await data.arrayBuffer()), src.name, src.mime);
  }
  const sheet = src.url.match(SHEET_URL);
  if (sheet) return openGoogleSheet(sheet[1], src.url.match(/[#&?]gid=(\d+)/)?.[1] ?? null);
  const file = src.url.match(DRIVE_FILE);
  if (file) return openDriveFile(file[1]);
  throw new Error("That link isn't a Google Sheet or a Drive file.");
}

/** Is this shared file or link a launch sheet? (opened and checked for a table of ads; false when it can't be read) */
export async function isLaunchSheet(admin: SupabaseClient, src: SheetSource): Promise<boolean> {
  if (src.kind === "file" && !/pdf|sheet|excel|csv|text/.test(src.mime) && !/\.(pdf|xlsx|xlsm|csv|tsv)$/i.test(src.name)) return false;
  if (src.kind === "link" && !isSheetLink(src.url)) return false;
  try {
    const o = await openSource(admin, src);
    return Boolean(o.grid && looksLikeLaunchSheet(o.grid));
  } catch {
    return false;
  }
}
