import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { briefPdf, type BriefPdfInput } from "@/lib/brief-pdf";
import { allotmentDraw, fitStructure, formatChips, headerLine, needsStructure, picked, plainStructure, slidesFor, specsChecklist, structureKey, versionsStrip, type PdfCounts, type PdfFormat, type StructureSource } from "@/lib/brief-pdf-model";
import { composeBrief, emptySpec, exportLineFor, type BriefSpec } from "@/lib/brief-spec";
import { structureBrief } from "@/lib/brief-pdf-data";

// The branded brief PDF in the brief's one structure: two pages (the idea, then the guardrails), the build by format
// (a video's beats, a carousel's slides, a single image's frame), lists capped at five. A brief in today's sections is
// read as it is with no AI; an older one is read plainly when the AI can't run, and the AI only fills what it leaves
// empty. Renders a sample per format (BRIEF_PDF_OUT: a folder to keep them in).

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), ...p });
const OUT = process.env.BRIEF_PDF_OUT ?? join(tmpdir(), "kaizen-brief-samples");

const oldBrief = `Show the Friday night crowd what they're missing: the patio at golden hour, the fire pits, the margarita flight.

Concepts:
1. The patio at golden hour
   Hook: Your Friday, sorted.
   Visual: Wide shot of the full patio at sunset, string lights on, a flight on the table in the foreground
   Copy: Fridays on the patio

Hooks to try:
- Your Friday, sorted.
- The best seat in town is outside.
- Fire pits are lit.

Don't show empty tables.
Never use stock photos of food.
Use the Drive photos from the October shoot.`;

const oldSource: StructureSource = { title: "Patio Fridays", angle: "Weekend plans, sorted", audience: "Locals 25 to 45 who go out on Fridays", brief: oldBrief, formats: { image: { new: 1, variations: 4 } }, landing: "https://example.com/patio" };

const MUST = ["Logo on screen in the first 3 seconds", "Burn in captions on every spoken line", "Cover most of the owner's voice with real B-roll", "Licensed music only, low under the owner", "Keep text and faces in the safe zone", "A sixth must that gets cut"];
const NEVER = ["Don't use: 'two great offices', the call or sales rep part, the VIP lounge", "No price, deals, urgency or specific events", "No dates, scoreboards, posters or artist close-ups", "No screen recordings of the website", "No AI-made people, voices or venues", "A sixth never that gets cut"];
const ASSETS = [
  { item: "Owner interview (Drive: Interviews / Owner), the full answer https://drive.google.com/file/d/owner1/view", status: "have" as const },
  { item: "Staff and seat views (Drive: B-roll), staff at work and seat views https://drive.google.com/drive/folders/broll", status: "have" as const },
  { item: "Look and seats (Drive: Style), the style reference https://drive.google.com/drive/folders/style", status: "have" as const },
  { item: "Seat views without dates or scoreboards", status: "need" as const },
];
const COPY = ["Primary: Real seats, real views, and a local team that knows the venue. Find yours at the site.", "Primary: Our ticket experts are here to help, start to finish.", "Headline: Best Seats, Best Service", "Headline: Know the venue before you buy", "CTA: Shop Now"];

