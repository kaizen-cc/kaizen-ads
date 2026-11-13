import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { briefPdf, type BriefPdfInput } from "@/lib/brief-pdf";
import { fitStructure, headerLine, picked, slidesFor, versionCount, versionsStrip, type PdfCounts, type PdfFormat, type StructureSource } from "@/lib/brief-pdf-model";
import { composeBrief, emptySpec, exportLineFor, fileNamesFor, parseBrief, type BriefSpec } from "@/lib/brief-spec";
import { openFacts, withDetectedFacts } from "@/lib/brief-facts";

// The PDF the maker works from holds everything the brief holds, word for word. A CrowdSync video brief had 6 asset
// needs and 3 questions for the client; the PDF showed 5 needs and its 3rd question as "Check before making it." (text
// that exists nowhere in the brief), four exports in a row, so the editor missed the V3 asset and the clip-clearance
// question. Each format is rendered with 6 needs, 3 questions and 4 versions with different bodies, and the PDF's own
// text is read back: every item is there, the placeholder never is, the headings say what the content says, every
// version has its file names, no page is left near blank and no two lines of text draw over each other.

const OUT = process.env.BRIEF_PDF_OUT ?? path.join(tmpdir(), "kaizen-brief-samples");

type Item = { str: string; x: number; y: number; w: number; h: number };

