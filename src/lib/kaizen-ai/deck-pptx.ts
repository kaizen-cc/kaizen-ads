import { strToU8, zipSync } from "fflate";
import type { Slide, Tone } from "./deck-core";

// The same deck as make_deck's PDF, as a PowerPoint file the person can edit: every title, bullet, number, table and bar
// is a real PowerPoint shape or table (not a picture), in Kaizen's look with the client's colour, 16:9. Opens in
// PowerPoint, Keynote and Google Slides. Pure (the pictures come in as bytes), so it's tested.

export type PptxLook = { hero: string; primary: string; bars: string; heroSoft: string };
export type PptxPicture = { bytes: Uint8Array; width: number; height: number };
export type PptxInput = { title: string; client: string | null; look: PptxLook; slides: Slide[]; pictures: Map<string, PptxPicture> };

// Drawn in points on a 960 by 540 page (the PDF's own grid), written in EMU (12,700 per point)
const W = 960;
const H = 540;
const PAD = 56;
const E = (pt: number) => Math.round(pt * 12700);
const INK = "14202E";
const MUTED = "66768A";
const LINE = "E3E8EE";
const SURFACE = "F4F6F9";
const TONE: Record<Tone, { fg: string; bg: string; label: string }> = { good: { fg: "087A5E", bg: "E1F5EC", label: "Good" }, watch: { fg: "8A5A00", bg: "FFF1D6", label: "Watch" }, bad: { fg: "C23E4C", bg: "FFEAEC", label: "Bad" } };