const videoSpec = spec({
  stage: "Evergreen TOF",
  insight: "Asked why people should buy from them, the owner answers in one word: convenience. A real local team and more than one way to buy.",
  insightSource: "Owner interview on Drive",
  who: "Cold fans who want good seats from people they trust",
  length: "~30s",
  beats: [
    '0:00-0:05 | Hook | On screen: The owner on camera; hook text and logo from frame 1, pop "Convenience" when he says it | Text: "This is the detail most people miss when buying tickets" | Says: "Why should someone buy from us?" "Convenience." (Source: Owner interview 0:00-0:04)',
    '0:05-0:09 | The team | On screen: B-roll of the staff at work | Says: "Come by and see us. We got a team full of experts ready to help you." (Source: Owner interview 0:12-0:16)',
    '0:09-0:15 | Your way | On screen: The owner on camera, then a seat view with the site on screen | Says: "If you like shopping online, you can shop online." (Source: Owner interview 0:17-0:24)',
    '0:15-0:21 | Start to finish | On screen: Arena entrance, aisle, seat view, crowd | Says: "We set you up from the beginning to the end." (Source: Owner interview 0:29-0:35)',
    '0:21-0:27 | The difference | On screen: Crowd B-roll, then the owner on camera for the last line | Says: "A lot different than just a ticket sales website." (Source: Owner interview 0:44-0:50)',
    "0:27-0:30 | End card | On screen: Seat view, logo, the site and the tagline",
  ],
  audio: "Music only, licensed, low under the owner.",
  versions: ["This is the detail most people miss when buying tickets", "Why buy tickets from a local team?", "One word: convenience"],
  dos: MUST,
  donts: NEVER,
  yourCall: "Edit style, cut points, transitions, which clips within the folders, and music within the rules are yours.",
  assets: ASSETS,
  copy: COPY,
  confirm: [{ question: "Does checkout on the site work again after the Nov 6 error?", answer: "", source: "" }],
});
const carouselSpec = spec({
  stage: "Retargeting MOF",
  insight: "Section 112 sits right behind the home bench: you hear the coaches all game.",
  insightSource: "Brand Bible",
  who: "Fans who looked at seats and didn't buy",
  slides: [
    "Hook | Headline: The seat most fans skip | Shows: The arena from the upper deck, 112 circled",
    "Payoff | Headline: Section 112: behind the bench | Shows: The view from 112, the bench in frame",
    "Proof | Headline: You hear every timeout | Shows: A fan in 112 leaning in",
    "Proof | Headline: Same price as the corners | Shows: The seat map, 112 and a corner side by side",
    "CTA | Headline: Find your seat in 112 | Shows: The logo and the button",
  ],
  versions: ["The seat most fans skip", "Hear the coaches from your seat"],
  dos: ["Each slide works on its own", "Logo on the last slide"],
  donts: ["No prices or fees", "No player close-ups"],
  assets: ASSETS.slice(0, 3),
  copy: ["Primary: Behind the bench, where you hear every timeout.", "CTA: See Seats"],
});
const imageSpec = spec({
  stage: "Evergreen TOF",
  insight: "Their patio ads beat food-only ads on cost per reservation for three months.",
  insightSource: "Winning ads, Aug to Oct",
  who: "Locals deciding where to go on Friday night",
  frame: ["Headline: Fridays on the patio", "Subline: Fire pits lit from 5pm", "Shows: The full patio at golden hour, string lights on, a flight up front", "Reads first: The headline, then the flight, then the button", "CTA: Book a table"],
  versions: ["Fridays on the patio", "The best seat in town is outside", "Fire pits are lit"],
  dos: ["A full patio, people in frame", "Photos from the October shoot"],
  donts: ["No empty tables", "No stock food photos"],
  assets: ASSETS.slice(0, 2),
  copy: ["Primary: Fridays hit different on the patio.", "Headline: Your Friday, sorted", "CTA: Book now"],
});

const fixture = (f: PdfFormat, sp: BriefSpec, counts: PdfCounts, idea: string): StructureSource => ({ title: f === "video" ? "The Detail Most People Miss" : f === "carousel" ? "The Seat Most Fans Skip" : "Patio Fridays", angle: "", audience: "", brief: composeBrief(idea, sp), formats: { [f]: counts } });
const videoSource = fixture("video", videoSpec, { new: 1, variations: 2 }, "The owner's answer, Convenience, is the detail: a real local team and more than one way to buy.");
const carouselSource = fixture("carousel", carouselSpec, { new: 1, variations: 1, cards: 5 }, "Section 112 is the payoff: behind the bench, where you hear the coaches, at the same price.");
const imageSource = fixture("image", imageSpec, { new: 1, variations: 2 }, "Golden hour on the patio makes the Friday plan feel already made.");