/** The rendered PDF's text, page by page, with where each piece sits */
async function read(pdf: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fonts = `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").replace(/\\/g, "/")}/`;
  const doc = await pdfjs.getDocument({ data: pdf.slice(), standardFontDataUrl: fonts }).promise;
  const pages: { text: string; items: Item[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    const items = c.items
      .filter((x) => "str" in x && x.str.trim())
      .map((x) => {
        const t = x as { str: string; transform: number[]; width: number; height: number };
        return { str: t.str, x: t.transform[4], y: t.transform[5], w: t.width, h: t.height || Math.abs(t.transform[3]) };
      });
    pages.push({ text: items.map((x) => x.str).join(" "), items });
  }
  return { pages, all: pages.map((p) => p.text).join("\n") };
}

/** Quotes, dashes, arrows and spacing aside (the PDF curls quotes, letter-spaces labels and wraps lines) */
const norm = (s: string) =>
  s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s*(→|->|›)\s*/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
const has = (text: string, phrase: string) => norm(text).includes(norm(phrase));

/** Pieces of text on one page that draw over each other (more than a sliver) */
function overlaps(items: Item[]) {
  const out: string[] = [];
  for (let a = 0; a < items.length; a++)
    for (let b = a + 1; b < items.length; b++) {
      const p = items[a];
      const q = items[b];
      const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (w > 2 && h > Math.min(p.h, q.h) * 0.45) out.push(`"${p.str}" over "${q.str}"`);
    }
  return out;
}

const NEEDS = [
  "Need: Crowd shot from the Oct 18 show, the wide one from the balcony",
  "Need: The venue manager's 20s quote on how check-in used to take 40 minutes",
  "Client to shoot: A phone clip of the scanner turning green at the gate",
  "Need: The stadium clip from the Sept 3 match, cleared for paid use (for V3)",
  "Need: Logo files, white and black versions",
  "Need: Two screenshots of the CrowdSync dashboard on a busy night",
];
const QUESTIONS = [
  "Is the 12,000 fans figure from the Oct 18 show the number we can say?",
  "Which venue manager can we name on screen, and with what title?",
  "Is the stadium clip cleared for paid ads? Don't start V3 until the client confirms the clearance.",
];
const asset = (line: string) => {
  const m = /^(Need|Client to shoot):\s*(.+)$/.exec(line)!;
  return { item: m[2], status: m[1] === "Need" ? ("need" as const) : ("shoot" as const) };
};

const base: Partial<BriefSpec> = {
  stage: "Evergreen TOF",
  insight: "Venues on CrowdSync cut gate lines from 40 minutes to under 5 at the Oct 18 show, and their managers say it in their own words.",
  insightSource: "Client call Oct 21",
  who: "Venue operations leads who dread opening night lines",
  dos: ["Logo in the first 3 seconds", "Captions burned in", "The real dashboard only", "Name the venue manager only once confirmed", "Licensed music low under the voice", "A sixth must that the PDF keeps"],
  donts: ["No stock crowds", "No competitor names", "No price or discount", "No staff faces without releases", "No AI voices", "A sixth never that the PDF keeps"],
  yourCall: "Edit style, cut points, transitions and which clips within the folders are yours.",
  assets: NEEDS.map(asset),
  copy: ["Primary: Lines at the gate cost you the first song. CrowdSync fixes that.", "Headline: From 40 minutes to 5", "CTA: Book a demo"],
  confirm: QUESTIONS.map((q) => ({ question: q, answer: "", source: "" })),
};

const VIDEO_VERSIONS = [
  "Opening night, 40 minutes at the gate. (net new)",
  "What if the line was gone by the first song? | Also changes: the manager quote moves to beat 2",
  "12,000 fans, one gate, under 5 minutes. | Also changes: the stadium clip replaces the crowd shot in beat 3",
  "Your venue manager will thank you. | Also changes: the dashboard screenshots carry beat 4",
];

const video: Partial<BriefSpec> = {
  ...base,
  length: "~20s",
  beats: [
    '0:00-0:03 | Hook | On screen: the line outside the venue | Text: "Opening night. 40 minutes at the gate." | Says: "Not anymore." (Source: manager 0:02)',
    '0:03-0:08 | The fix | On screen: the scanner turning green | Text: "Under 5 minutes with CrowdSync"',
    "0:08-0:14 | Proof | On screen: the crowd shot from the Oct 18 show | Text: \"12,000 fans, one gate\"",
    "0:14-0:20 | End card | On screen: logo and Book a demo",
  ],
  audio: "Licensed music, low under the manager's voice.",
  versions: VIDEO_VERSIONS,
};
const image: Partial<BriefSpec> = {
  ...base,
  frame: ["Headline: From 40 minutes to 5", "Subline: CrowdSync at the Oct 18 show", "Shows: the gate with the scanner green", "Reads first: the headline, then the scanner, then the button", "CTA: Book a demo"],
  versions: ['"From 40 minutes to 5" on the gate photo (net new)', '"12,000 fans, one gate" on the stadium photo | Also changes: the stadium clip still replaces the gate photo', '"The line was gone by the first song" on the crowd photo', "V1's design with the headline \"Your gate, fixed\""],
};
const carousel: Partial<BriefSpec> = {
  ...base,
  slides: ["Hook | Headline: 40 minutes at the gate | Shows: the line outside", "Problem | Headline: The first song, missed | Shows: the empty floor", "Proof | Headline: 12,000 fans, one gate | Shows: the crowd shot", "Payoff | Headline: Under 5 minutes | Shows: the scanner green", "CTA | Headline: Book a demo | Shows: the logo and the button"],
  versions: ["40 minutes at the gate (net new)", "The first song, missed | Also changes: slides 2 and 3 swap", "12,000 fans, one gate | Also changes: the stadium clip still on slide 3", "Your gate, fixed"],
};

async function render(name: string, f: PdfFormat, sp: Partial<BriefSpec>, counts: PdfCounts) {
  const src: StructureSource = { title: "Gone by the First Song", angle: "", audience: "", brief: composeBrief("CrowdSync takes opening-night gate lines from 40 minutes to under 5, said by the venue manager who lived it.", { ...emptySpec(), ...sp }), formats: { [f]: counts } };
  const structure = fitStructure(null, src, false);
  const fs = picked(src.formats);
  const sizes = ["4x5", "9x16"];
  const spec = withDetectedFacts(parseBrief(src.brief).spec, src.title);
  const cnt = { versions: versionCount(src.formats), slides: slidesFor(src.formats) };
  const b: BriefPdfInput = {
    client: "CrowdSync",
    title: src.title,
    number: null,
    header: headerLine(src.formats, sizes, structure.stage),
    sizes,
    due: "Tue, Nov 17",
    makers: ["The video editor"],
    priority: "normal",
    versions: versionsStrip(src.formats, null),
    measure: f === "video" ? { label: "Length", value: structure.length } : f === "carousel" ? { label: "Slides", value: String(cnt.slides) } : null,
    references: [],
    structure,
    exportLine: exportLineFor(fs, sizes, "CrowdSync", src.title, cnt),
    files: fileNamesFor(fs, sizes, "CrowdSync", src.title, cnt),
    links: [],
    formats: fs,
    by: "The strategist",
    confirm: openFacts(spec).map((x) => x.question),
    drive: { headquarters: "https://drive.google.com/drive/folders/hq123", adCreatives: "https://drive.google.com/drive/folders/ads456" },
  };
  const pdf = await briefPdf(b);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `kaizen-brief-complete-${name}.pdf`), pdf);
  return { ...(await read(pdf)), b };
}

