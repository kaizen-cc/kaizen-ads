import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pdfLayout } from "@/lib/launch-sheet/pdf-layout";
import { pdfToGrid } from "@/lib/launch-sheet/grid";
import { colorName, gridToSheet, looksLikeLaunchSheet, parseDate, parseRange } from "@/lib/launch-sheet/sheet";
import { csvToGrid, xlsxToGrid } from "@/lib/launch-sheet/xlsx";
import { budgetSanity, budgetSpec, mapBudget, specSpend } from "@/lib/launch-sheet/budget";
import type { Grid, LaunchSheet } from "@/lib/launch-sheet/types";
import { deflateRawSync } from "node:zlib";

// The launch sheet reader on a real sheet (an event's weekly plan exported from Google Sheets to PDF): the header
// lines, the budget periods, every row with its Page, place, creative links and copy options, the row colors and the
// footnotes. Then the same reader on an Excel file and a CSV, and the budget math.

let grid: Grid;
let sheet: LaunchSheet;
beforeAll(async () => {
  grid = pdfToGrid(await pdfLayout(readFileSync("tests/fixtures/launch-sheet-bar-fest.pdf")));
  sheet = gridToSheet(grid, "2026-09-01");
}, 60_000);

describe("reading a launch sheet PDF", () => {
  it("knows it's a launch sheet", () => {
    expect(looksLikeLaunchSheet(grid)).toBe(true);
  });

  it("reads the event header", () => {
    expect(sheet.event.name).toBe("PACIFIC BEACH HALLOWEEN BAR FEST");
    expect(sheet.event.date).toBe("2026-10-31");
    expect(sheet.event.link).toBe("https://www.madcitybarfest.com/pacific-beach");
    expect(sheet.goal).toMatch(/volume of purchases, not ROAS/);
    expect(sheet.totalBudget).toBe(15000);
    expect(sheet.spentToDate).toBe(1464.53);
    expect(sheet.spentThrough).toBe("2026-09-20");
  });

  it("reads the budget periods as totals per period, by platform", () => {
    expect(sheet.budgets).toHaveLength(1);
    const meta = sheet.budgets[0];
    expect(meta.platform).toBe("Meta");
    expect(meta.periods.map((p) => p.amount)).toEqual([350, 750, 1500, 2500, 3500, 4935.47]);
    expect(meta.periods[0]).toMatchObject({ start: "2026-09-21", end: "2026-09-27" });
    expect(meta.periods[1]).toMatchObject({ start: "2026-09-28", end: "2026-10-04" });
    expect(meta.periods[5]).toMatchObject({ start: "2026-10-26", end: "2026-10-31" });
  });

  it("finds the columns by their headers", () => {
    const roles = sheet.columns.map((c) => `${c.role}${c.n ?? ""}`);
    expect(roles).toEqual(["date", "page", "access", "geo", "creative", "headline1", "primary1", "headline2", "primary2", "headline3", "primary3"]);
  });

  it("reads every row", () => {
    expect(sheet.rows).toHaveLength(25);
    expect(sheet.rows[0]).toMatchObject({ dateText: "8/10/26", date: "2026-08-10", page: "Mad City Bar Fest", access: "YES", geo: "San Diego", color: "red" });
    expect(sheet.rows[1].color).toBe("green");
  });

  it("splits a date that ran into the Page column", () => {
    // "9/22/26 Mad City Bar" + "Fest" in the next column
    const r = sheet.rows.find((x) => x.creative.name.startsWith("Collage Flyers"))!;
    expect(r.date).toBe("2026-09-22");
    expect(r.page).toBe("Mad City Bar Fest");
  });

  it("keeps the venue Pages apart from the brand's", () => {
    const pages = [...new Set(sheet.rows.map((r) => r.page))];
    expect(pages).toEqual(["Mad City Bar Fest", "Firehouse"]);
    expect(sheet.rows.filter((r) => r.page === "Firehouse")).toHaveLength(4);
  });

  it("keeps three copy options per row, wrapped lines joined", () => {
    const r = sheet.rows.find((x) => x.creative.name.startsWith("Collage Flyers"))!;
    expect(r.copy).toHaveLength(3);
    expect(r.copy[0].headline).toBe("Pacific Beach Halloween Bar Fest");
    expect(r.copy[0].primary).toBe("One wristband gets you into 7+ Pacific Beach bars this Halloween. Get tickets now before prices increase.");
    expect(r.copy[1].headline).toBe("7+ Bars. One Wristband.");
    const first = sheet.rows[0];
    // A cell with paragraphs keeps them
    expect(first.copy[2].primary.split("\n\n")).toHaveLength(3);
  });

  it("keeps the creative's Drive links (files and folders)", () => {
    const r = sheet.rows.find((x) => x.creative.name === "On Sale Ad Video 1")!;
    expect(r.creative.links).toEqual(["https://drive.google.com/file/d/1Yjha9x4l9un2_ynPfkiUiYRpgzGAofDW/view?usp=drivesdk"]);
    const folder = sheet.rows.find((x) => x.creative.name === "On Sale Flyer — All Sizes")!;
    expect(folder.creative.links[0]).toMatch(/drive\.google\.com\/drive\/folders\/1uMey0bqFh21NVyEXgirgYNeyPaL3sy9D/);
    expect(sheet.rows.filter((x) => x.creative.links.length).length).toBeGreaterThanOrEqual(21);
  });

  it("reads existing Instagram posts and their footnotes", () => {
    const posts = sheet.rows.filter((r) => r.existingPost);
    expect(posts.map((p) => p.existingPost)).toEqual(["https://www.instagram.com/madcitybarfest/p/DdUoEsTGIRy/", "https://www.instagram.com/madcitybarfest/reel/DdkE8LPs95X/"]);
    expect(posts[0].notes).toEqual([2]);
    expect(posts[0].geo).toBe("Pacific Beach");
    expect(sheet.footnotes.map((f) => f.n)).toEqual([1, 2, 3]);
    expect(sheet.footnotes[0].text).toMatch(/not daily spend/);
  });
});

