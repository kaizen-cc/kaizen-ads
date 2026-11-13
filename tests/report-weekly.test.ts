import path from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportDocument, type ReportPart, type ReportPdfInput } from "@/lib/reports/report-doc";
import { autoTakeaways, barsRead, cleanAdName, costLabel, kpiType, move, niceMax, scoreColumns, scorecardRows, shortName, supportKeys, takeawaysFor, weeklyTile, weeklyTileKeys } from "@/lib/reports/weekly-core";
import { colorFromPixels, colorsFromBible, contrast, isLightLogo, paletteFor, pickBrandColor } from "@/lib/reports/brand";
import { cadenceOf, eyebrowOf, KAIZEN_RED, lookFor } from "@/lib/reports/weekly-doc";
import { logoCandidates } from "@/lib/reports/brand-server";
import { narrativeLines } from "@/lib/reports/delivery-core";
import { scrubName, scrubSections } from "@/lib/reports/white-label";
import { emptySections, googleWithUnits, harborMeta, harborTiktok, northsideMeta, oceanboxGoogle, oceanboxMeta } from "./fixtures/report-weekly";

const part = (platform: ReportPart["platform"], metrics: ReportPart["metrics"], extra: Partial<ReportPart> = {}): ReportPart => ({ platform, buyer: "Media buyer", metrics, sections: emptySections, extras: null, ...extra });

/** The text of a rendered report, page by page */
async function textOf(input: ReportPdfInput) {
  const pdf = new Uint8Array(await renderToBuffer(createElement(ReportDocument, { input, images: input.parts.map(() => []) }) as Parameters<typeof renderToBuffer>[0]));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fonts = `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").replace(/\\/g, "/")}/`;
  const doc = await pdfjs.getDocument({ data: pdf, standardFontDataUrl: fonts }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((x) => ("str" in x ? x.str : "")).join(" "));
  }
  return { pages, all: pages.join("\n"), meta: (await doc.getMetadata()).info as Record<string, string> };
}

/** Whether the text holds a phrase, spacing aside (letter-spaced kickers come out "O C E A N B O X") */
const has = (text: string, phrase: string) => text.replace(/\s+/g, "").toLowerCase().includes(phrase.replace(/\s+/g, "").toLowerCase());

describe("favorable or unfavorable, by metric", () => {
  it("is green when results, ROAS, CTR or the view rate go up, and when any cost goes down", () => {
    expect(move("results", 12, 7)).toEqual({ pct: "71.4%", up: true, tone: "good" });
    expect(move("cost_per_result", 140.35, 245.78)).toEqual({ pct: "42.9%", up: false, tone: "good" });
    expect(move("cpc", 2.05, 2.84)?.tone).toBe("good");
    expect(move("ctr", 1.73, 1.76)).toEqual({ pct: "1.7%", up: false, tone: "bad" });
    expect(move("roas", 3.3, 2.88)?.tone).toBe("good");
    expect(move("hook_rate", 22.6, 19.8)?.tone).toBe("good");
    expect(move("cpm", 40, 35)?.tone).toBe("bad");
    expect(move("cost_per_result", 41.31, 36.26)?.tone).toBe("bad");
  });
  it("leaves spend neutral, and has no move without a comparison", () => {
    expect(move("spend", 1684.2, 1720.49)?.tone).toBe("flat");
    expect(move("results", 5, 0)).toBeNull();
    expect(move("results", 5, null)).toBeNull();
  });
  it("labels a tile with its value and the prior week's", () => {
    const t = weeklyTile(oceanboxMeta, "cost_per_result", oceanboxMeta.main, oceanboxMeta.compare);
    expect(t).toMatchObject({ label: "CPA", value: "$140.28", before: "$245.78" });
    expect(t.move?.tone).toBe("good");
  });
});

