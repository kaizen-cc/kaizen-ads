import { inflateRawSync } from "node:zlib";
import type { Cell, Grid } from "./types";

// An Excel file (or a Google Sheet downloaded as one) read natively: every cell's shown text, its hyperlink (the
// sheet's hyperlinks list or a HYPERLINK formula) and its background fill, the first sheet that holds a table. And a
// CSV, which has only the text.

/** The files inside a zip, by name (only those `want` accepts) */
export function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try {
      out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    } catch {
      // A part that won't open is skipped
    }
  }
  return out;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
/** All the <t> text inside an element (rich text runs included), phonetic runs left out */
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");

/** "E12" → [row 11, col 4] */
export function cellRef(ref: string): [number, number] {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return [-1, -1];
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}
/** Every cell in a range ("E12:G14") */
function rangeCells(ref: string): [number, number][] {
  const [a, b] = ref.split(":");
  const [r0, c0] = cellRef(a);
  const [r1, c1] = b ? cellRef(b) : [r0, c0];
  const out: [number, number][] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([r, c]);
  return out;
}

const INDEXED: Record<number, string> = { 2: "#ff0000", 3: "#00ff00", 4: "#0000ff", 5: "#ffff00", 10: "#ff0000", 11: "#00ff00", 12: "#0000ff", 13: "#ffff00", 17: "#008000", 50: "#99cc00", 51: "#ffcc00", 52: "#ff9900", 53: "#ff6600" };

/** The fill color of each cell style (cellXfs index → "#rrggbb" or null) */
function styleFills(styles: string | undefined): (string | null)[] {
  if (!styles) return [];
  const fills = [...(styles.match(/<fills\b[\s\S]*?<\/fills>/)?.[0] ?? "").matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((m) => {
    const fg = m[1].match(/<fgColor\b[^>]*\/?>/)?.[0] ?? "";
    if (!/patternType="solid"/.test(m[1])) return null;
    const rgb = attr(fg, "rgb");
    if (rgb) return `#${rgb.slice(-6).toLowerCase()}`;
    const ix = attr(fg, "indexed");
    if (ix && INDEXED[Number(ix)]) return INDEXED[Number(ix)];
    return null;
  });
  const xfs = styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? "";
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], "fillId") ?? 0);
    const c = fills[id] ?? null;
    return c === "#ffffff" ? null : c;
  });
}

/** The first sheet of an XLSX with a table, as a grid (null when it isn't an Excel file) */
export function xlsxToGrid(buf: Buffer, sheetName?: string): Grid | null {
  const parts = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/(_rels\/)?sheet\d+\.xml(\.rels)?)$/.test(n));
  const wb = parts.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) return null;
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const shared = [...(parts.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const fillOf = styleFills(parts.get("xl/styles.xml")?.toString("utf8"));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const rid = attr(m[0], "r:id");
    const target = rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1];
    return { name: unescape(attr(m[0], "name") ?? ""), path: target ? `xl/${target.replace(/^\/?xl\//, "")}` : null };
  });
  const order = sheetName ? [...sheets.filter((s) => s.name === sheetName), ...sheets.filter((s) => s.name !== sheetName)] : sheets;
  let best: Grid | null = null;
  for (const s of order) {
    if (!s.path) continue;
    const xml = parts.get(s.path)?.toString("utf8");
    if (!xml) continue;
    const grid = sheetGrid(xml, shared, fillOf, parts.get(s.path.replace(/worksheets\//, "worksheets/_rels/") + ".rels")?.toString("utf8") ?? "");
    if (!best || grid.rows.length > best.rows.length) best = grid;
    // The first sheet that reads like a launch table wins
    if (grid.rows.some((r) => r.filter((c) => /headline|primary text|creative/i.test(c.text)).length >= 2)) return grid;
  }
  return best;
}

/** Every sheet of an XLSX that holds something, with its tab name (a Google buyer's file is often one tab per ad group) */
export function xlsxTabs(buf: Buffer): { title: string; grid: Grid }[] {
  const parts = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/(_rels\/)?sheet\d+\.xml(\.rels)?)$/.test(n));
  const wb = parts.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) return [];
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const shared = [...(parts.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const fillOf = styleFills(parts.get("xl/styles.xml")?.toString("utf8"));
  const out: { title: string; grid: Grid }[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], "r:id");
    const target = rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1];
    const path = target ? `xl/${target.replace(/^\/?xl\//, "")}` : null;
    const xml = path ? parts.get(path)?.toString("utf8") : null;
    if (!path || !xml) continue;
    const grid = sheetGrid(xml, shared, fillOf, parts.get(path.replace(/worksheets\//, "worksheets/_rels/") + ".rels")?.toString("utf8") ?? "");
    if (grid.rows.length) out.push({ title: unescape(attr(m[0], "name") ?? ""), grid });
  }
  return out;
}

function sheetGrid(xml: string, shared: string[], fillOf: (string | null)[], rels: string): Grid {
  const cells = new Map<string, Cell>();
  let maxR = -1;
  let maxC = -1;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = m[1];
    const body = m[2] ?? "";
    const ref = attr(a, "r");
    if (!ref) continue;
    const [r, c] = cellRef(ref);
    const t = attr(a, "t");
    const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let text = t === "s" ? (shared[Number(v)] ?? "") : t === "inlineStr" ? texts(body) : v != null ? unescape(v) : "";
    const f = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
    const links: string[] = [];
    const hl = f && unescape(f).match(/HYPERLINK\(\s*"([^"]+)"(?:\s*[,;]\s*"([^"]*)")?/i);
    if (hl) {
      links.push(hl[1]);
      if (!text && hl[2]) text = hl[2];
    }
    const color = fillOf[Number(attr(a, "s") ?? 0)] ?? null;
    if (!text && !links.length && !color) continue;
    cells.set(`${r}:${c}`, { text: text.trim(), links, color });
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  }
  // The sheet's hyperlinks list (a link on a cell, or on a range of cells)
  for (const m of xml.matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = attr(m[0], "ref");
    const rid = attr(m[0], "r:id");
    const url = rid ? (rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1]) : null;
    if (!ref || !url) continue;
    for (const [r, c] of rangeCells(ref)) {
      const k = `${r}:${c}`;
      const cell = cells.get(k) ?? { text: "", links: [], color: null };
      const u = unescape(url);
      if (!cell.links.includes(u)) cell.links.push(u);
      cells.set(k, cell);
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    }
  }
  const rows: Cell[][] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= maxC; c++) row.push(cells.get(`${r}:${c}`) ?? { text: "", links: [], color: null });
    if (row.some((c) => c.text || c.links.length)) rows.push(row);
  }
  return { rows, source: "xlsx" };
}

/** A CSV (or TSV) as a grid: quoted fields with commas, quotes and line breaks are kept whole */
export function csvToGrid(text: string): Grid {
  const sep = (text.split("\n")[0].match(/\t/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const URL = /https?:\/\/[^\s<>"')]+/g;
  return {
    rows: rows.filter((r) => r.some((c) => c.trim())).map((r) => r.map((c) => ({ text: c.trim(), links: c.match(URL) ?? [], color: null }))),
    source: "csv",
  };
}