describe("dates", () => {
  it("reads the shapes sheets use", () => {
    expect(parseDate("8/10/26", 2026)).toBe("2026-08-10");
    expect(parseDate("10/31", 2026)).toBe("2026-10-31");
    expect(parseDate("2026-10-31", 2000)).toBe("2026-10-31");
    expect(parseDate("Oct 5", 2026)).toBe("2026-10-05");
    expect(parseDate("September 20, 2026", 2000)).toBe("2026-09-20");
    expect(parseRange("Sep 28–Oct 4", 2026)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(parseRange("Dec 28 - Jan 3", 2026)).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(colorName("#ff0000")).toBe("red");
    expect(colorName("#00ff00")).toBe("green");
  });
});

/** A tiny XLSX built in the test: one sheet, shared strings, a red fill and a hyperlink */
function zip(files: Record<string, string>) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe("reading an Excel launch sheet and a CSV", () => {
  it("reads cells, links and fills", () => {
    const strings = ["Date", "Page", "Creative", "Headline 1", "Primary Text 1", "Brand Page", "Flyer", "Big night", "Come out"];
    const xlsx = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
      "xl/styles.xml": `<styleSheet><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></fills><cellXfs count="2"><xf fillId="0"/><xf fillId="2"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row><row r="2"><c r="A2" s="1"><v>46289</v></c><c r="B2" s="1" t="s"><v>5</v></c><c r="C2" s="1" t="s"><v>6</v></c><c r="D2" s="1" t="s"><v>7</v></c><c r="E2" s="1" t="s"><v>8</v></c></row></sheetData><hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks></worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships><Relationship Id="rId1" Target="https://drive.google.com/drive/folders/abc" TargetMode="External"/></Relationships>`,
    });
    const g = xlsxToGrid(xlsx)!;
    expect(g.rows).toHaveLength(2);
    expect(g.rows[1][2]).toEqual({ text: "Flyer", links: ["https://drive.google.com/drive/folders/abc"], color: "#ff0000" });
    const s = gridToSheet(g, "2026-09-01");
    expect(s.rows[0]).toMatchObject({ date: "2026-09-24", page: "Brand Page", color: "red", creative: { name: "Flyer", links: ["https://drive.google.com/drive/folders/abc"] } });
    expect(s.rows[0].copy[0]).toEqual({ headline: "Big night", primary: "Come out", description: "" });
  });

  it("reads a CSV with quoted fields", () => {
    const g = csvToGrid(`Date,Page,Creative,Headline 1,Primary Text 1\n10/02/26,Venue A,https://drive.google.com/file/d/x/view,"Hi, there","Line one\nline two"\n`);
    const s = gridToSheet(g, "2026-09-01");
    expect(s.rows[0]).toMatchObject({ date: "2026-10-02", page: "Venue A", creative: { links: ["https://drive.google.com/file/d/x/view"] } });
    expect(s.rows[0].copy[0]).toEqual({ headline: "Hi, there", primary: "Line one\nline two", description: "" });
  });
});