describe("what leads, by the client's KPI", () => {
  it("leads a purchase client with purchases, CPA, CPC and CTR (the reference report's four)", () => {
    expect(kpiType(oceanboxMeta)).toBe("purchases");
    expect(weeklyTileKeys(oceanboxMeta)).toEqual(["results", "cost_per_result", "cpc", "ctr"]);
    expect(supportKeys(oceanboxMeta, weeklyTileKeys(oceanboxMeta))).toEqual(["spend", "clicks", "impressions"]);
  });
  it("leads a ROAS client with ROAS, revenue, purchases and their cost", () => {
    expect(kpiType(harborMeta)).toBe("roas");
    expect(weeklyTileKeys(harborMeta)).toEqual(["roas", "revenue", "results", "cost_per_result"]);
  });
  it("leads a lead-gen client with leads and CPL", () => {
    expect(kpiType(northsideMeta)).toBe("leads");
    expect(weeklyTileKeys(northsideMeta).slice(0, 2)).toEqual(["results", "cost_per_result"]);
    expect(costLabel(northsideMeta)).toBe("CPL");
  });
  it("gives TikTok its 6-second view rate and views, and Google its conversions at CPA", () => {
    expect(weeklyTileKeys(harborTiktok)).toContain("hook_rate");
    expect(supportKeys(harborTiktok, weeklyTileKeys(harborTiktok))).toContain("views_6s");
    expect(costLabel(oceanboxGoogle)).toBe("CPA");
  });
  it("keeps the buyer's own tiles", () => {
    expect(weeklyTileKeys(oceanboxMeta, { tiles: ["spend", "roas"] })).toEqual(["spend", "roas"]);
  });
});

