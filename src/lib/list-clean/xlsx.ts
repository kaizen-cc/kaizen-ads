import { unzipSync } from "fflate";

// A small Excel (.xlsx) reader: sheets as rows of text. An .xlsx is a zip of XML; this reads the sheet names, the shared
// strings, the cells (text, numbers, true/false, inline text) and turns date-formatted numbers into dates. It reads the
// values the way Excel shows them, never formulas. Plain functions (no server or browser APIs), so the tests run it.
// Not read: the old binary .xls (save it as .xlsx or CSV), password-protected files.

export type Sheet = { name: string; rows: string[][] };

const MAX_ROWS = 400_000;
const MAX_COLS = 300;

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return entities[e.toLowerCase()] ?? m;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** "AB" → 27 (zero based) */
function colIndex(letters: string) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder("utf-8").decode(bytes) : "");

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let s = "";
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let x: RegExpExecArray | null;
    while ((x = t.exec(body))) s += x[1];
    out.push(decode(s));
  }
  return out;
}

/** Which cell styles are dates: the built-in date formats and any custom format with day, month or year letters */
function dateStyles(xml: string): Set<number> {
  const custom = new Map<number, string>();
  const nf = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = nf.exec(xml))) custom.set(Number(m[1]), decode(m[2]));
  const builtin = (id: number) => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
  const isDate = (id: number) => {
    const code = custom.get(id);
    if (code == null) return builtin(id);
    const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare);
  };
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const out = new Set<number>();
  let i = 0;
  const xf = /<xf\b[^>]*?numFmtId="(\d+)"/g;
  while ((m = xf.exec(cellXfs))) {
    if (isDate(Number(m[1]))) out.add(i);
    i++;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** An Excel date serial as "YYYY-MM-DD" (with the time when it has one) */
export function excelDate(serial: number): string {
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const secs = Math.round((serial - days) * 86_400);
  if (!secs) return day;
  return `${day} ${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
}

/** A number as Excel stores it, written the way it reads: no exponent for whole numbers (phone numbers, ZIP codes) */
const plainNumber = (v: string) => {
  if (!/e/i.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e15 && Number.isInteger(Number(n.toPrecision(15))) ? String(Math.round(n)) : v;
};

/** Every sheet of an .xlsx file (the bytes), or an error saying why it can't be read */
export function readXlsx(bytes: Uint8Array): { ok: true; sheets: Sheet[] } | { ok: false; error: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  } catch {
    return { ok: false, error: "That isn't a readable Excel (.xlsx) file. Save it as .xlsx or CSV and attach it again." };
  }
  if (!files["xl/workbook.xml"]) return { ok: false, error: "That isn't an Excel (.xlsx) workbook. Save it as .xlsx or CSV and attach it again." };
  const workbook = text(files["xl/workbook.xml"]);
  const rels = text(files["xl/_rels/workbook.xml.rels"]);
  const target = new Map<string, string>();
  const rel = /<Relationship\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = rel.exec(rels))) {
    const id = m[0].match(/\bId="([^"]*)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  }
  const strings = sharedStrings(text(files["xl/sharedStrings.xml"]));
  const dates = dateStyles(text(files["xl/styles.xml"]));
  const sheets: Sheet[] = [];
  const sh = /<sheet\b[^>]*>/g;
  while ((m = sh.exec(workbook))) {
    if (/\bstate="(hidden|veryHidden)"/.test(m[0])) continue;
    const name = decode(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "Sheet");
    const rid = m[0].match(/\br:id="([^"]*)"/)?.[1] ?? m[0].match(/\bid="([^"]*)"/)?.[1] ?? "";
    const path = target.get(rid);
    const xml = path ? text(files[path]) : "";
    if (!xml) continue;
    sheets.push({ name, rows: readSheet(xml, strings, dates) });
  }
  return sheets.length ? { ok: true, sheets } : { ok: false, error: "That workbook has no sheets with data." };
}

function readSheet(xml: string, strings: string[], dates: Set<number>): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  let nextRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = rm[1].match(/\br="(\d+)"/)?.[1];
    const r = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = r + 1;
    if (r >= MAX_ROWS) break;
    const body = rm[2];
    if (!body) continue;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    let nextCol = 0;
    while ((cm = cellRe.exec(body))) {
      const ref = cm[1].match(/\br="([A-Z]+)\d+"/)?.[1];
      const c = ref ? colIndex(ref) : nextCol;
      nextCol = c + 1;
      if (c >= MAX_COLS || !cm[2]) continue;
      const type = cm[1].match(/\bt="([^"]*)"/)?.[1] ?? "n";
      const style = Number(cm[1].match(/\bs="(\d+)"/)?.[1] ?? -1);
      let value = "";
      if (type === "inlineStr") {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let x: RegExpExecArray | null;
        while ((x = t.exec(cm[2]))) value += x[1];
        value = decode(value);
      } else {
        const v = cm[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v == null) continue;
        if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "str") value = decode(v);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";
        else if (dates.has(style) && Number.isFinite(Number(v))) value = excelDate(Number(v));
        else value = plainNumber(v);
      }
      cells[c] = value;
    }
    if (!cells.length) continue;
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  // Rows Excel left out are empty lines (kept, so a row number here is the row number in Excel)
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}