describe("budget periods to Meta budgets", () => {
  const periods = [
    { label: "Sep 21–27", start: "2026-09-21", end: "2026-09-27", amount: 350 },
    { label: "Sep 28–Oct 4", start: "2026-09-28", end: "2026-10-04", amount: 750 },
    { label: "Oct 26–31", start: "2026-10-26", end: "2026-10-31", amount: 4935.47 },
  ];

  it("turns period totals into daily budgets, never copying a total in as a daily", () => {
    const m = mapBudget(periods, "per_period_daily", "2026-09-01");
    expect(m.lines.map((l) => l.daily)).toEqual([50, 107.14, 822.57]);
    expect(m.lines.map((l) => l.days)).toEqual([7, 7, 6]);
    expect(m.total).toBe(6035.47);
    expect(m.notes.join(" ")).toMatch(/No budget between 2026-10-04 and 2026-10-26/);
  });

  it("drops periods that are over and prorates the one under way", () => {
    const m = mapBudget(periods, "per_period_daily", "2026-09-25");
    expect(m.skipped).toEqual([]);
    expect(m.lines[0]).toMatchObject({ start: "2026-09-25", end: "2026-09-27", days: 3, amount: 150, daily: 50 });
    const full = mapBudget(periods, "per_period_daily", "2026-09-25", "full");
    expect(full.lines[0]).toMatchObject({ amount: 350, daily: 116.66 });
    const later = mapBudget(periods, "lifetime_per_period", "2026-10-05");
    expect(later.skipped).toEqual(["Sep 21–27: already over", "Sep 28–Oct 4: already over"]);
    expect(later.lines).toHaveLength(1);
  });

  it("schedules the later periods on top of the first daily budget", () => {
    const m = mapBudget(periods.slice(0, 2), "per_period_daily", "2026-09-01");
    const spec = budgetSpec(m)!;
    expect(spec).toEqual({ type: "daily", amount: 50, schedules: [{ start: "2026-09-28", end: "2026-10-04", amount: 57.14 }] });
    // What it spends is the sheet's total (to the cent the daily rounding leaves)
    expect(specSpend(spec, "2026-09-21", "2026-10-04")).toBeCloseTo(1099.98, 2);
    expect(budgetSpec(mapBudget(periods, "single_lifetime", "2026-09-01"))).toEqual({ type: "lifetime", amount: 6035.47 });
  });

  it("checks the sheet's own math", () => {
    expect(budgetSanity(15000, 1464.53, [{ label: "a", start: null, end: null, amount: 13535.47 }])).toEqual([]);
    expect(budgetSanity(15000, 1464.53, [{ label: "a", start: null, end: null, amount: 13000 }])[0]).toMatch(/535\.47 difference/);
  });
});