describe("brand colour and contrast", () => {
  it("takes the Brand Bible's colours from the line about colour, primary first", () => {
    const md = "# Look\nLogo on white. Photo style: bright.\nColors: deep navy #102D45, sand #e8dcc4, accent #2785BB\nOther: #ffffff background";
    expect(colorsFromBible(md)).toEqual(["#102d45", "#e8dcc4", "#2785bb"]);
    expect(pickBrandColor(colorsFromBible(md))).toBe("#102d45");
    expect(pickBrandColor(["#ffffff", "#777777", "#000000"])).toBeNull();
  });
  it("picks the colour from a logo's pixels, and none from a black wordmark", () => {
    const px = (rgb: number[], n: number) => Array.from({ length: n }, () => [...rgb, 255]).flat();
    expect(colorFromPixels([...px([200, 40, 40], 300), ...px([255, 255, 255], 100)])).toMatch(/^#c[0-9a-f]2[0-9a-f]2[0-9a-f]$/);
    expect(colorFromPixels(px([10, 10, 10], 400))).toBeNull();
    expect(isLightLogo(px([250, 250, 250], 100))).toBe(true);
    expect(isLightLogo(px([16, 21, 58], 100))).toBe(false);
  });
  it("always reads: bars on white, white text on the band, the eyebrow on the band", () => {
    for (const c of ["#0f1433", "#2785bb", "#ffe45e", "#b4532a", "#0f766e", "#e11d48", "#7cfc00", null]) {
      const p = paletteFor(c);
      expect(contrast(p.accent, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(p.accentText, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.hero, "#ffffff")).toBeGreaterThanOrEqual(10);
      expect(contrast(p.heroSoft, p.hero)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps a navy brand's colour in its bars (not a grey)", () => {
    const p = paletteFor("#0f1433");
    expect(p.hero).toBe("#0f1433");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.accent.slice(i, i + 2), 16));
    expect(b - Math.max(r, g)).toBeGreaterThan(60);
  });
  it("finds the header's logo on a website before the icons and the share image", () => {
    const html = `<head><link rel="icon" href="/fav-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="https://x.com/share.jpg"></head><body><img class="site-logo" src="//cdn.x.com/logo.svg?v=2"></body>`;
    expect(logoCandidates(html, "https://x.com/")).toEqual(["https://cdn.x.com/logo.svg?v=2", "https://x.com/touch.png", "https://x.com/fav-32.png", "og:https://x.com/share.jpg"]);
  });
});

describe("the scorecard", () => {
  it("shows every ad with its picture beside its numbers, best first by purchases", () => {
    const rows = scorecardRows(oceanboxMeta);
    expect(rows.map((r) => r.name)).toEqual(["Lobster | Dec 10", "Instagram Flexible Seafood plan | Oct 7", "Instagram Flexible Seafood plan | Oct 7 (copy)", "VID | Salmon Lover Box | Jan 9"]);
    // Each row points at its ad's picture in the part's images (topAds order)
    expect(rows.map((r) => oceanboxMeta.topAds[r.img!].id)).toEqual(rows.map((r) => r.id));
    expect(rows[0].detail).toBe("Video · Active");
    expect(rows[1].detail).toBe("Flexible · Inactive");
  });
  it("sorts a ROAS client by ROAS", () => {
    const rows = scorecardRows(harborMeta);
    expect(rows.map((r) => r.roas)).toEqual([...rows.map((r) => r.roas)].sort((a, b) => (b ?? 0) - (a ?? 0)));
  });
  it("on Google shows ad groups with their RSA headline and asset groups with their picture, else campaigns", () => {
    const units = scorecardRows(googleWithUnits);
    expect(units[0]).toMatchObject({ kind: "ad_group", name: "Brand | Exact", detail: "“OceanBox Seafood Delivery”", img: null });
    expect(units.find((r) => r.kind === "asset_group")?.img).not.toBeNull();
    const camps = scorecardRows(oceanboxGoogle);
    expect(camps.every((r) => r.kind === "campaign")).toBe(true);
    expect(camps[0].name).toBe("CORE | Search | Brand | Kaizen");
  });
  it("reads ad names the way a client would", () => {
    expect(cleanAdName("ID: 17849814834607249  | Lobster | Dec 10")).toBe("Lobster | Dec 10");
    expect(shortName("VID | Salmon Lover Box | Jan 9")).toBe("Salmon Lover Box");
    expect(barsRead(oceanboxMeta, scorecardRows(oceanboxMeta))).toMatch(/^Lobster brought the most purchases of any ad \(5\)/);
  });
  it("draws a whole-number axis for counts", () => {
    expect(niceMax(12, true)).toBe(16);
    expect(niceMax(848.29)).toBe(1000);
  });
});

describe("key takeaways", () => {
  it("works three out from the numbers: the KPI, the traffic, the creative leader", () => {
    const t = autoTakeaways(oceanboxMeta);
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ title: "More purchases, lower CPA", text: "Purchases increased from 7 to 12 (+71.4%), while CPA fell from $245.78 to $140.28 (-42.9%)." });
    expect(t[1].title).toBe("Cheaper traffic, lower CTR");
    expect(t[2].title).toBe("Creative efficiency leader");
    expect(t[2].text).toContain("$58.44");
    for (const x of [...t, ...autoTakeaways(harborMeta), ...autoTakeaways(harborTiktok), ...autoTakeaways(northsideMeta), ...autoTakeaways(oceanboxGoogle)]) expect(`${x.title} ${x.text}`).not.toMatch(/—|!/);
  });
  it("uses the writer's when there are any", () => {
    expect(takeawaysFor(oceanboxMeta, [{ title: "Own", text: "Words" }])).toEqual([{ title: "Own", text: "Words" }]);
  });
  it("cleans the agency out of a white label client's takeaways", () => {
    const out = scrubSections({ ...emptySections, takeaways: [{ title: "Kaizen's best week", text: "The Kaizen team cut CPA." }] }).takeaways!;
    expect(out).toEqual([{ title: "our best week", text: "our team cut CPA." }]);
  });
  it("puts the narrative in the email that carries the weekly", () => {
    expect(narrativeLines({ did: ["Moved budget to the CBO.", "Paused two ads"], next: ["Launch the box statics"] })).toEqual(["What we did: Moved budget to the CBO; Paused two ads.", "What's next: Launch the box statics."]);
  });
});