describe("brief pdf model", () => {
  it("reads a brief in today's sections as it is, with no AI to run, capped to two pages", () => {
    const v = plainStructure(videoSource);
    expect(needsStructure(v, videoSource)).toBe(false);
    expect(v.beats).toHaveLength(6);
    expect(v.beats[0]).toMatchObject({ time: "0:00-0:05", name: "Hook", source: "Owner interview 0:00-0:04" });
    expect(v.versions).toEqual(videoSpec.versions);
    expect([v.must.length, v.never.length, v.assets.length, v.copy.primary.length, v.copy.headlines.length]).toEqual([5, 5, 4, 2, 2]);
    expect(v.oneLine).toMatch(/^The owner's answer, Convenience/);
    expect(v.stage).toBe("Evergreen TOF");
    const c = plainStructure(carouselSource);
    expect(c.slides.map((s) => s.job)).toEqual(["Hook", "Payoff", "Proof", "Proof", "CTA"]);
    expect(needsStructure(c, carouselSource)).toBe(false);
    const i = plainStructure(imageSource);
    expect(i.frame).toMatchObject({ headline: "Fridays on the patio", cta: "Book a table" });
    expect(needsStructure(i, imageSource)).toBe(false);
  });

  it("reads an older brief plainly: hooks as versions, its don't lines as Never", () => {
    const s = plainStructure(oldSource);
    expect(s.versions).toHaveLength(5);
    expect(s.versions[0]).toBe("Your Friday, sorted.");
    expect(s.versions[1]).toBe("The best seat in town is outside.");
    expect(s.never).toContain("Don't show empty tables.");
    expect(s.ai).toBe(false);
    expect(needsStructure(s, oldSource)).toBe(true);
  });

  it("lets the AI fill only what the brief leaves empty, never more rows than asked", () => {
    const s = fitStructure(
      { why: "AI insight", versions: Array.from({ length: 9 }, () => "H \u2014 x"), frame: { headline: "AI headline", subline: "", shows: "", readsFirst: "", cta: "" }, must: Array.from({ length: 9 }, () => "m"), never: [], beats: [{ time: "0-3s", name: "Hook", onScreen: "x", text: "", says: "", source: "" }] },
      oldSource,
      true,
    );
    expect(s.versions).toHaveLength(5);
    expect(s.versions[0]).toBe("Your Friday, sorted."); // the brief's own line wins
    expect(s.why).toBe("AI insight");
    expect(s.frame?.headline).toBe("Your Friday, sorted.");
    expect(s.never.length).toBeGreaterThan(0); // the plain read is kept
    expect(s.beats).toEqual([]); // not a video
    const fromAi = fitStructure({ versions: ["H \u2014 x"], frame: null, must: Array.from({ length: 9 }, () => "m") }, { ...oldSource, brief: "Free text only." }, true);
    expect(fromAi.versions[0]).not.toMatch(/\u2014/);
    expect(fromAi.must).toHaveLength(5);
    const carousel = fitStructure({ slides: Array.from({ length: 9 }, (_, i) => ({ job: "", headline: `S${i}`, shows: "" })) }, { ...oldSource, brief: "Free text.", formats: { carousel: { new: 1, variations: 0, cards: 6 } } }, true);
    expect(carousel.slides).toHaveLength(6);
  });

  it("falls back to the plain read when the AI isn't connected", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const s = await structureBrief({ ...oldSource, clientId: "00000000-0000-0000-0000-000000000000", client: "Casa Verde" });
      expect(s.ai).toBe(false);
      expect(s.versions[0]).toBe("Your Friday, sorted.");
      const v = await structureBrief({ ...videoSource, clientId: "00000000-0000-0000-0000-000000000000", client: "Best Tickets" });
      expect(v.beats).toHaveLength(6);
      expect(v.assets[0]).toContain("https://drive.google.com/file/d/owner1/view");
    } finally {
      if (key) process.env.ANTHROPIC_API_KEY = key;
    }
  });

  it("keys the structure on the brief", () => {
    expect(structureKey(oldSource)).toBe(structureKey({ ...oldSource }));
    expect(structureKey(oldSource)).not.toBe(structureKey({ ...oldSource, brief: `${oldBrief}\nOne more line.` }));
  });

  it("says what it asks for and what it takes", () => {
    expect(formatChips(oldSource.formats, ["4x5", "9x16"])).toEqual(["1 concept", "5 versions", "Single image", "4:5, 9:16"]);
    expect(allotmentDraw(oldSource.formats, { images: 20, videos: 4, imagesUsed: 8, videosUsed: 0, until: null })).toBe("Takes 5 of 20 images, 7 left after");
    expect(versionsStrip(videoSource.formats, { images: 20, videos: 5, imagesUsed: 0, videosUsed: 2, until: null })).toBe("3 · 3 of 5 videos this month");
    expect(headerLine(videoSource.formats, ["9:16"], "Evergreen TOF")).toEqual(["Evergreen TOF", "Video", "9:16"]);
    const checklist = specsChecklist(oldSource.formats, ["4x5", "9x16"], "Casa Verde", "Patio Fridays").join("\n");
    expect(checklist).toMatch(/Casa_Verde_Patio_Fridays_V1_4x5/);
    expect(checklist).not.toMatch(/Deliver on the ticket/);
  });
});