const hex = (c: string) => c.replace(/^#/, "").slice(0, 6).toUpperCase().padEnd(6, "0");
export const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

type Run = { text: string; size: number; bold?: boolean; color?: string };
type Para = { runs: Run[]; align?: "l" | "r" | "ctr"; bullet?: string; spaceAfter?: number };

const runXml = (r: Run) => `<a:r><a:rPr lang="en-US" sz="${Math.round(r.size * 100)}" b="${r.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${hex(r.color ?? INK)}"/></a:solidFill><a:latin typeface="Helvetica"/><a:cs typeface="Helvetica"/></a:rPr><a:t>${xml(r.text)}</a:t></a:r>`;
const paraXml = (p: Para) =>
  `<a:p><a:pPr algn="${p.align ?? "l"}"${p.bullet ? ' marL="285750" indent="-285750"' : ""}>${p.spaceAfter ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfter * 100)}"/></a:spcAft>` : ""}${p.bullet ? `<a:buClr><a:srgbClr val="${hex(p.bullet)}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>` : "<a:buNone/>"}</a:pPr>${p.runs.map(runXml).join("")}<a:endParaRPr lang="en-US" sz="${Math.round((p.runs[0]?.size ?? 14) * 100)}" dirty="0"/></a:p>`;

/** One slide's shapes, numbered as they're added */
class Shapes {
  private n = 1;
  readonly parts: string[] = [];
  private id() {
    return ++this.n;
  }
  /** A text box (no fill unless asked), text anchored top unless asked */
  text(x: number, y: number, w: number, h: number, paras: Para[], opts: { fill?: string; anchor?: "t" | "ctr" | "b"; inset?: number; name?: string } = {}) {
    const id = this.id();
    const ins = E(opts.inset ?? 0);
    this.parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(opts.name ?? `Text ${id}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(w)}" cy="${E(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${opts.fill ? `<a:solidFill><a:srgbClr val="${hex(opts.fill)}"/></a:solidFill>` : "<a:noFill/>"}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${opts.anchor ?? "t"}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.length ? paras.map(paraXml).join("") : '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp>`,
    );
  }
  /** A filled shape: a panel, a bar, an accent line */
  box(x: number, y: number, w: number, h: number, fill: string, opts: { round?: number; line?: string; name?: string } = {}) {
    const id = this.id();
    const geom = opts.round ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((opts.round / Math.max(1, Math.min(w, h))) * 100000))}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    this.parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(opts.name ?? `Shape ${id}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(Math.max(0.5, w))}" cy="${E(Math.max(0.5, h))}"/></a:xfrm>${geom}<a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill>${opts.line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${hex(opts.line)}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>"}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`,
    );
  }
  /** A picture, fitted inside the box without stretching */
  picture(rel: string, x: number, y: number, w: number, h: number, size: { width: number; height: number }) {
    const id = this.id();
    const r = Math.min(w / Math.max(1, size.width), h / Math.max(1, size.height));
    const pw = size.width * r;
    const ph = size.height * r;
    this.parts.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${E(x + (w - pw) / 2)}" y="${E(y + (h - ph) / 2)}"/><a:ext cx="${E(pw)}" cy="${E(ph)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
  }
  /** A real PowerPoint table (editable cells) */
  table(x: number, y: number, w: number, columns: string[], cells: string[][], head: string, size: number) {
    const id = this.id();
    const weights = columns.map((_, i) => (i === 0 ? 1.6 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((k) => E((w * k) / total));
    const rowH = size > 14 ? 34 : 30;
    const cell = (text: string, i: number, header: boolean, fill: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paraXml({ runs: [{ text, size: header ? 14 : size, bold: header || i === 0, color: header ? "FFFFFF" : INK }], align: i === 0 ? "l" : "r" })}</a:txBody><a:tcPr marL="${E(10)}" marR="${E(10)}" marT="${E(5)}" marB="${E(5)}" anchor="ctr"><a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="6350"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:lnT><a:lnB w="6350"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:lnB><a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill></a:tcPr></a:tc>`;
    const rows = [
      `<a:tr h="${E(rowH)}">${columns.map((c, i) => cell(c, i, true, head)).join("")}</a:tr>`,
      ...cells.map((r, ri) => `<a:tr h="${E(rowH)}">${r.map((c, i) => cell(c, i, false, ri % 2 ? SURFACE : "FFFFFF")).join("")}</a:tr>`),
    ];
    this.parts.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(w)}" cy="${E(rowH * rows.length)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${widths.map((cw) => `<a:gridCol w="${cw}"/>`).join("")}</a:tblGrid>${rows.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
  }
}

function slideXml(sl: Slide, i: number, total: number, input: PptxInput, picRel: string | null, pic: PptxPicture | null) {
  const { look } = input;
  const dark = sl.kind === "cover" || sl.kind === "section" || sl.kind === "quote";
  const sh = new Shapes();
  if (!dark) sh.box(0, 0, W, 6, look.primary, { name: "Accent" });
  const head = (title: string) => {
    sh.text(PAD, 40, W - PAD * 2, 22, [{ runs: [{ text: (input.client ?? "Kaizen").toUpperCase(), size: 14, bold: true, color: look.primary }] }], { name: "Kicker" });
    if (title) sh.text(PAD, 64, W - PAD * 2, 50, [{ runs: [{ text: title, size: 32, bold: true }] }], { name: "Title" });
  };
  const top = 128;
  const bulletsParas = (items: string[], size: number, color: string): Para[] => items.map((b) => ({ runs: [{ text: b, size }], bullet: color, spaceAfter: 10 }));

  switch (sl.kind) {
    case "cover":
      sh.text(PAD, 48, W - PAD * 2, 30, [{ runs: [{ text: input.client ?? "Kaizen Marketing", size: 22, bold: true, color: "FFFFFF" }] }], { name: "Masthead" });
      sh.text(PAD, 230, 720, 30, [{ runs: [{ text: input.client ? "PREPARED FOR" : "KAIZEN MARKETING", size: 14, bold: true, color: look.heroSoft }] }]);
      sh.text(PAD, 258, 760, 130, [{ runs: [{ text: sl.title, size: sl.title.length > 40 ? 40 : 48, bold: true, color: "FFFFFF" }] }], { name: "Title" });
      if (sl.text) sh.text(PAD, 392, 720, 60, [{ runs: [{ text: sl.text, size: 22, color: "DFE3E8" }] }], { name: "Subtitle" });
      break;
    case "section":
      sh.box(PAD, 200, 56, 5, look.primary, { round: 2 });
      sh.text(PAD, 220, 760, 110, [{ runs: [{ text: sl.title, size: 46, bold: true, color: "FFFFFF" }] }], { name: "Title" });
      if (sl.text) sh.text(PAD, 336, 720, 70, [{ runs: [{ text: sl.text, size: 21, color: "DFE3E8" }] }]);
      break;
    case "quote":
      if (sl.title) sh.text(PAD, 150, 760, 24, [{ runs: [{ text: sl.title.toUpperCase(), size: 14, bold: true, color: look.heroSoft }] }]);
      sh.box(PAD, 184, 5, 170, look.primary, { round: 2 });
      sh.text(PAD + 30, 180, 760, 150, [{ runs: [{ text: sl.text, size: sl.text.length > 160 ? 28 : 34, bold: true, color: "FFFFFF" }] }], { name: "Quote" });
      if (sl.by) sh.text(PAD + 30, 340, 700, 30, [{ runs: [{ text: sl.by, size: 18, color: look.heroSoft }] }]);
      break;
    case "bullets":
      head(sl.title);
      sh.box(PAD, top, W - PAD * 2, 330, "FFFFFF", { round: 14, line: LINE, name: "Panel" });
      sh.text(PAD + 22, top + 20, W - PAD * 2 - 44, 290, bulletsParas(sl.bullets, sl.bullets.length > 4 ? 18 : sl.bullets.length > 3 ? 20 : 22, look.bars), { name: "Bullets" });
      break;
    case "two_column": {
      head(sl.title);
      const cw = (W - PAD * 2 - 20) / 2;
      [sl.left, sl.right].forEach((c, k) => {
        const x = PAD + k * (cw + 20);
        const color = k === 0 ? look.bars : look.primary;
        sh.box(x, top, cw, 330, "FFFFFF", { round: 14, line: LINE });
        sh.box(x, top, cw, 4, color);
        sh.text(x + 22, top + 20, cw - 44, 290, [...(c.heading ? [{ runs: [{ text: c.heading, size: 20, bold: true }], spaceAfter: 10 } as Para] : []), ...bulletsParas(c.bullets, 17, color)]);
      });
      break;
    }
    case "stats": {
      head(sl.title);
      const n = sl.stats.length;
      const cw = (W - PAD * 2 - 16 * (n - 1)) / n;
      sl.stats.forEach((t, k) => {
        const x = PAD + k * (cw + 16);
        sh.box(x, top, cw, 200, "FFFFFF", { round: 14, line: LINE });
        sh.box(x, top, cw, 4, look.bars);
        sh.text(x + 20, top + 20, cw - 40, 170, [
          { runs: [{ text: t.value, size: t.value.length > 7 ? 30 : t.value.length > 5 ? 38 : 52, bold: true, color: look.bars }], spaceAfter: 6 },
          { runs: [{ text: t.label, size: 17, bold: true }], spaceAfter: 6 },
          ...(t.note ? [{ runs: [{ text: t.note, size: 14, color: MUTED }] }] : []),
        ]);
      });
      if (sl.text) sh.text(PAD, top + 220, W - PAD * 2, 90, [{ runs: [{ text: sl.text, size: 19, color: "3D4B5C" }] }]);
      break;
    }
    case "image_notes":
      head(sl.title);
      sh.box(PAD, top, 380, 290, "FFFFFF", { round: 14, line: LINE });
      if (picRel && pic) sh.picture(picRel, PAD + 8, top + 8, 364, 274, pic);
      else sh.text(PAD, top, 380, 290, [{ runs: [{ text: "Picture not available", size: 14, color: MUTED }], align: "ctr" }], { anchor: "ctr" });
      if (sl.caption) sh.text(PAD, top + 296, 380, 24, [{ runs: [{ text: sl.caption, size: 14, color: MUTED }] }]);
      sh.text(PAD + 408, top, W - PAD * 2 - 408, 320, bulletsParas(sl.bullets, 17, look.primary));
      break;
    case "scorecard":
      head(sl.title);
      sl.rows.forEach((r, k) => {
        const t = TONE[r.tone];
        const y = top + k * 62;
        sh.box(PAD, y, W - PAD * 2, 54, "FFFFFF", { round: 10, line: LINE });
        sh.box(PAD, y, 5, 54, t.fg);
        sh.text(PAD + 18, y + 14, 74, 26, [{ runs: [{ text: t.label, size: 14, bold: true, color: t.fg }], align: "ctr" }], { fill: t.bg, anchor: "ctr" });
        sh.text(PAD + 108, y, 230, 54, [{ runs: [{ text: r.label, size: 19, bold: true }] }], { anchor: "ctr" });
        sh.text(PAD + 350, y, W - PAD * 2 - 366, 54, [{ runs: [{ text: r.note, size: 16, color: "3D4B5C" }] }], { anchor: "ctr" });
      });
      break;
    case "table":
      head(sl.title);
      sh.table(PAD, top, W - PAD * 2, sl.columns, sl.cells, look.hero, sl.cells.length > 6 || sl.columns.length > 5 ? 14 : 16);
      if (sl.note) sh.text(PAD, top + (sl.cells.length + 1) * (sl.cells.length > 6 || sl.columns.length > 5 ? 30 : 34) + 12, W - PAD * 2, 50, [{ runs: [{ text: sl.note, size: 15, color: MUTED }] }]);
      break;
    case "bars": {
      head(sl.title);
      const max = Math.max(...sl.bars.map((b) => Math.abs(b.value)), 0) || 1;
      const gap = sl.bars.length > 5 ? 38 : 50;
      const h = sl.bars.length > 5 ? 26 : 34;
      const trackX = PAD + 210;
      const trackW = W - PAD * 2 - 210 - 110;
      sh.box(PAD, top, W - PAD * 2, Math.min(330, sl.bars.length * gap + 28), "FFFFFF", { round: 14, line: LINE });
      sl.bars.forEach((b, k) => {
        const y = top + 20 + k * gap;
        const color = b.tone ? TONE[b.tone].fg : k === 0 ? look.bars : look.primary;
        sh.text(PAD + 20, y, 186, h, [{ runs: [{ text: b.label, size: 16, bold: true }] }], { anchor: "ctr" });
        sh.box(trackX, y, trackW, h, SURFACE, { round: 6 });
        sh.box(trackX, y, Math.max(4, (Math.abs(b.value) / max) * trackW), h, color, { round: 6, name: `Bar ${b.label}` });
        sh.text(trackX + trackW + 8, y, 92, h, [{ runs: [{ text: b.display, size: 17, bold: true }], align: "r" }], { anchor: "ctr" });
      });
      if (sl.note) sh.text(PAD, top + Math.min(330, sl.bars.length * gap + 28) + 12, W - PAD * 2, 50, [{ runs: [{ text: sl.note, size: 15, color: MUTED }] }]);
      break;
    }
  }
  // The footer: Kaizen, the deck's title, the page number
  const mute = dark ? "C9CED6" : MUTED;
  sh.text(PAD, H - 40, 600, 22, [{ runs: [{ text: "kaizen", size: 16, bold: true, color: dark ? "FFFFFF" : look.primary }, { text: `   ${input.title}`, size: 14, color: mute }] }], { name: "Footer" });
  sh.text(W - PAD - 100, H - 40, 100, 22, [{ runs: [{ text: `${i + 1} / ${total}`, size: 14, color: mute }], align: "r" }], { name: "Page number" });
  const bg = dark ? look.hero : SURFACE;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${sh.parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: { id: string; type: string; target: string }[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Kaizen"><a:themeElements><a:clrScheme name="Kaizen"><a:dk1><a:srgbClr val="${INK}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A37"/></a:dk2><a:lt2><a:srgbClr val="${SURFACE}"/></a:lt2><a:accent1><a:srgbClr val="E0262F"/></a:accent1><a:accent2><a:srgbClr val="1F3B5C"/></a:accent2><a:accent3><a:srgbClr val="087A5E"/></a:accent3><a:accent4><a:srgbClr val="8A5A00"/></a:accent4><a:accent5><a:srgbClr val="C23E4C"/></a:accent5><a:accent6><a:srgbClr val="${MUTED}"/></a:accent6><a:hlink><a:srgbClr val="1F3B5C"/></a:hlink><a:folHlink><a:srgbClr val="${MUTED}"/></a:folHlink></a:clrScheme><a:fontScheme name="Kaizen"><a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Kaizen"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/** The deck as a .pptx file */
export function deckPptx(input: PptxInput): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[path] = strToU8(text));
  const media: string[] = [];
  const slides = input.slides;
  slides.forEach((sl, i) => {
    const n = i + 1;
    const pic = sl.kind === "image_notes" && sl.image ? (input.pictures.get(sl.image) ?? null) : null;
    const items = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    let picRel: string | null = null;
    if (pic) {
      const name = `image${media.length + 1}.jpeg`;
      media.push(name);
      files[`ppt/media/${name}`] = pic.bytes;
      picRel = "rId2";
      items.push({ id: picRel, type: "image", target: `../media/${name}` });
    }
    put(`ppt/slides/slide${n}.xml`, slideXml(sl, i, slides.length, input, picRel, pic));
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(items));
  });
  const ids = slides.map((_, i) => i + 1);
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${ids.map((n) => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
  );
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(input.title)}</dc:title><dc:creator>Kaizen Marketing</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  put("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Kaizen OS</Application><Slides>${slides.length}</Slides></Properties>`);
  put(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${E(W)}" cy="${E(H)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
  );
  const last = slides.length + 1;
  put(
    "ppt/_rels/presentation.xml.rels",
    rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...ids.map((n) => ({ id: `rId${n + 1}`, type: "slide", target: `slides/slide${n}.xml` })),
      { id: `rId${last + 1}`, type: "presProps", target: "presProps.xml" },
      { id: `rId${last + 2}`, type: "viewProps", target: "viewProps.xml" },
      { id: `rId${last + 3}`, type: "theme", target: "theme/theme1.xml" },
      { id: `rId${last + 4}`, type: "tableStyles", target: "tableStyles.xml" },
    ]),
  );
  put("ppt/presProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentationPr ${NS}/>`);
  put("ppt/viewProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put("ppt/tableStyles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  put("ppt/theme/theme1.xml", THEME);
  put("ppt/slideMasters/slideMaster1.xml", MASTER);
  put("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }, { id: "rId2", type: "theme", target: "../theme/theme1.xml" }]));
  put("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]));
  // [Content_Types].xml first, as Office expects
  const ordered: Record<string, Uint8Array> = { "[Content_Types].xml": files["[Content_Types].xml"] };
  for (const [k, v] of Object.entries(files)) if (k !== "[Content_Types].xml") ordered[k] = v;
  return zipSync(ordered, { level: 6 });
}