describe("the report document", () => {
  const kaizen = { logo: null, color: "#0f1433", agencyLogo: null };
  const narrative = { ...emptySections, headline: "A strong week", summary: "We spent well.", did: ["Moved budget to the CBO"], doing: ["Testing the box statics"], next: ["Launch the recipe ads"], stories: [{ title: "CPA by week", metric: "cost_per_result", grain: "week", periods: 2, see: "Down every week", why: "Better creative", next: "Keep going", points: [{ label: "Oct 26", value: 245 }, { label: "Nov 2", value: 140 }] }] } as typeof emptySections;
  const NARRATIVE = ["What we did", "What we're doing", "What's next", "What we see", "Our notes", "Moved budget to the CBO", "Testing the box statics", "Launch the recipe ads", "A strong week", "Down every week", "Better creative"];

  it("co-brands the client and Kaizen, with the reference's sections", async () => {
    const { all } = await textOf({ client: "OceanBox", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: [part("meta", oceanboxMeta)], brand: kaizen });
    for (const s of ["Performance Intelligence / Meta Ads", "Weekly Paid Social Report", "OceanBox Performance", "Reporting period", "Nov 2 – Nov 8, 2026", "Compared with Oct 26 – Nov 1, 2026", "Performance at a glance", "Week-over-week movement", "vs 7 prior week", "Ad spend", "Purchases & acquisition cost", "5-week historical view", "Creative performance", "Creative scorecard", "Purchases by creative", "Key takeaways", "Prepared for OceanBox · Kaizen", "Currency USD · CTR uses link clicks"]) expect(has(all, s), s).toBe(true);
  });
  it("never prints the narrative (it goes in the message), even with the old notes switch on", async () => {
    for (const kind of ["weekly", "monthly", "built"] as const) {
      const { all } = await textOf({ client: "OceanBox", kind, periodLabel: "Nov 2 – Nov 8", parts: [part("meta", oceanboxMeta, { sections: narrative, extras: "Also sold three boxes by phone", layout: { notes: true } })], brand: kaizen });
      for (const s of [...NARRATIVE, "Also sold three boxes"]) expect(has(all, s), `${kind}: ${s}`).toBe(false);
      // The buyer's trend chart itself stays
      expect(has(all, "CPA by week"), kind).toBe(true);
    }
  });
  it("draws a built report of one 7-day period in the weekly design, with no cover", async () => {
    const { pages, all } = await textOf({ client: "OceanBox", kind: "built", periodLabel: "Last 7 days", parts: [part("meta", oceanboxMeta)], brand: kaizen });
    for (const s of ["Weekly Paid Social Report", "Performance at a glance", "vs 7 prior week", "Purchases & acquisition cost", "Creative scorecard", "Key takeaways"]) expect(has(all, s), s).toBe(true);
    expect(has(pages[0], "Performance at a glance")).toBe(true);
    expect(has(all, "Kaizen Marketing")).toBe(false);
    expect(all).not.toContain("Key metrics");
  });
  it("names the period by its length: a week, a month, or a period", () => {
    const span = (start: string, end: string) => ({ main: { ...oceanboxMeta.main, start, end } });
    expect(cadenceOf("built", span("2026-11-06", "2026-11-12"))).toMatchObject({ word: "Weekly", prior: "week", abbr: "WoW" });
    expect(cadenceOf("built", span("2026-10-01", "2026-10-31"))).toMatchObject({ word: "Monthly", prior: "month" });
    expect(cadenceOf("monthly", span("2026-10-01", "2026-10-31"))).toMatchObject({ word: "Monthly", prior: "month", abbr: "MoM" });
    expect(cadenceOf("built", span("2026-10-14", "2026-11-12"))).toMatchObject({ word: null, prior: "period" });
    expect(eyebrowOf(cadenceOf("built", span("2026-10-14", "2026-11-12")), "meta")).toBe("Paid Social Report");
    expect(eyebrowOf(cadenceOf("weekly", span("2026-11-02", "2026-11-08")), "google")).toBe("Weekly Paid Search Report");
  });
  it("gives a built report on several services a section each, in the same design", async () => {
    const { pages, all } = await textOf({ client: "OceanBox", kind: "built", periodLabel: "Last 7 days", parts: [part("meta", oceanboxMeta), part("google", oceanboxGoogle)], brand: kaizen });
    expect(has(all, "Across the account")).toBe(true);
    const meta = pages.findIndex((p) => has(p, "Performance Intelligence / Meta Ads") && has(p, "Weekly Paid Social Report"));
    const google = pages.findIndex((p) => has(p, "Performance Intelligence / Google Ads") && has(p, "Weekly Paid Search Report"));
    expect(meta).toBe(0);
    expect(google).toBeGreaterThan(meta);
    // Google lists every campaign in the campaign table (its ad groups are the creative section), never twice
    expect(has(all, "Campaign performance")).toBe(true);
    expect(has(all, "Campaign scorecard")).toBe(false);
  });
  it("draws the monthly recap in the same design, in monthly words", async () => {
    const { all } = await textOf({ client: "OceanBox", kind: "monthly", periodLabel: "October 2026", parts: [part("meta", oceanboxMeta)], brand: kaizen, shots: { month: "December", items: ["A team photo"], url: null } });
    for (const s of ["Monthly Paid Social Report", "Month-over-month movement", "prior month", "What we need from you for December", "A team photo"]) expect(has(all, s), s).toBe(true);
  });
  it("leads with Kaizen's red and gives the client's colour to the results bars", () => {
    const look = lookFor({ brand: kaizen });
    expect(look.primary).toBe(KAIZEN_RED);
    expect(look.bars).toBe(paletteFor("#0f1433").accent);
    // A red client's cost line isn't Kaizen's red beside their red bars
    expect(lookFor({ brand: { logo: null, color: "#d62828" } }).line).not.toBe(KAIZEN_RED);
    // White label: the client's colours alone
    const wl = lookFor({ brand: { logo: null, color: "#0f766e" }, whiteLabel: true });
    expect(Object.values(wl)).not.toContain(KAIZEN_RED);
    expect(wl.primary).toBe(paletteFor("#0f766e", { whiteLabel: true }).accent);
  });
  it("names no agency anywhere for a white label client", async () => {
    for (const kind of ["weekly", "monthly", "built"] as const) {
      const { all, meta } = await textOf({ client: "Northside Dental", kind, periodLabel: "Nov 2 – Nov 8", parts: [part("meta", northsideMeta, { sections: { ...emptySections, takeaways: [{ title: "Kaizen moved fast", text: "Kaizen Marketing cut CPL." }] } })], whiteLabel: true, dashboard: "https://ads.kaizenmarketing.agency/c/x/dashboard", brand: { logo: null, color: "#0f766e", agencyLogo: "data:image/png;base64,AAAA" } });
      expect(all).toContain("Prepared for Northside Dental");
      expect(all.toLowerCase(), kind).not.toContain("kaizen");
      expect(JSON.stringify(meta).toLowerCase(), kind).not.toContain("kaizen");
    }
  });
  it("takes the agency out of a white label client's campaign, ad and ad group names", async () => {
    const { all, meta } = await textOf({ client: "OceanBox", kind: "built", periodLabel: "Last 7 days", whiteLabel: true, parts: [part("meta", oceanboxMeta), part("google", googleWithUnits), part("google", oceanboxGoogle)], brand: { logo: null, color: "#0f766e", agencyLogo: null } });
    expect(all.toLowerCase()).not.toContain("kaizen");
    expect(all).not.toMatch(/\bKZN\b/);
    expect(has(all, "Colossal Shrimp Offer")).toBe(true);
    expect(JSON.stringify(meta).toLowerCase()).not.toContain("kaizen");
    expect(scrubName("PMax | Colossal Shrimp Offer | Kaizen")).toBe("PMax | Colossal Shrimp Offer");
    expect(scrubName("Kaizen  | CBO | Sales Campaign")).toBe("CBO | Sales Campaign");
    expect(scrubName("Shopping | Sea Bass | KZN")).toBe("Shopping | Sea Bass");
    expect(scrubName("Lobster | Dec 10")).toBe("Lobster | Dec 10");
  });
  it("draws a joint Meta + TikTok week as one document, a section per platform", async () => {
    const { pages, all } = await textOf({ client: "Harbor & Pine", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: [part("meta", harborMeta), part("tiktok", harborTiktok)], brand: kaizen });
    // Each platform's own header and band, then its numbers
    const meta = pages.findIndex((p) => has(p, "Performance Intelligence / Meta Ads") && p.includes("Performance at a glance"));
    const tiktok = pages.findIndex((p) => has(p, "Performance Intelligence / TikTok Ads") && p.includes("Performance at a glance"));
    expect(meta).toBeGreaterThanOrEqual(0);
    expect(tiktok).toBeGreaterThan(meta);
    expect(all.match(/Creative scorecard/g)).toHaveLength(2);
    expect(all.match(/Key takeaways/g)).toHaveLength(2);
    expect(has(all, "6s rate")).toBe(true);
    expect(all.match(/Performance Overview/g)).toHaveLength(2);
    expect(all.match(/Across the account/g)).toHaveLength(1);
  });
});

