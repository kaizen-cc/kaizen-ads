import "server-only";
import { AlignmentType, BorderStyle, Document, Footer, ImageRun, LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType, type ParagraphChild } from "docx";
import type { EmailSow, Lead, Stat, Table as SowTable } from "./core";

// The email SOW as a Word file in Kaizen's document look (the reference Sprint Recap & Ongoing Management SOW): Arial,
// brand red #B21E2C, black #060606 table heads, #F2F2F2 zebra rows and callouts with a red left rule, #D9D9D9 borders,
// a red eyebrow over each section heading, red stat tiles, a signature table and a footer. Opens in Word or Google Docs.

const RED = "B21E2C";
const BLACK = "060606";
const GREY = "F2F2F2";
const RULE = "D9D9D9";
const BODY = "333333";
const FONT = "Arial";
const PAGE = 9360; // twips across the text block (US Letter, 1" margins)

const run = (text: string, o: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {}) => new TextRun({ text, font: FONT, bold: o.bold, italics: o.italics, color: o.color ?? BODY, size: o.size ?? 21 });

const para = (children: ParagraphChild[] | string, o: { after?: number; before?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) =>
  new Paragraph({ children: typeof children === "string" ? [run(children)] : children, spacing: { after: o.after ?? 160, before: o.before ?? 0, line: 300 }, alignment: o.align });

const h1 = (text: string, eyebrow: string | null) => [
  new Paragraph({ children: [run(text, { bold: true, color: BLACK, size: 40 })], spacing: { before: 360, after: eyebrow ? 60 : 200 }, pageBreakBefore: true }),
  ...(eyebrow ? [new Paragraph({ children: [run(eyebrow, { bold: true, color: RED, size: 18 })], spacing: { after: 220 } })] : []),
];
const h2 = (text: string) => new Paragraph({ children: [run(text, { bold: true, color: BLACK, size: 28 })], spacing: { before: 300, after: 140 }, keepNext: true });
const bullet = (children: ParagraphChild[]) => new Paragraph({ children, numbering: { reference: "dots", level: 0 }, spacing: { after: 100, line: 290 } });
const leadBullet = (l: Lead) => bullet([run(`${l.lead} `, { bold: true, color: BLACK }), run(l.text)]);
const plainBullet = (t: string) => bullet([run(t)]);

const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const thin = { style: BorderStyle.SINGLE, size: 4, color: RULE };

/** A data table: black head row, zebra body, a bold total row */
function table(t: SowTable): Table {
  const cols = t.head.length;
  const first = cols > 3 ? Math.round(PAGE * 0.3) : Math.round(PAGE * 0.4);
  const rest = Math.floor((PAGE - first) / Math.max(1, cols - 1));
  const widths = t.head.map((_, i) => (i === 0 ? first : rest));
  const cell = (text: string, i: number, o: { head?: boolean; fill?: string; bold?: boolean }) =>
    new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: o.head ? BLACK : (o.fill ?? "FFFFFF"), color: "auto" },
      margins: { top: 90, bottom: 90, left: 120, right: 120 },
      verticalAlign: VerticalAlign.CENTER,
      borders: { top: thin, bottom: thin, left: thin, right: thin },
      children: [new Paragraph({ children: [run(text, { bold: o.head || o.bold, color: o.head ? "FFFFFF" : BODY, size: o.head ? 18 : 19 })], spacing: { after: 0 } })],
    });
  const rows = [
    new TableRow({ tableHeader: true, children: t.head.map((h, i) => cell(h, i, { head: true })) }),
    ...t.rows.map((r, n) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, { fill: n % 2 ? GREY : "FFFFFF" })) })),
    ...(t.total ? [new TableRow({ cantSplit: true, children: t.total.map((c, i) => cell(c, i, { fill: t.rows.length % 2 ? GREY : "FFFFFF", bold: true })) })] : []),
  ];
  return new Table({ width: { size: PAGE, type: WidthType.DXA }, columnWidths: widths, rows });
}

