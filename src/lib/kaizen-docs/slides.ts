import type { Block, Item, KDoc, KSection } from "./templates";

// A Kaizen deck (the sales proposal, and every open deck) as Google Slides API requests, in the look of Kaizen's
// proposals: landscape 11 x 8.5; a black cover with "KAIZEN MARKETING AGENCY" over a red bar, the title, subtitle,
// prepared for and by, a contact line and "Confidential | Prepared <date>"; inner slides white with a red rule and
// "KAIZEN MARKETING AGENCY | <title>" and the month at the top, a big title with a grey lede, then the section's
// blocks (red stat tiles, red-subhead columns, tables with a red rule under the head, grey callouts), and the
// ownership line and page number at the foot. A section too long for one slide carries on to the next. Pure.

export const PAGE = { w: 792, h: 612 };
const M = 40;
const W = PAGE.w - 2 * M;
const TOP = 132;
const BOTTOM = 560;
const RED = { red: 0.698, green: 0.118, blue: 0.173 };
const BLACK = { red: 0.024, green: 0.024, blue: 0.024 };
const BODY = { red: 0.2, green: 0.2, blue: 0.2 };
const GREY = { red: 0.42, green: 0.42, blue: 0.42 };
const SOFT = { red: 0.95, green: 0.95, blue: 0.95 };
const RULE = { red: 0.85, green: 0.85, blue: 0.85 };
const WHITE = { red: 1, green: 1, blue: 1 };
type Rgb = typeof RED;

export const FOOT = "Clients own 100% of their assets: website, ad accounts, social pages, creative and data.";

type Req = Record<string, unknown>;

/** Rough height of text in a box: characters per line from the width and size */
export function textHeight(text: string, width: number, size: number, lineGap = 1.35): number {
  const perLine = Math.max(8, Math.floor(width / (size * 0.5)));
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return Math.ceil(lines * size * lineGap) + 4;
}