describe("the studio's preview: what can be clicked and changed", () => {
  const brand = { logo: null, color: "#0f1433", agencyLogo: null };
  const sections = { ...emptySections, headline: "A strong month", summary: "Purchases up.", did: ["Refreshed ads", "", "Cut a weak ad set"], doing: [], next: ["Test a new offer"] };

  it("a buyer's metric choices win on the support line and the scorecard's columns", () => {
    expect(supportKeys(oceanboxMeta, weeklyTileKeys(oceanboxMeta), { table: ["spend", "ctr"] })).toEqual(["spend", "ctr"]);
    expect(scoreColumns(oceanboxMeta, { columns: ["results", "spend"] })).toEqual(["results", "spend"]);
    expect(scoreColumns(oceanboxMeta, {})).toEqual(scoreColumns(oceanboxMeta));
  });

  it("the preview carries a click target for a tile, a key metric, a scorecard column and each write-up line; the client's PDF carries none", async () => {
    const make = (edit: boolean) => createElement(ReportDocument, { input: { client: "OceanBox", kind: "monthly", periodLabel: "October 2026", parts: [part("meta", oceanboxMeta, { sections })], brand, withNotes: true, edit }, images: [[]] }) as Parameters<typeof renderToBuffer>[0];
    const links = async (edit: boolean) => {
      const pdf = new Uint8Array(await renderToBuffer(make(edit)));
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const fonts = `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").replace(/\\/g, "/")}/`;
      const doc = await pdfjs.getDocument({ data: pdf, standardFontDataUrl: fonts }).promise;
      const urls: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) for (const a of (await (await doc.getPage(i)).getAnnotations()) as { url?: string }[]) if (a.url) urls.push(a.url.replace("https://edit.kaizen.invalid/", ""));
      return urls;
    };
    const on = await links(true);
    for (const t of ["meta/tile/0", "meta/row/0", "meta/col/0", "meta/text/headline", "meta/text/summary", "meta/text/did/0", "meta/text/did/2", "meta/text/next/0"]) expect(on, t).toContain(t);
    expect(on).not.toContain("meta/text/did/1");
    expect((await links(false)).filter((u) => u.includes("meta/"))).toEqual([]);
  });
});
