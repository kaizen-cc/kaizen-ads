// A PDF's layout as a table reader needs it: every piece of text with where it sits, every hyperlink with the area it
// covers (PDF link annotations), and every filled shape with its color (cell backgrounds, row colors, grid lines).
// Coordinates are page points from the top-left corner. Text alone loses the links and the colors a launch sheet
// uses to say things (a row in red, a creative name linked to its Drive folder), so all three are kept.

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type PdfText = Box & { page: number; str: string };
export type PdfLink = Box & { page: number; url: string };
export type PdfFill = Box & { page: number; color: string };
export type PdfLayout = { pages: { width: number; height: number }[]; texts: PdfText[]; links: PdfLink[]; fills: PdfFill[] };

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
/** m × c (PDF's cm: the new matrix is applied before the current one) */
const mul = (m: M, c: M): M => [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** The sub-paths of a constructPath's data, each as its bounding box (a table's cells are drawn many to one path) */
function subpaths(data: ArrayLike<number>): Box[] {
  const out: Box[] = [];
  let cur: Box | null = null;
  const add = (x: number, y: number) => {
    if (!cur) cur = { x0: x, y0: y, x1: x, y1: y };
    else cur = { x0: Math.min(cur.x0, x), y0: Math.min(cur.y0, y), x1: Math.max(cur.x1, x), y1: Math.max(cur.y1, y) };
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i];
    if (op === 0) {
      if (cur) out.push(cur);
      cur = null;
      add(data[i + 1], data[i + 2]);
      i += 3;
    } else if (op === 1) {
      add(data[i + 1], data[i + 2]);
      i += 3;
    } else if (op === 2) {
      add(data[i + 1], data[i + 2]);
      add(data[i + 3], data[i + 4]);
      add(data[i + 5], data[i + 6]);
      i += 7;
    } else if (op === 3) {
      add(data[i + 1], data[i + 2]);
      add(data[i + 3], data[i + 4]);
      i += 5;
    } else i += 1; // closePath
  }
  if (cur) out.push(cur);
  return out;
}

const hex = (v: unknown): string | null => {
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (Array.isArray(v) && v.length >= 3) return `#${v.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0")).join("")}`;
  if (ArrayBuffer.isView(v)) return hex(Array.from(v as unknown as ArrayLike<number>));
  return null;
};

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loaded: Promise<PdfJs> | null = null;
async function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    const g = globalThis as unknown as { pdfjsWorker?: unknown };
    // The worker's code runs in this process (no worker thread on the server)
    // @ts-expect-error the worker module has no types
    g.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return loaded;
}

/** Reads text, links and fills from every page (at most maxPages). Throws when the file isn't a PDF. */
export async function pdfLayout(buf: Uint8Array, maxPages = 30): Promise<PdfLayout> {
  const lib = await pdfjs();
  const OPS = lib.OPS as Record<string, number>;
  const doc = await lib.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const out: PdfLayout = { pages: [], texts: [], links: [], fills: [] };
  const paintOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const H = vp.height;
    // The page's own offset (a crop box that doesn't start at 0)
    const [ox, oy] = [vp.viewBox[0] ?? 0, vp.viewBox[1] ?? 0];
    out.pages.push({ width: vp.width, height: H });
    const tc = await page.getTextContent();
    for (const it of tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      const size = Math.abs(it.height || it.transform[3]) || 8;
      const x = it.transform[4] - ox;
      const base = H - (it.transform[5] - oy);
      out.texts.push({ page: n, str: it.str, x0: x, x1: x + (it.width ?? 0), y0: base - size * 0.8, y1: base + size * 0.2 });
    }
    for (const a of (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
      const url = a.url ?? a.unsafeUrl;
      if (a.subtype !== "Link" || !url || !a.rect) continue;
      out.links.push({ page: n, url, x0: a.rect[0] - ox, x1: a.rect[2] - ox, y0: H - (a.rect[3] - oy), y1: H - (a.rect[1] - oy) });
    }
    // Fills: walk the drawing operators with the transform and fill color of the graphics state
    try {
      const ol = await page.getOperatorList();
      let ctm: M = ID;
      let color = "#000000";
      const stack: { ctm: M; color: string }[] = [];
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        const args = ol.argsArray[i] as unknown[];
        if (fn === OPS.save) stack.push({ ctm, color });
        else if (fn === OPS.restore) ({ ctm, color } = stack.pop() ?? { ctm: ID, color: "#000000" });
        else if (fn === OPS.transform) ctm = mul(args as unknown as M, ctm);
        else if (fn === OPS.setFillRGBColor) color = hex(args[0]) ?? color;
        else if (fn === OPS.setFillGray) {
          const g = Math.round(Number(args[0]) * 255);
          color = hex([g, g, g]) ?? color;
        } else if (fn === OPS.constructPath) {
          const paint = Number(args[0]);
          if (!paintOps.has(paint)) continue;
          const data = (args[1] as ArrayLike<number>[] | undefined)?.[0];
          const boxes = data ? subpaths(data) : [];
          for (const b of boxes) {
            const [ax, ay] = apply(ctm, b.x0, b.y0);
            const [bx, by] = apply(ctm, b.x1, b.y1);
            out.fills.push({ page: n, color, x0: Math.min(ax, bx) - ox, x1: Math.max(ax, bx) - ox, y0: H - (Math.max(ay, by) - oy), y1: H - (Math.min(ay, by) - oy) });
          }
        }
      }
    } catch {
      // A page whose drawing can't be walked keeps its text and links
    }
    page.cleanup();
  }
  await doc.cleanup();

  return out;
}