class Deck {
  reqs: Req[] = [];
  private n = 0;
  slides = 0;
  constructor(private readonly prefix: string) {}
  id(kind: string) {
    return `${this.prefix}_${kind}_${++this.n}`;
  }
  slide(fill: Rgb | null) {
    const id = this.id("s");
    this.reqs.push({ createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    if (fill) this.reqs.push({ updatePageProperties: { objectId: id, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: fill } } } }, fields: "pageBackgroundFill.solidFill.color" } });
    this.slides++;
    return id;
  }
  box(page: string, x: number, y: number, w: number, h: number) {
    const id = this.id("t");
    this.reqs.push({ createShape: { objectId: id, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: page, size: { width: { magnitude: w, unit: "PT" }, height: { magnitude: h, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "PT" } } } });
    return id;
  }
  rect(page: string, x: number, y: number, w: number, h: number, color: Rgb) {
    const id = this.id("r");
    this.reqs.push({ createShape: { objectId: id, shapeType: "RECTANGLE", elementProperties: { pageObjectId: page, size: { width: { magnitude: w, unit: "PT" }, height: { magnitude: h, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "PT" } } } });
    this.reqs.push({ updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: color } } }, outline: { propertyState: "NOT_RENDERED" } }, fields: "shapeBackgroundFill.solidFill.color,outline.propertyState" } });
    return id;
  }
  /** Text in a new box; runs is [text, style] pieces */
  text(page: string, x: number, y: number, w: number, h: number, runs: [string, { size: number; color: Rgb; bold?: boolean; italic?: boolean }][], o: { align?: "START" | "END" | "CENTER"; bullets?: boolean; fill?: Rgb } = {}) {
    const all = runs.map((r) => r[0]).join("");
    if (!all.trim()) return null;
    const id = this.box(page, x, y, w, h);
    if (o.fill) this.reqs.push({ updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: o.fill } } } }, fields: "shapeBackgroundFill.solidFill.color" } });
    this.reqs.push({ insertText: { objectId: id, text: all } });
    let at = 0;
    for (const [t, st] of runs) {
      if (t.length) this.reqs.push({ updateTextStyle: { objectId: id, textRange: { type: "FIXED_RANGE", startIndex: at, endIndex: at + t.length }, style: { fontFamily: "Arial", fontSize: { magnitude: st.size, unit: "PT" }, foregroundColor: { opaqueColor: { rgbColor: st.color } }, bold: Boolean(st.bold), italic: Boolean(st.italic) }, fields: "fontFamily,fontSize,foregroundColor,bold,italic" } });
      at += t.length;
    }
    this.reqs.push({ updateParagraphStyle: { objectId: id, textRange: { type: "ALL" }, style: { alignment: o.align ?? "START", lineSpacing: 115, spaceBelow: { magnitude: 3, unit: "PT" } }, fields: "alignment,lineSpacing,spaceBelow" } });
    if (o.bullets) this.reqs.push({ createParagraphBullets: { objectId: id, textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    return id;
  }
}

const itemRuns = (list: Item[], size: number): [string, { size: number; color: Rgb; bold?: boolean }][] =>
  list.flatMap((it, i) => {
    const end = i < list.length - 1 ? "\n" : "";
    return it.lead ? [[`${it.lead} `, { size, color: BLACK, bold: true }] as [string, { size: number; color: Rgb; bold?: boolean }], [`${it.text}${end}`, { size, color: BODY }] as [string, { size: number; color: Rgb }]] : [[`${it.text}${end}`, { size, color: BODY }] as [string, { size: number; color: Rgb }]];
  });
const itemsLen = (list: Item[]) => list.map((i) => `${i.lead} ${i.text}`).join("\n");

/** How tall a block will draw, for laying a slide out */
export function blockHeight(b: Block): number {
  switch (b.type) {
    case "stats":
      return 74;
    case "paragraph":
      return textHeight(b.text, W, 11);
    case "subheading":
      return 22;
    case "callout":
      return textHeight(b.text, W - 24, 10.5) + 14;
    case "bullets":
    case "steps":
      return textHeight(itemsLen(b.items), W - 18, 10.5);
    case "columns": {
      const cw = (W - 20 * (b.columns.length - 1)) / b.columns.length;
      return Math.max(...b.columns.map((c) => 22 + (c.text ? textHeight(c.text, cw, 10.5) : 0) + textHeight(itemsLen(c.items), cw - 18, 10.5)));
    }
    case "table": {
      const cw = colWidths(b.head.length);
      const row = (r: string[]) => Math.max(...r.map((c, i) => textHeight(c, cw[i] - 10, 9.5, 1.3))) + 8;
      return row(b.head) + [...b.rows, ...(b.total ? [b.total] : [])].reduce((s, r) => s + row(r), 0) + 6;
    }
    case "keyvalue":
      return b.rows.reduce((s, r) => s + textHeight(r.value, W * 0.7, 10.5) + 4, 0);
    case "gantt":
      return 24 + b.rows.length * 22;
    case "total":
      return 40;
  }
}

const colWidths = (n: number) => {
  const first = n >= 3 ? W * 0.24 : W * 0.34;
  return [first, ...Array.from({ length: n - 1 }, () => (W - first) / (n - 1))];
};

function drawTable(d: Deck, page: string, y: number, b: Extract<Block, { type: "table" }>) {
  const id = d.id("tb");
  const rows = [b.head, ...b.rows, ...(b.total ? [b.total] : [])];
  const cols = b.head.length;
  d.reqs.push({ createTable: { objectId: id, rows: rows.length, columns: cols, elementProperties: { pageObjectId: page, size: { width: { magnitude: W, unit: "PT" }, height: { magnitude: rows.length * 20, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: M, translateY: y, unit: "PT" } } } });
  colWidths(cols).forEach((w, i) => d.reqs.push({ updateTableColumnProperties: { objectId: id, columnIndices: [i], tableColumnProperties: { columnWidth: { magnitude: w, unit: "PT" } }, fields: "columnWidth" } }));
  rows.forEach((r, ri) =>
    r.forEach((c, ci) => {
      if (!c) return;
      const cell = { rowIndex: ri, columnIndex: ci };
      d.reqs.push({ insertText: { objectId: id, cellLocation: cell, text: c } });
      const head = ri === 0;
      const total = Boolean(b.total) && ri === rows.length - 1;
      d.reqs.push({ updateTextStyle: { objectId: id, cellLocation: cell, textRange: { type: "ALL" }, style: { fontFamily: "Arial", fontSize: { magnitude: head ? 9 : 9.5, unit: "PT" }, bold: head || total || ci === 0, foregroundColor: { opaqueColor: { rgbColor: head || ci === 0 ? BLACK : BODY } } }, fields: "fontFamily,fontSize,bold,foregroundColor" } });
    }),
  );
  // Light rules between rows, a red rule under the head, no side borders
  d.reqs.push({ updateTableBorderProperties: { objectId: id, borderPosition: "ALL", tableBorderProperties: { tableBorderFill: { solidFill: { color: { rgbColor: RULE } } }, weight: { magnitude: 0.5, unit: "PT" }, dashStyle: "SOLID" }, fields: "tableBorderFill.solidFill.color,weight,dashStyle" } });
  d.reqs.push({ updateTableBorderProperties: { objectId: id, borderPosition: "INNER_VERTICAL", tableBorderProperties: { tableBorderFill: { solidFill: { color: { rgbColor: WHITE } } }, weight: { magnitude: 0.5, unit: "PT" } }, fields: "tableBorderFill.solidFill.color,weight" } });
  d.reqs.push({ updateTableBorderProperties: { objectId: id, tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: cols }, borderPosition: "BOTTOM", tableBorderProperties: { tableBorderFill: { solidFill: { color: { rgbColor: RED } } }, weight: { magnitude: 1.5, unit: "PT" } }, fields: "tableBorderFill.solidFill.color,weight" } });
  if (b.total) d.reqs.push({ updateTableCellProperties: { objectId: id, tableRange: { location: { rowIndex: rows.length - 1, columnIndex: 0 }, rowSpan: 1, columnSpan: cols }, tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { rgbColor: SOFT } } } }, fields: "tableCellBackgroundFill.solidFill.color" } });
}