async function picture(w: number, h: number, color: string, text: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" font-size="${Math.round(w / 9)}" font-family="Helvetica" fill="#fff" text-anchor="middle">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

const pagesOf = (pdf: Uint8Array) => (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;

async function render(name: string, src: StructureSource, sizes: string[], client: string, extra: Partial<BriefPdfInput> = {}) {
  const structure = fitStructure(null, src, false);
  const fs = picked(src.formats);
  const cards = slidesFor(src.formats);
  const b: BriefPdfInput = {
    client,
    title: src.title,
    number: null,
    header: headerLine(src.formats, sizes, structure.stage),
    due: "Mon, Nov 16",
    makers: [fs.includes("video") ? "The video editor (unassigned)" : "The designer (unassigned)"],
    priority: "normal",
    versions: versionsStrip(src.formats, { images: 20, videos: 5, imagesUsed: 4, videosUsed: 2, until: null }),
    measure: src.formats.video && structure.length ? { label: "Length", value: structure.length } : cards ? { label: "Slides", value: String(cards) } : null,
    references: [],
    structure: { ...structure },
    exportLine: exportLineFor(fs, sizes, client, src.title),
    links: [],
    formats: fs,
    by: "A strategist",
    date: "November 11, 2026",
    confirm: [],
    ...extra,
  };
  const pdf = await briefPdf(b);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `kaizen-brief-${name}.pdf`);
  writeFileSync(file, pdf);
  console.log(`[brief-pdf] ${name}: ${file} (${pagesOf(pdf)} pages)`);
  return { pdf, text: Buffer.from(pdf).toString("latin1") };
}

describe("brief pdf render", () => {
  it("renders each format to two pages, the guardrails on the second", { timeout: 90_000 }, async () => {
    const ref = { kicker: "Built on a live ad in the market", title: "Sunset patio, flight of four", brand: "Cantina Norte", days: 47, video: true, note: null, links: [{ label: "Meta Ad Library", url: "https://www.facebook.com/ads/library/?id=123" }], image: await picture(800, 1000, "#7a4b2a", "REFERENCE") };
    const v = await render("video", videoSource, ["9x16"], "Best Tickets", { confirm: ["Does checkout on the site work again after the Nov 6 error?"], references: [ref], priority: "high" });
    expect(pagesOf(v.pdf)).toBe(2);
    expect(v.text).toMatch(/\/URI\s*\(https:\/\/drive\.google\.com\/file\/d\/owner1\/view\)/); // "Open in Drive" is a real link
    const c = await render("carousel", carouselSource, ["4x5"], "Best Tickets");
    expect(pagesOf(c.pdf)).toBe(2);
    const i = await render("image", imageSource, ["4x5", "9x16"], "Casa Verde", { references: [ref, { ...ref, brand: "Taqueria Sol", image: null }] });
    expect(pagesOf(i.pdf)).toBe(2);
    // At the caps (6 beats with both lines, 6 versions, 5 Must, 5 Never, 5 assets, 2 primary texts, 2 headlines),
    // every line one short sentence as the writers are told, with two facts to confirm and a reference: two pages
    const long = (n: number) => "Real seat views from the upper deck, logo in the corner. ".repeat(n).trim();
    const dense = fixture(
      "video",
      {
        ...videoSpec,
        insight: long(2),
        who: long(2),
        beats: videoSpec.beats.map((x, i) => `0:0${i}-0:0${i + 1} | Beat name ${i} | On screen: ${long(1)} | Text: "${long(1)}" | Says: "${long(1)}" (Source: Owner interview 0:0${i})`),
        versions: Array.from({ length: 6 }, () => long(1)),
        dos: Array.from({ length: 5 }, () => long(1)),
        donts: Array.from({ length: 5 }, () => long(1)),
        assets: Array.from({ length: 5 }, (_, i) => ({ item: `${long(2)} https://drive.google.com/file/d/x${i}/view`, status: "have" as const })),
        copy: ["Primary: " + long(2), "Primary: " + long(2), "Headline: " + long(1), "Headline: " + long(1), "CTA: Shop Now"],
      },
      { new: 1, variations: 5 },
      long(2),
    );
    const d = await render("dense", dense, ["4x5", "9x16"], "Best Tickets", { confirm: Array.from({ length: 2 }, () => long(1)), references: [ref] });
    expect(pagesOf(d.pdf)).toBe(2);
    // Past that (5 to confirm, 3 references) it never leaves a page for a few lines: the guardrails follow the idea
    const over = await render("overfull", dense, ["4x5", "9x16"], "Best Tickets", { confirm: Array.from({ length: 5 }, () => long(1)), references: [ref, ref, ref] });
    expect(pagesOf(over.pdf)).toBeLessThanOrEqual(3);
    // An older brief still renders, read plainly
    const old = await render("older", oldSource, ["4x5", "9x16"], "Casa Verde");
    expect(pagesOf(old.pdf)).toBeLessThanOrEqual(2);
  });
});
