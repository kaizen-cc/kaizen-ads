import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { briefPdf, type BriefPdfInput } from "@/lib/brief-pdf";
import { allotmentDraw, fitStructure, formatChips, plainStructure, specsChecklist, structureKey, type StructureSource } from "@/lib/brief-pdf-model";

// The branded brief PDF: the brief read plainly when the AI can't run, the AI's answer fitted to the rows asked for,
// the cache key, and a full render from a fixture (no network) that stays at one to two pages.

const brief = `Show the Friday night crowd what they're missing: the patio at golden hour, the fire pits, the margarita flight.

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

const source: StructureSource = { title: "Patio Fridays", angle: "Weekend plans, sorted", audience: "Locals 25 to 45 who go out on Fridays", brief, formats: { image: { new: 1, variations: 4 } }, landing: "https://example.com/patio" };

describe("brief pdf model", () => {
  it("reads a brief plainly: one row per version, the concept on V1, hooks on the rest, don'ts", () => {
    const s = plainStructure(source);
    expect(s.versions).toHaveLength(5);
    expect(s.versions[0].hook).toBe("Your Friday, sorted.");
    expect(s.versions[0].visual).toMatch(/Wide shot/);
    expect(s.versions[1].hook).toBe("The best seat in town is outside.");
    expect(s.donts).toContain("Don't show empty tables.");
    expect(s.summary.length).toBeGreaterThanOrEqual(2);
    expect(s.ai).toBe(false);
  });

  it("fits the AI's answer to the rows asked for, never more", () => {
    const s = fitStructure({ summary: ["a", "b", "c"], versions: Array.from({ length: 9 }, () => ({ headline: "H \u2014 x", subline: "", visual: "v", hook: "" })), slides: [], dos: [], donts: [], copy: { primary: [], headlines: [], cta: "" }, assets: [] }, source, true);
    expect(s.versions).toHaveLength(5);
    expect(s.versions[0].headline).not.toMatch(/\u2014/);
    expect(s.donts.length).toBeGreaterThan(0); // the plain read fills what the AI left empty
    const carousel = fitStructure(null, { ...source, formats: { carousel: { new: 1, variations: 0, cards: 6 } } }, false);
    expect(carousel.slides).toHaveLength(6);
  });

  it("keys the structure on the brief", () => {
    expect(structureKey(source)).toBe(structureKey({ ...source }));
    expect(structureKey(source)).not.toBe(structureKey({ ...source, brief: `${brief}\nOne more line.` }));
  });

  it("says what it asks for and what it takes", () => {
    expect(formatChips(source.formats, ["4x5", "9x16"])).toEqual(["1 concept", "5 versions", "Single image", "4:5, 9:16"]);
    expect(allotmentDraw(source.formats, { images: 20, videos: 4, imagesUsed: 8, videosUsed: 0, until: null })).toBe("Takes 5 of 20 images, 7 left after");
    expect(specsChecklist(source.formats, ["4x5", "9x16"], "Casa Verde", "Patio Fridays").join("\n")).toMatch(/Casa_Verde_Patio_Fridays_V1_4x5/);
  });
});

async function picture(w: number, h: number, color: string, text: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" font-size="${Math.round(w / 9)}" font-family="Helvetica" fill="#fff" text-anchor="middle">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

describe("brief pdf render", () => {
  it("renders a typical brief to one or two pages", { timeout: 60_000 }, async () => {
    const structure = fitStructure(
      {
        oneLine: "Golden-hour patio shots that make Friday plans feel already made.",
        summary: [
          "One concept, five versions: the patio at golden hour with the margarita flight up front.",
          "For locals 25 to 45 deciding where to go on Friday night.",
          "It should work because their patio ads beat food-only ads on cost per reservation.",
          "Avoid empty tables and stock food photos: the client rejected both.",
        ],
        versions: [
          { headline: "Fridays on the patio", subline: "Fire pits lit from 5pm", visual: "Wide shot of the full patio at sunset, string lights on, a flight in the foreground", hook: "Your Friday, sorted." },
          { headline: "The best seat in town is outside", subline: "", visual: "Close on the fire pit, friends' hands toasting", hook: "The best seat in town is outside." },
          { headline: "Fire pits are lit", subline: "", visual: "Flames and the flight, shallow depth", hook: "Fire pits are lit." },
          { headline: "", subline: "", visual: "", hook: "" },
          { headline: "", subline: "", visual: "", hook: "" },
        ],
        slides: [],
        dos: ["Show a full patio", "Use the Drive photos from the October shoot"],
        donts: ["Show empty tables", "Use stock photos of food"],
        copy: { primary: ["Fridays hit different on the patio. Fire pits lit, flights poured, your table waiting."], headlines: ["Fridays on the patio", "Your Friday, sorted"], cta: "Book now" },
        assets: ["October patio shoot on Drive", "Logo (white) from the brand folder"],
      },
      source,
      true,
    );
    const b: BriefPdfInput = {
      client: "Casa Verde",
      title: "Patio Fridays",
      number: null,
      chips: formatChips(source.formats, ["4x5", "9x16"]),
      due: "Mon, Nov 9",
      makers: ["The designer (unassigned)"],
      priority: "high",
      allotment: allotmentDraw(source.formats, { images: 20, videos: 4, imagesUsed: 8, videosUsed: 0, until: null }),
      angle: source.angle,
      audience: source.audience,
      references: [
        {
          kicker: "Built on a live ad in the market",
          title: "Sunset patio, flight of four",
          brand: "Cantina Norte",
          days: 47,
          video: true,
          note: "Still running after 47 days: the golden-hour patio carries it.",
          links: [
            { label: "Meta Ad Library", url: "https://www.facebook.com/ads/library/?id=123" },
            { label: "Motion", url: "https://app.motionapp.com/x" },
            { label: "Their landing page", url: "https://example.com/" },
          ],
          image: await picture(800, 1000, "#7a4b2a", "REFERENCE"),
        },
      ],
      structure,
      specs: specsChecklist(source.formats, ["4x5", "9x16"], "Casa Verde", "Patio Fridays"),
      next: ["The designer makes 5 versions in 4:5 and 9:16 by Mon, Nov 9, delivered on the ticket.", "Then the AI review and internal review, the copy, and the client's approval."],
      landing: source.landing ?? null,
      links: [{ label: "Google Drive", url: "https://drive.google.com/drive/folders/abc" }],
      by: "A strategist",
      date: "November 5, 2026",
    };
    const pdf = await briefPdf(b);
    const text = Buffer.from(pdf).toString("latin1");
    const pages = (text.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
    const out = process.env.BRIEF_PDF_OUT ?? join(tmpdir(), "kaizen-brief-sample.pdf");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pdf);
    console.log(`[brief-pdf] sample: ${out} (${pages} page${pages === 1 ? "" : "s"})`);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(2);
    expect(text).toMatch(/\/URI\s*\(https:\/\/www\.facebook\.com\/ads\/library/); // links are real links

    // Several references draw as a grid, and a carousel as slides
    const many = await briefPdf({ ...b, references: [b.references[0], { ...b.references[0], video: false, brand: "Taqueria Sol", image: null }, { ...b.references[0], brand: "El Patio", image: await picture(600, 600, "#234", "SQUARE") }], structure: fitStructure({ ...structure, slides: ["Fridays on the patio", "Fire pits lit from 5pm", "Flights of four", "The best seat in town", "Book your table"].map((headline, i) => ({ headline, subline: i === 4 ? "Link in the ad" : "", visual: `Slide ${i + 1}: the patio, closer each time` })) }, { ...source, formats: { carousel: { new: 1, variations: 0, cards: 5 } } }, true) });
    const manyPages = (Buffer.from(many).toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
    if (process.env.BRIEF_PDF_OUT) writeFileSync(process.env.BRIEF_PDF_OUT.replace(/\.pdf$/, "-grid.pdf"), many);
    expect(manyPages).toBeLessThanOrEqual(2);
  });
});