function drawBlock(d: Deck, page: string, y: number, b: Block) {
  switch (b.type) {
    case "stats": {
      const w = (W - 20 * (b.items.length - 1)) / b.items.length;
      b.items.forEach((s, i) => {
        const x = M + i * (w + 20);
        d.text(page, x, y, w, 34, [[s.value, { size: 24, color: RED, bold: true }]]);
        d.text(page, x, y + 36, w, 34, [[s.label, { size: 9, color: GREY }]]);
      });
      return;
    }
    case "paragraph":
      d.text(page, M, y, W, blockHeight(b), [[b.text, { size: 11, color: BODY }]]);
      return;
    case "subheading":
      d.text(page, M, y, W, 22, [[b.text, { size: 12.5, color: RED, bold: true }]]);
      return;
    case "callout": {
      const h = blockHeight(b);
      d.rect(page, M, y, 3, h, RED);
      const at = b.text.indexOf(":");
      const runs: [string, { size: number; color: Rgb; bold?: boolean }][] = at > 0 && at < 50 ? [[b.text.slice(0, at + 1), { size: 10.5, color: BLACK, bold: true }], [b.text.slice(at + 1), { size: 10.5, color: BODY }]] : [[b.text, { size: 10.5, color: BODY }]];
      d.text(page, M + 3, y, W - 3, h, runs, { fill: SOFT });
      return;
    }
    case "bullets":
      d.text(page, M, y, W, blockHeight(b), itemRuns(b.items, 10.5), { bullets: true });
      return;
    case "steps":
      d.text(page, M, y, W, blockHeight(b), itemRuns(b.items.map((it, i) => ({ lead: `${i + 1}. ${it.lead}`, text: it.text })), 10.5));
      return;
    case "columns": {
      const cw = (W - 20 * (b.columns.length - 1)) / b.columns.length;
      b.columns.forEach((c, i) => {
        const x = M + i * (cw + 20);
        let cy = y;
        if (c.heading) {
          d.text(page, x, cy, cw, 20, [[c.heading, { size: 12, color: RED, bold: true }]]);
          cy += 22;
        }
        if (c.text) {
          const h = textHeight(c.text, cw, 10.5);
          d.text(page, x, cy, cw, h, [[c.text, { size: 10.5, color: BODY }]]);
          cy += h;
        }
        if (c.items.length) d.text(page, x, cy, cw, textHeight(itemsLen(c.items), cw - 18, 10.5), itemRuns(c.items, 10.5), { bullets: true });
      });
      return;
    }
    case "table":
      drawTable(d, page, y, b);
      return;
    case "keyvalue":
      drawTable(d, page, y, { type: "table", head: ["Item", "Detail"], rows: b.rows.map((r) => [r.label, r.value]), total: null });
      return;
    case "gantt": {
      const label = W * 0.3;
      const cell = (W - label) / b.weeks;
      b.rows.forEach((r, i) => {
        const ry = y + 20 + i * 22;
        d.text(page, M, ry, label, 20, [[r.task, { size: 9.5, color: BLACK }]]);
        d.rect(page, M + label + (r.start - 1) * cell, ry + 4, (r.end - r.start + 1) * cell - 2, 12, RED);
      });
      for (let w = 0; w < b.weeks; w++) d.text(page, M + label + w * cell, y, cell, 18, [[`W${w + 1}`, { size: 8, color: GREY, bold: true }]], { align: "CENTER" });
      return;
    }
    case "total":
      d.rect(page, M, y, W, 34, RED);
      d.text(page, M + 10, y + 6, W / 2, 24, [[b.label, { size: 12, color: WHITE, bold: true }]]);
      d.text(page, M + W / 2, y + 6, W / 2 - 10, 24, [[b.value, { size: 14, color: WHITE, bold: true }]], { align: "END" });
      return;
  }
}