/** A grey box with a red rule down the left, its first words bold ("The trend that matters:") */
function callout(text: string): Table {
  const at = text.indexOf(":");
  const kids = at > 0 && at < 50 ? [run(text.slice(0, at + 1), { bold: true, color: BLACK }), run(text.slice(at + 1))] : [run(text)];
  return new Table({
    width: { size: PAGE, type: WidthType.DXA },
    columnWidths: [PAGE],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: PAGE, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: GREY, color: "auto" },
            margins: { top: 160, bottom: 160, left: 220, right: 220 },
            borders: { top: none, bottom: none, right: none, left: { style: BorderStyle.SINGLE, size: 36, color: RED } },
            children: [new Paragraph({ children: kids, spacing: { after: 0, line: 300 } })],
          }),
        ],
      }),
    ],
  });
}

/** The red stat tiles */
function tiles(stats: Stat[]): Table {
  const w = Math.floor(PAGE / stats.length);
  const white = { style: BorderStyle.SINGLE, size: 24, color: "FFFFFF" };
  return new Table({
    width: { size: PAGE, type: WidthType.DXA },
    columnWidths: stats.map(() => w),
    rows: [
      new TableRow({
        children: stats.map(
          (s) =>
            new TableCell({
              width: { size: w, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: RED, color: "auto" },
              margins: { top: 200, bottom: 200, left: 140, right: 140 },
              verticalAlign: VerticalAlign.CENTER,
              borders: { top: white, bottom: white, left: white, right: white },
              children: [
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run(s.value, { bold: true, color: "FFFFFF", size: 36 })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(s.label, { color: "FFFFFF", size: 17 })] }),
              ],
            }),
        ),
      }),
    ],
  });
}

const gap = (after = 200) => new Paragraph({ children: [], spacing: { after } });

function signature(client: string): Table {
  const half = Math.floor((PAGE - 600) / 2);
  const side = (who: string) =>
    new TableCell({
      width: { size: half, type: WidthType.DXA },
      borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLACK }, bottom: none, left: none, right: none },
      margins: { top: 100 },
      children: [new Paragraph({ children: [run(who, { bold: true, color: BLACK })], spacing: { after: 40 } }), new Paragraph({ children: [run("Name, title and date", { color: "777777", size: 18 })] })],
    });
  return new Table({
    width: { size: PAGE, type: WidthType.DXA },
    columnWidths: [half, 600, half],
    rows: [new TableRow({ children: [side(client), new TableCell({ width: { size: 600, type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none }, children: [new Paragraph("")] }), side("Kaizen Marketing Agency")] })],
  });
}

export type DocxImages = { agency: Buffer | null; client: Buffer | null };

