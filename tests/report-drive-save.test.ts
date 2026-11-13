import { describe, expect, it } from "vitest";
import { ensureReportFolder, monthFolderName, monthStyleOf, parseMonthFolder, REPORT_MONTH_STYLE, reportSteps, type FolderDrive } from "@/lib/creative-drive-paths";
import { reportFileName, safeFileName } from "@/lib/reports/drive-save-core";
import { notesOf } from "@/lib/reports/weekly-doc";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November"].map((m) => `${m} 01 2026`);

/** A fake Drive: folders by parent */
function fake(tree: Record<string, string[]>) {
  const ids = new Map<string, { id: string; name: string }[]>();
  let n = 0;
  for (const [parent, names] of Object.entries(tree)) ids.set(parent, names.map((name) => ({ id: `${parent}/${name}`, name })));
  const created: string[] = [];
  const drive: FolderDrive = {
    async listFolders(p) {
      return ids.get(p) ?? [];
    },
    async createFolder(p, name) {
      const id = `new${++n}:${name}`;
      ids.set(p, [...(ids.get(p) ?? []), { id, name }]);
      created.push(name);
      return id;
    },
  };
  return { drive, created };
}

describe("report month folders: {NAME} 01 {YEAR}", () => {
  it("reads 'November 01 2026' as November, whatever the day's 01 looks like", () => {
    expect(parseMonthFolder("November 01 2026")?.month).toBe(11);
    expect(parseMonthFolder("January 01 2026")?.month).toBe(1);
    expect(parseMonthFolder("February 01 2026")?.month).toBe(2);
    expect(parseMonthFolder("December 01 2026")?.month).toBe(12);
  });
  it("still reads the older styles", () => {
    expect(parseMonthFolder("11 - November")?.month).toBe(11);
    expect(parseMonthFolder("2026-11")?.month).toBe(11);
    expect(parseMonthFolder("Nov")?.month).toBe(11);
    expect(parseMonthFolder("11 Promo ideas")).toBeNull();
  });
  it("names a new month like its siblings", () => {
    const style = monthStyleOf(MONTHS)!;
    expect(monthFolderName(12, "2026", style)).toBe("December 01 2026");
    expect(monthFolderName(3, "2027", style)).toBe("March 01 2027");
    expect(monthFolderName(11, "2026", REPORT_MONTH_STYLE)).toBe("November 01 2026");
  });
  it("matches the month we're in when saving (New York time), not the report's period", () => {
    const [, month] = reportSteps("2026-11-13T15:00:00Z");
    expect(month.match("November 01 2026")).toBe(true);
    expect(month.match("October 01 2026")).toBe(false);
    // Midnight UTC on the 1st is still the evening of the 31st in New York
    expect(reportSteps("2026-12-01T02:00:00Z")[1].name([])).toBe("November 01 2026");
  });
});

describe("where a report is saved", () => {
  it("goes into the existing folders", async () => {
    const { drive, created } = fake({ client: ["10 - Brand", "30 - Reports"], "client/30 - Reports": ["2025", "2026"], "client/30 - Reports/2026": MONTHS });
    expect(await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z")).toBe("client/30 - Reports/2026/November 01 2026");
    expect(created).toEqual([]);
  });
  it("makes the missing month in the siblings' style", async () => {
    const { drive, created } = fake({ client: ["Reports"], "client/Reports": ["2026"], "client/Reports/2026": MONTHS.slice(0, 10) });
    await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z");
    expect(created).toEqual(["November 01 2026"]);
  });
  it("uses this month's folder right in the reports folder first (no year folder in between)", async () => {
    const { drive, created } = fake({ client: ["30 - Reports"], "client/30 - Reports": MONTHS });
    expect(await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z")).toBe("client/30 - Reports/November 01 2026");
    expect(created).toEqual([]);
  });
  it("prefers the month in the reports folder over a year folder made beside it", async () => {
    const { drive, created } = fake({ client: ["30 - Reports"], "client/30 - Reports": [...MONTHS, "2026"], "client/30 - Reports/2026": ["November 01 2026"] });
    expect(await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z")).toBe("client/30 - Reports/November 01 2026");
    expect(created).toEqual([]);
  });
  it("makes the missing month right in the reports folder when the months live there", async () => {
    const { drive, created } = fake({ client: ["30 - Reports"], "client/30 - Reports": MONTHS.slice(0, 10) });
    await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z");
    expect(created).toEqual(["November 01 2026"]);
    expect((await drive.listFolders("client/30 - Reports")).map((f) => f.name)).toContain("November 01 2026");
  });
  it("doesn't take last year's November", async () => {
    const { drive, created } = fake({ client: ["30 - Reports"], "client/30 - Reports": ["November 01 2025", "2026"], "client/30 - Reports/2026": [] });
    await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z");
    expect(created).toEqual(["November 01 2026"]);
    expect((await drive.listFolders("client/30 - Reports/2026")).map((f) => f.name)).toEqual(["November 01 2026"]);
  });
  it("makes 30 - Reports, the year and the month when there are none", async () => {
    const { drive, created } = fake({ client: ["Brand"] });
    await ensureReportFolder(drive, "client", "2026-11-13T15:00:00Z");
    expect(created).toEqual(["30 - Reports", "2026", "November 01 2026"]);
  });
});

describe("the file name", () => {
  it("is the report's own name", () => {
    expect(reportFileName({ client: "OceanBox", whiteLabel: false, built: false, kind: "weekly", platform: "meta", periodLabel: "Nov 6 - Nov 12" })).toBe("OceanBox - Meta report - Nov 6 - Nov 12.pdf");
  });
  it("names no agency for a white label client", () => {
    const n = reportFileName({ client: "OceanBox", whiteLabel: true, built: false, kind: "weekly", platform: "meta", periodLabel: "Nov 6 - Nov 12" });
    expect(n).toMatch(/\.pdf$/);
    expect(n.toLowerCase()).not.toContain("kaizen");
  });
  it("is safe for every computer Drive syncs to", () => {
    expect(safeFileName("A/B: C?.pdf")).toBe("A-B- C-.pdf");
  });
});

describe("our notes", () => {
  it("carry the headline, summary and the three lists, and skip empty ones", () => {
    const n = notesOf({ headline: "A strong week", summary: "Purchases up.", did: ["Refreshed ads"], doing: [], next: ["Test a new offer"], highlights: [] });
    expect(n.headline).toBe("A strong week");
    expect(n.groups.map((g) => g.title)).toEqual(["What we did", "What's next"]);
    expect(n.empty).toBe(false);
    expect(notesOf({ headline: "", summary: "", did: [], doing: [], next: [], highlights: [] }).empty).toBe(true);
  });
});