/** Splits a table taller than the room left into pieces that fit (the head repeats) */
function splitTable(b: Extract<Block, { type: "table" }>, room: number): Extract<Block, { type: "table" }>[] {
  if (blockHeight(b) <= room || b.rows.length < 2) return [b];
  const out: Extract<Block, { type: "table" }>[] = [];
  let cur: string[][] = [];
  for (const r of b.rows) {
    const next = { ...b, rows: [...cur, r], total: null };
    if (cur.length && blockHeight(next) > (out.length ? BOTTOM - TOP : room)) {
      out.push({ ...b, rows: cur, total: null });
      cur = [r];
    } else cur.push(r);
  }
  out.push({ ...b, rows: cur, total: b.total });
  return out;
}

function chrome(d: Deck, page: string, doc: KDoc, s: KSection, n: number, continued: boolean) {
  d.rect(page, M, 30, 22, 2.5, RED);
  d.text(page, M + 28, 22, 500, 18, [["KAIZEN MARKETING AGENCY", { size: 8, color: GREY, bold: true }], [`   |   ${doc.title}`, { size: 8, color: GREY }]]);
  d.text(page, PAGE.w - M - 200, 22, 200, 18, [[doc.dated, { size: 8, color: GREY }]], { align: "END" });
  d.text(page, M, 48, W, 36, [[`${s.heading}${continued ? " (continued)" : ""}`, { size: 24, color: BLACK, bold: true }]]);
  if (s.lede && !continued) d.text(page, M, 86, W, 42, [[s.lede, { size: 12, color: GREY }]]);
  d.text(page, M, 578, W - 60, 16, [[FOOT, { size: 7.5, color: GREY }]]);
  d.text(page, PAGE.w - M - 40, 578, 40, 16, [[String(n), { size: 7.5, color: GREY }]], { align: "END" });
}

/** The deck's requests (after these the presentation's own first slide is deleted) */
export function deckRequests(doc: KDoc, prefix = "kz"): { requests: Req[]; slides: number } {
  const d = new Deck(prefix);
  // Cover
  const cover = d.slide(BLACK);
  d.text(cover, M, 40, 400, 18, [["KAIZEN MARKETING AGENCY", { size: 10, color: WHITE, bold: true }]]);
  d.rect(cover, M, 62, 56, 4, RED);
  d.text(cover, M, 170, W, 110, [[doc.title, { size: 34, color: WHITE, bold: true }]]);
  if (doc.subtitle) d.text(cover, M, 284, W, 40, [[doc.subtitle, { size: 14, color: { red: 0.85, green: 0.85, blue: 0.85 } }]]);
  d.text(cover, M, 350, W, 40, [[[doc.preparedFor && `Prepared for ${doc.preparedFor}`, `Prepared by ${doc.preparedBy}`].filter(Boolean).join("\n"), { size: 10, color: GREY }]]);
  d.text(cover, M, 560, 460, 16, [["kaizenmarketing.agency", { size: 8, color: GREY }]]);
  d.text(cover, PAGE.w - M - 280, 560, 280, 16, [[`Confidential  |  Prepared ${doc.dated}`, { size: 8, color: GREY }]], { align: "END" });

  let n = 1;
  for (const s of doc.sections) {
    let page = d.slide(null);
    chrome(d, page, doc, s, ++n, false);
    let y = s.lede ? TOP : 96;
    const queue = [...s.blocks];
    while (queue.length) {
      const b = queue.shift()!;
      const room = BOTTOM - y;
      if (b.type === "table") {
        const parts = splitTable(b, room);
        if (parts.length > 1) {
          queue.unshift(...parts.slice(1));
        }
        const part = parts[0];
        if (blockHeight(part) > room && y > TOP) {
          page = d.slide(null);
          chrome(d, page, doc, s, ++n, true);
          y = 96;
        }
        drawBlock(d, page, y, part);
        y += blockHeight(part) + 12;
        continue;
      }
      const h = blockHeight(b);
      if (h > room && y > 100) {
        page = d.slide(null);
        chrome(d, page, doc, s, ++n, true);
        y = 96;
      }
      drawBlock(d, page, y, b);
      y += h + 12;
    }
  }
  return { requests: d.reqs, slides: d.slides };
}