/** The SOW as a .docx file */
export async function sowDocx(d: EmailSow, images: DocxImages): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [];
  const push = (...x: (Paragraph | Table | null | false)[]) => body.push(...x.filter((v): v is Paragraph | Table => Boolean(v)));
  const mark = (data: Buffer, w: number, h: number) => new ImageRun({ type: "png", data, transformation: { width: w, height: h } });

  // Cover
  const marks: ParagraphChild[] = [];
  if (images.agency) marks.push(mark(images.agency, 130, 44));
  if (images.agency && images.client) marks.push(run("      "));
  if (images.client) marks.push(mark(images.client, 130, 44));
  if (marks.length) push(new Paragraph({ children: marks, spacing: { before: 600, after: 600 } }));
  push(
    new Paragraph({ children: [run(`KAIZEN  x  ${d.client.toUpperCase()}`, { bold: true, color: RED, size: 22 })], spacing: { before: marks.length ? 0 : 1600, after: 240 } }),
    new Paragraph({ children: [run("Sprint Recap &", { bold: true, color: BLACK, size: 60 })], spacing: { after: 0 } }),
    new Paragraph({ children: [run("Ongoing Management SOW", { bold: true, color: BLACK, size: 60 })], spacing: { after: 240 } }),
    new Paragraph({ children: [run(d.subtitle, { color: "555555", size: 28 })], spacing: { after: 900 } }),
    para([run("Prepared for: ", { bold: true, color: BLACK }), run(`${d.contact}, ${d.client}`)], { after: 60 }),
    para([run("Prepared by: ", { bold: true, color: BLACK }), run("Kaizen Marketing Agency")], { after: 60 }),
    para([run(d.dated)], { after: 0 }),
  );

  if (d.recap) {
    push(...h1(d.recap.heading, "SECTION 1 | SPRINT WRAP-UP"));
    d.recap.paragraphs.forEach((p) => push(para(p)));
    if (d.recap.stats.length) push(gap(80), tiles(d.recap.stats), gap(120));
    if (d.recap.built.length) push(h2("What We Built Together"), ...d.recap.built.map(leadBullet));
  }
  if (d.numbers) {
    const n = d.numbers;
    push(...h1("The Numbers", `SECTION ${d.recap ? 2 : 1} | REVENUE & PERFORMANCE`), para(n.intro), h2(n.totalHeading));
    if (n.totalText) push(para(n.totalText));
    if (n.sources) push(table(n.sources), gap());
    push(h2("What Kaizen's Sends Drove"));
    if (n.sendsText) push(para(n.sendsText));
    if (n.campaigns) push(table(n.campaigns), gap(160));
    if (n.campaignsCallout) push(callout(n.campaignsCallout), gap());
    if (n.channels || n.channelsCallout) push(h2("Performance by Channel"));
    if (n.channels) push(table(n.channels), gap(160));
    if (n.channelsCallout) push(callout(n.channelsCallout), gap());
  }
  const sec = (k: number) => k + (d.recap ? 1 : 0) + (d.numbers ? 1 : 0);
  if (d.deliverability) {
    push(...h1("Where Deliverability Stands", `SECTION ${sec(1)} | THE HONEST PICTURE`), ...d.deliverability.paragraphs.map((p) => para(p)));
    if (d.deliverability.metrics) push(table(d.deliverability.metrics), gap());
    if (d.deliverability.levers.length) push(h2("What Moves the Score"), ...d.deliverability.levers.map(leadBullet));
  }
  const s = d.scope;
  push(...h1("Building on the Momentum", `SECTION ${sec(d.deliverability ? 2 : 1)} | ONGOING MANAGEMENT SCOPE OF WORK`));
  if (s.intro) push(para(s.intro));
  push(h2(s.startHeading));
  if (s.startText) push(para(s.startText));
  push(table(s.pricing), gap(120), para([run(s.startLine, { bold: true, color: BLACK })]));
  for (const b of s.included) {
    push(h2(b.heading));
    if (b.intro) push(para(b.intro));
    push(...b.bullets.map(plainBullet));
  }
  push(h2("Ongoing Management Tiers"), table(s.tiers), gap(120));
  if (s.tiersNote) push(para([run(s.tiersNote, { italics: true })]));
  if (s.nextTier) {
    push(h2(`The Path to ${s.nextTier}`));
    if (s.pathText) push(para(s.pathText));
    if (s.triggers) push(table(s.triggers), gap(160));
    if (s.triggersCallout) push(callout(s.triggersCallout), gap());
  }
  if (s.ninetyDays) push(h2("What Success Looks Like: First 90 Days"), table(s.ninetyDays), gap());
  if (s.needs.length) push(h2(`What Kaizen Needs From ${d.client}`), ...s.needs.map(leadBullet));
  if (s.outOfScope.length) push(h2("Out of Scope"), ...s.outOfScope.map(plainBullet));
  if (s.roadmap.length) push(h2("Future Automation Roadmap"), para(s.roadmapIntro), ...s.roadmap.map(leadBullet));

  push(...h1(d.closing.heading, null), para(d.closing.paragraph), h2("Next Steps"), ...d.closing.nextSteps.map(plainBullet), gap(600), signature(d.client));

  const doc = new Document({
    creator: "Kaizen Marketing Agency",
    title: `Kaizen x ${d.client}: ${d.title}`,
    styles: { default: { document: { run: { font: FONT, size: 21, color: BODY } } } },
    numbering: { config: [{ reference: "dots", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } }, run: { color: RED } } }] }] },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(`Kaizen Marketing Agency  |  ${d.client}  |  `, { size: 16, color: "888888" }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: "888888" })] })],
          }),
        },
        children: body,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
