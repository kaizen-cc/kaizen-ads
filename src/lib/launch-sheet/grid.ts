import type { Cell, Grid } from "./types";
import type { PdfFill, PdfLayout, PdfText } from "./pdf-layout";

// A PDF page back into the table it was printed from. Spreadsheets exported to PDF draw their grid lines as thin
// filled shapes: the horizontal ones are the row edges, the vertical ones the column edges, so every piece of text,
// every link and every background color lands in its own cell. A page without grid lines falls back to its text lines
// (one row per line, columns where the text starts), which still keeps footnotes and loose notes.

const DARK = (c: string) => {
  const n = parseInt(c.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 120;
};
const isWhite = (c: string) => {
  const n = parseInt(c.slice(1), 16);
  return ((n >> 16) & 255) > 245 && ((n >> 8) & 255) > 245 && (n & 255) > 245;
};

/** Positions closer than tol merged into one (sorted) */
function cluster(values: number[], tol: number) {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

const LINE = 1.6; // a grid line is thinner than this (points)

function edges(fills: PdfFill[], pageWidth: number, pageHeight: number) {
  const lines = fills.filter((f) => DARK(f.color));
  const h = lines.filter((f) => f.y1 - f.y0 < LINE && f.x1 - f.x0 > pageWidth * 0.08).map((f) => (f.y0 + f.y1) / 2);
  const v = lines.filter((f) => f.x1 - f.x0 < LINE && f.y1 - f.y0 > 2 && f.y1 - f.y0 < pageHeight * 0.95).map((f) => (f.x0 + f.x1) / 2);
  return { rows: cluster(h, 0.8), cols: cluster(v, 0.8) };
}

/** The cell text: lines top to bottom; a wrapped line joins with a space, a blank line between paragraphs stays */
function cellText(items: PdfText[]) {
  if (!items.length) return "";
  const sorted = [...items].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: { y: number; h: number; parts: PdfText[] }[] = [];
  for (const t of sorted) {
    const mid = (t.y0 + t.y1) / 2;
    const l = lines.find((x) => Math.abs(x.y - mid) < (t.y1 - t.y0) * 0.45);
    if (l) l.parts.push(t);
    else lines.push({ y: mid, h: t.y1 - t.y0, parts: [t] });
  }
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].parts
      .sort((a, b) => a.x0 - b.x0)
      .map((p) => p.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (!out) out = text;
    else {
      const gap = lines[i].y - lines[i - 1].y;
      out += gap > lines[i].h * 1.7 ? `\n\n${text}` : ` ${text}`;
    }
  }
  return out.trim();
}

const empty = (): Cell => ({ text: "", links: [], color: null });

/** One page with grid lines: cells between the lines */
function gridPage(layout: PdfLayout, page: number, rowsAt: number[], colsAt: number[]): Cell[][] {
  const texts = layout.texts.filter((t) => t.page === page);
  const links = layout.links.filter((l) => l.page === page);
  const fills = layout.fills.filter((f) => f.page === page && !DARK(f.color) && f.y1 - f.y0 >= LINE && f.x1 - f.x0 >= LINE);
  const colOf = (x: number) => {
    let c = -1;
    for (let i = 0; i < colsAt.length; i++) if (x >= colsAt[i] - 1) c = i;
    return c >= colsAt.length - 1 ? -1 : c;
  };
  const rowOf = (y: number) => {
    for (let i = 0; i < rowsAt.length - 1; i++) if (y >= rowsAt[i] && y < rowsAt[i + 1]) return i;
    return -1;
  };
  const nRows = rowsAt.length - 1;
  const nCols = Math.max(1, colsAt.length - 1);
  const items: PdfText[][][] = Array.from({ length: nRows }, () => Array.from({ length: nCols }, () => []));
  for (const t of texts) {
    const r = rowOf((t.y0 + t.y1) / 2);
    const c = colOf(t.x0 + 0.5);
    if (r >= 0 && c >= 0) items[r][c].push(t);
  }
  const cells: Cell[][] = items.map((row) => row.map((its) => ({ ...empty(), text: cellText(its) })));
  for (const l of links) {
    const r = rowOf((l.y0 + l.y1) / 2);
    const c = colOf(l.x0 + 0.5);
    if (r >= 0 && c >= 0 && !cells[r][c].links.includes(l.url)) cells[r][c].links.push(l.url);
  }
  // A cell's color: the smallest colored shape under its middle
  for (let r = 0; r < nRows; r++)
    for (let c = 0; c < nCols; c++) {
      const x = (colsAt[c] + colsAt[c + 1]) / 2;
      const y = (rowsAt[r] + rowsAt[r + 1]) / 2;
      const under = fills.filter((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
      const top = under[0];
      cells[r][c].color = top && !isWhite(top.color) ? top.color : null;
    }
  return cells;
}

/** A page without grid lines: one row per text line, columns where the text starts (for footnotes and notes) */
function loosePage(layout: PdfLayout, page: number): Cell[][] {
  const texts = layout.texts.filter((t) => t.page === page).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: PdfText[][] = [];
  for (const t of texts) {
    const l = lines.at(-1);
    if (l && Math.abs((l[0].y0 + l[0].y1) / 2 - (t.y0 + t.y1) / 2) < (t.y1 - t.y0) * 0.45) l.push(t);
    else lines.push([t]);
  }
  const links = layout.links.filter((l) => l.page === page);
  return lines.map((l) => {
    const text = l
      .sort((a, b) => a.x0 - b.x0)
      .map((t) => t.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const y0 = Math.min(...l.map((t) => t.y0));
    const y1 = Math.max(...l.map((t) => t.y1));
    const ls = links.filter((k) => (k.y0 + k.y1) / 2 >= y0 && (k.y0 + k.y1) / 2 <= y1).map((k) => k.url);
    return [{ text, links: [...new Set(ls)], color: null }];
  });
}

/**
 * The whole PDF as one grid: pages one after another. Columns come from the first page with grid lines and are reused
 * on pages that continue the table, so a column means the same thing on every page.
 */
export function pdfToGrid(layout: PdfLayout): Grid {
  const rows: Cell[][] = [];
  let lastCols: number[] | null = null;
  for (let p = 1; p <= layout.pages.length; p++) {
    const { width, height } = layout.pages[p - 1];
    const e = edges(layout.fills.filter((f) => f.page === p), width, height);
    // Columns: this page's own when it has them, else the table's from the page before
    let cols: number[] | null = e.cols.length >= 3 ? e.cols : lastCols;
    if (cols && lastCols && e.cols.length >= 3 && Math.abs(cols.length - lastCols.length) <= 1) cols = lastCols.length >= cols.length ? lastCols : cols;
    if (e.rows.length >= 3 && cols) {
      lastCols = cols;
      const page = gridPage(layout, p, e.rows, cols).filter((r) => r.some((c) => c.text || c.links.length));
      rows.push(...page);
      // Text below the last grid line (footnotes under the table) as loose lines
      const below = layout.texts.some((t) => t.page === p && t.y0 > e.rows[e.rows.length - 1] + 2);
      if (below) {
        const loose = loosePage({ ...layout, texts: layout.texts.filter((t) => t.y0 > e.rows[e.rows.length - 1] + 2) }, p);
        rows.push(...loose);
      }
    } else rows.push(...loosePage(layout, p));
  }
  return { rows, source: "pdf", pages: layout.pages.length };
}

/** The grid as plain text for the model: one line per row, cells split by " | ", links and colors marked */
export function gridText(grid: Grid, maxChars = 60_000) {
  const lines = grid.rows.map((r, i) => {
    const color = r.find((c) => c.color)?.color;
    return `R${i + 1}${color ? ` {${color}}` : ""}: ${r.map((c) => `${c.text.replace(/\n+/g, " / ")}${c.links.length ? ` <${c.links.join(" , ")}>` : ""}`).join(" | ")}`;
  });
  return lines.join("\n").slice(0, maxChars);
}