describe("the brief PDF holds everything the brief holds", () => {
  for (const [f, sp, counts] of [
    ["video", video, { new: 1, variations: 3 }],
    ["image", image, { new: 2, variations: 2 }],
    ["carousel", carousel, { new: 1, variations: 3, cards: 5 }],
  ] as const) {
    it(`${f}: every asset, question, Must, Never and version, word for word, and file names for every version`, { timeout: 60_000 }, async () => {
      const r = await render(f, f, sp, counts);
      for (const n of NEEDS) expect(has(r.all, n.replace(/^(Need|Client to shoot):\s*/, "")), n).toBe(true);
      for (const q of QUESTIONS) expect(has(r.all, q), q).toBe(true);
      for (const x of [...base.dos!, ...base.donts!]) expect(has(r.all, x), x).toBe(true);
      expect(r.all).not.toMatch(/Check before making it/i);
      // The question that blocks the work sits under a blocker heading, the others under "doesn't hold the work"
      expect(has(r.all, "Blocker · confirm before it runs")).toBe(true);
      expect(has(r.all, "Confirm with client · doesn't hold the work")).toBe(true);
      const at = (s: string) => norm(r.all).indexOf(norm(s));
      expect(at(QUESTIONS[2])).toBeGreaterThan(at("Blocker · confirm before it runs"));
      // Every version's line, and what else changes
      for (const v of sp.versions!) {
        const line = v.split(" | ")[0].replace(/\s*\(net new\)$/, "");
        const quoted = /"([^"]+)"/.exec(line)?.[1] ?? line;
        expect(has(r.all, quoted), v).toBe(true);
        const also = /\| Also changes: (.+)$/.exec(v)?.[1];
        if (also) expect(has(r.all, also), also).toBe(true);
      }
      // "only the hook changes" never sits over versions whose bodies change
      expect(r.all).not.toMatch(/only the (?:hook|headline) changes/i);
      // File names for every version, a carousel's slides one by one
      for (const row of r.b.files!) for (const name of row.names) expect(has(r.all, name), name).toBe(true);
      expect(r.b.files!.map((x) => x.version)).toEqual(["V1", "V2", "V3", "V4"]);
      // No page near blank, no text drawn over other text
      expect(r.pages.length).toBeLessThanOrEqual(3);
      // (the slim bar and the footer alone are about 150 characters: a page needs real content past them)
      for (const [i, p] of r.pages.entries()) expect(p.text.replace(/\s+/g, "").length, `page ${i + 1}`).toBeGreaterThan(400);
      for (const [i, p] of r.pages.entries()) expect(overlaps(p.items), `page ${i + 1}`).toEqual([]);
    });
  }

  it("says only the hook changes when the versions really share the body", { timeout: 60_000 }, async () => {
    const r = await render("video-shared", "video", { ...video, versions: ["Opening night, 40 minutes at the gate.", "What if the line was gone by the first song?", "Your gate, fixed."] }, { new: 1, variations: 2 });
    expect(has(r.all, "only the hook changes; V1 is net new")).toBe(true);
  });
});
