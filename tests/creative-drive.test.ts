import { describe, expect, it } from "vitest";
import {
  briefFileStem,
  classifyDriveError,
  cleanName,
  DEFAULT_MONTH_STYLE,
  driveFileName,
  ensureAdCreative,
  ensureFolderPath,
  findOrCreateFolder,
  folderIdOf,
  isAdCreativeName,
  isOldLayoutPath,
  isTicketFolder,
  locateAdCreative,
  MAX_ATTEMPTS,
  monthFolderName,
  monthStyleOf,
  NO_DRIVE,
  nextAttempt,
  rootPlan,
  parseMonthFolder,
  parseYearFolder,
  relocateFile,
  slotOf,
  ticketFolderName,
  ticketPath,
  ticketSteps,
  yearFolderName,
  yearMonth,
  type FolderCache,
  type FolderDrive,
  type MoveDrive,
} from "@/lib/creative-drive-paths";
import { specsChecklist } from "@/lib/brief-pdf-model";
import { driveStates, type DriveStateRow } from "@/lib/creative-drive";

/** A Drive with folders only (oldest first), counting what it makes and trashes */
function fakeDrive(seed: Record<string, { id: string; name: string }[]> = {}) {
  const children = new Map(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  let n = 0;
  const calls = { list: 0, create: 0, trash: 0 };
  const drive: FolderDrive & { trashFolder(id: string): Promise<void> } = {
    async listFolders(parent) {
      calls.list++;
      return [...(children.get(parent) ?? [])];
    },
    async createFolder(parent, name) {
      calls.create++;
      const id = `new${++n}`;
      children.set(parent, [...(children.get(parent) ?? []), { id, name }]);
      return id;
    },
    async trashFolder(id) {
      calls.trash++;
      for (const [k, v] of children) children.set(k, v.filter((f) => f.id !== id));
    },
  };
  return { drive, calls, children };
}

function memoryCache(): FolderCache & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(p) {
      return map.get(p) ?? null;
    },
    async put(p, id) {
      if (!map.has(p)) map.set(p, id);
      return map.get(p)!;
    },
    async forget() {
      map.clear();
    },
  };
}

const names = (c: Map<string, { id: string; name: string }[]>, parent: string) => (c.get(parent) ?? []).map((f) => f.name);

describe("names", () => {
  it("cleans what Drive and computers can't hold", () => {
    expect(cleanName('Summer / Sale: "50%" off?')).toBe("Summer Sale 50% off");
    expect(cleanName("  ")).toBe("Untitled");
    expect(cleanName(null)).toBe("Untitled");
    expect(cleanName(`Mother's Day ${String.fromCharCode(0x2014)} Gifts & More`)).toBe("Mother's Day - Gifts & More");
    expect(cleanName("a".repeat(100)).length).toBeLessThanOrEqual(80);
    expect(cleanName("...hidden.")).toBe("hidden");
  });

  it("names files the way the brief does, by design number and size", () => {
    expect(driveFileName({ client: "Acme Co", title: "Summer Sale", position: 2, card: null, aspect: "4x5", originalName: "01-ab12-final.PNG", mime: "image/png" })).toBe("Acme_Co_Summer_Sale_V2_4x5.png");
    expect(driveFileName({ client: "Acme", title: "Promo", position: 1, card: 3, aspect: "4x5", originalName: "x.jpg", mime: "image/jpeg" })).toBe("Acme_Promo_V1_Slide03_4x5.jpg");
    expect(driveFileName({ client: "Acme", title: "Promo", position: 1, card: null, aspect: "9x16", originalName: "clip", mime: "video/mp4" })).toBe("Acme_Promo_V1_9x16.mp4");
    // No size known: the original name tells files apart
    expect(driveFileName({ client: "Acme", title: "Promo", position: 1, card: null, aspect: null, originalName: "01-ab12-hero shot.mov", mime: "video/quicktime" })).toBe("Acme_Promo_V1_hero_shot.mov");
  });

  it("uses the same file name stem as the brief's specs checklist", () => {
    const stem = briefFileStem("Alcoa Tickets", "Best Seat Hack");
    expect(stem).toBe("Alcoa_Tickets_Best_Seat_Hack");
    expect(specsChecklist({}, ["4x5"], "Alcoa Tickets", "Best Seat Hack").some((l) => l.includes(`${stem}_V1_4x5`))).toBe(true);
  });

  it("names the ticket's folder by its number and a short title, and knows it by number", () => {
    expect(ticketFolderName(1234, "Best Seat Hack")).toBe("#1234 Best Seat Hack");
    expect(ticketFolderName(1234, "  ")).toBe("#1234");
    expect(ticketFolderName(7, "Sale: 50% / off")).toBe("#7 Sale 50% off");
    expect(isTicketFolder("#1234 Best Seat Hack", 1234)).toBe(true);
    expect(isTicketFolder("1234 - Old title", 1234)).toBe(true);
    expect(isTicketFolder("#12345 Other", 1234)).toBe(false);
    expect(isTicketFolder("#123 Other", 1234)).toBe(false);
  });

  it("files a ticket by its New York month, stable whatever the folder names are", () => {
    // 2am UTC on Dec 1 is still Nov 30 in New York
    expect(yearMonth("2026-12-01T02:00:00Z")).toEqual({ year: "2026", num: 11, month: "November", key: "2026-11" });
    expect(ticketPath("2026-12-01T02:00:00Z", 1234)).toBe("2026/11/#1234");
    expect(ticketPath("2027-01-15T15:00:00Z", 9)).toBe("2027/01/#9");
  });

  it("knows an earlier layout's top folders", () => {
    expect(isOldLayoutPath("Liquidating Seller")).toBe(true);
    expect(isOldLayoutPath("_Not tied to an avatar")).toBe(true);
    expect(isOldLayoutPath("2026")).toBe(false);
    expect(isOldLayoutPath("2026/11/#1234")).toBe(false);
    expect(isOldLayoutPath("Liquidating Seller/Cash in a week")).toBe(false);
  });

  it("gives each size and slide a stable slot (the next round is the same Drive file)", () => {
    expect(slotOf({ card: 2, aspect: "4x5", original_name: "a.png" })).toBe("card:2");
    expect(slotOf({ card: null, aspect: "9x16", original_name: "a.png" })).toBe("size:9x16");
    expect(slotOf({ card: null, aspect: null, original_name: "01-ab12-Hero.mov" })).toBe(slotOf({ card: null, aspect: null, original_name: "03-ff00-hero.mov" }));
  });
});

describe("year and month naming", () => {
  it("reads year folders and names a new one like them", () => {
    expect(parseYearFolder("2026")).toBe(2026);
    expect(parseYearFolder("FY2025")).toBe(2025);
    expect(parseYearFolder("Year 2024")).toBe(2024);
    expect(parseYearFolder("2026 Promo")).toBeNull();
    expect(parseYearFolder("Brand")).toBeNull();
    expect(yearFolderName("2026", ["Brand", "FY2025"])).toBe("FY2026");
    expect(yearFolderName("2026", ["Brand"])).toBe("2026");
  });

  it("reads month folders in any common naming", () => {
    expect(parseMonthFolder("11 - November")).toEqual({ month: 11, style: { template: "{NUM} - {NAME}", pad: true, abbr: false, case: "title" } });
    expect(parseMonthFolder("November")?.style.template).toBe("{NAME}");
    expect(parseMonthFolder("03. Mar")).toEqual({ month: 3, style: { template: "{NUM}. {NAME}", pad: true, abbr: true, case: "title" } });
    expect(parseMonthFolder("2026-11")).toEqual({ month: 11, style: { template: "{YEAR}-{NUM}", pad: true, abbr: false, case: "title" } });
    expect(parseMonthFolder("4 APRIL")).toEqual({ month: 4, style: { template: "{NUM} {NAME}", pad: false, abbr: false, case: "upper" } });
    expect(parseMonthFolder("11")?.month).toBe(11);
    // Not month folders
    expect(parseMonthFolder("11 Promo ideas")).toBeNull();
    expect(parseMonthFolder("13")).toBeNull();
    expect(parseMonthFolder("03 - November")).toBeNull();
    expect(parseMonthFolder("#1234 Best Seat Hack")).toBeNull();
    expect(parseMonthFolder("Mayhem")).toBeNull();
  });

  it("names a new month like the client's other months, else 11 - November", () => {
    expect(monthFolderName(11, "2026")).toBe("11 - November");
    expect(monthFolderName(3, "2026", DEFAULT_MONTH_STYLE)).toBe("03 - March");
    expect(monthFolderName(11, "2026", monthStyleOf(["September", "October", "Brief docs"])!)).toBe("November");
    expect(monthFolderName(2, "2027", monthStyleOf(["11. Nov", "12. Dec"])!)).toBe("02. Feb");
    expect(monthFolderName(2, "2027", monthStyleOf(["1 jan", "12 dec"])!)).toBe("2 feb");
    expect(monthFolderName(1, "2027", monthStyleOf(["2026-11", "2026-12"])!)).toBe("2027-01");
    // Padding learned from any month that shows it ("10" alone can't tell)
    expect(monthStyleOf(["10 - October"])!.pad).toBe(true);
    expect(monthStyleOf(["Brand", "#12 Promo"])).toBeNull();
  });
});

describe("folders", () => {
  const ticket = { createdAt: "2026-11-10T15:00:00Z", number: 1234, title: "Best Seat Hack" };

  it("makes Year / Month / #ticket once, then reuses them", async () => {
    const { drive, calls, children } = fakeDrive();
    const cache = memoryCache();
    const a = await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", ticket));
    expect(calls.create).toBe(3);
    expect(names(children, "root")).toEqual(["2026"]);
    expect(names(children, cache.map.get("2026")!)).toEqual(["11 - November"]);
    expect(names(children, cache.map.get("2026/11")!)).toEqual(["#1234 Best Seat Hack"]);
    expect(cache.map.get("2026/11/#1234")).toBe(a);
    const b = await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", ticket));
    expect(b).toBe(a);
    expect(calls.create).toBe(3); // nothing made twice
    // Another ticket the same month reuses the year and month
    await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", { ...ticket, number: 1235, title: "Promo" }));
    expect(calls.create).toBe(4);
  });

  it("uses the year and month folders already there, in their naming, without the cache", async () => {
    const { drive, calls, children } = fakeDrive({
      root: [{ id: "y25", name: "2025" }, { id: "y", name: "2026" }],
      y: [{ id: "oct", name: "October" }, { id: "nov", name: "november" }],
      nov: [{ id: "t", name: "#1234 Old title" }],
    });
    const cache = memoryCache();
    expect(await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", ticket))).toBe("t");
    expect(calls.create).toBe(0);
    expect(cache.map.get("2026/11")).toBe("nov");
    // A new month in that year is named like its siblings
    await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", { ...ticket, createdAt: "2026-12-10T15:00:00Z" }));
    expect(names(children, "y")).toContain("December");
  });

  it("names a new year's first month like the latest year before it", async () => {
    const { drive, children } = fakeDrive({ root: [{ id: "y", name: "2026" }], y: [{ id: "a", name: "11. Nov" }, { id: "b", name: "12. Dec" }] });
    const cache = memoryCache();
    await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", { ...ticket, createdAt: "2027-01-10T15:00:00Z" }));
    expect(names(children, "root")).toEqual(["2026", "2027"]);
    expect(names(children, cache.map.get("2027")!)).toEqual(["01. Jan"]);
  });

  it("makes nothing twice after the cache is forgotten (found again)", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const first = await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", ticket));
    await cache.forget();
    expect(await ensureFolderPath(drive, cache, "root", ticketSteps(drive, "root", ticket))).toBe(first);
    expect(calls.create).toBe(3);
  });

  it("two uploads racing end on one folder: the loser's empty folder goes to the trash", async () => {
    const { drive, calls, children } = fakeDrive();
    // Both look before either makes: each makes a "2026"
    const racing: FolderDrive & { trashFolder(id: string): Promise<void> } = {
      ...drive,
      listFolders: async (p) => (calls.create < 2 && p === "root" && calls.list++ < 2 ? [] : drive.listFolders(p)),
    };
    const step = ticketSteps(racing, "root", ticket)[0];
    const [a, b] = await Promise.all([findOrCreateFolder(racing, "root", step), findOrCreateFolder(racing, "root", step)]);
    expect(a.id).toBe(b.id);
    expect(calls.trash).toBe(1);
    expect(names(children, "root")).toEqual(["2026"]);
  });

  it("keeps the cached id that won a race, trashing the one it just made", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const slow: FolderCache = { ...cache, get: async () => null, put: async (p) => (p === "2026" ? "winner" : cache.put(p, "x")) };
    const steps = ticketSteps(drive, "root", ticket).slice(0, 1);
    expect(await ensureFolderPath(drive, slow, "root", steps)).toBe("winner");
    expect(calls.trash).toBe(1);
  });

  it("finds the Ad Creatives folder by name, preferring the client folder's own", async () => {
    expect(isAdCreativeName("Ad Creatives")).toBe(true);
    expect(isAdCreativeName("20 - Ad Creatives")).toBe(true);
    expect(isAdCreativeName("ad creative")).toBe(true);
    expect(isAdCreativeName("Ads-Creative")).toBe(true);
    expect(isAdCreativeName("Ad Creatives OLD")).toBe(false);
    expect(isAdCreativeName("Best Tickets - Headquarters")).toBe(false);
    const direct = fakeDrive({ c: [{ id: "x", name: "Best Tickets - Headquarters" }, { id: "ac", name: "20 - Ad Creatives" }], x: [{ id: "deep", name: "Ad Creatives" }] });
    expect(await locateAdCreative(direct.drive, "c")).toBe("ac");
    const plain = fakeDrive({ c: [{ id: "long", name: "Ad Creatives - Archive of ideas 2024" }, { id: "p", name: "Ad Creatives" }] });
    expect(await locateAdCreative(plain.drive, "c")).toBe("p");
    const nested = fakeDrive({ c: [{ id: "k", name: "Kaizen" }], k: [{ id: "ac2", name: "AD CREATIVE" }] });
    expect(await locateAdCreative(nested.drive, "c")).toBe("ac2");
    const none = fakeDrive({ c: [{ id: "k", name: "Kaizen" }] });
    expect(await locateAdCreative(none.drive, "c")).toBeNull();
    expect(none.calls.create).toBe(0);
  });

  it("makes an Ad Creatives folder in the client folder when there is none, once", async () => {
    const { drive, calls, children } = fakeDrive({ c: [{ id: "k", name: "Brand" }] });
    const first = await ensureAdCreative(drive, "c");
    expect(first.made).toBe(true);
    expect(names(children, "c")).toEqual(["Brand", "Ad Creatives"]);
    expect(await ensureAdCreative(drive, "c")).toEqual({ id: first.id, made: false });
    expect(calls.create).toBe(1);
    // Found ones are never made
    const has = fakeDrive({ c: [{ id: "ac", name: "20 - Ad Creatives" }] });
    expect(await ensureAdCreative(has.drive, "c")).toEqual({ id: "ac", made: false });
    expect(has.calls.create).toBe(0);
  });

  it("with no Drive folder, nothing is looked for or made: the ticket says Drive isn't connected", () => {
    expect(rootPlan({ ad_creative_folder_id: "set", drive_folder_id: "c" })).toEqual({ use: "set" }); // a choice by hand wins
    expect(rootPlan({ ad_creative_folder_id: null, drive_folder_id: "c" })).toEqual({ lookIn: "c" });
    expect(rootPlan({ ad_creative_folder_id: null, drive_folder_id: null })).toEqual({ noDrive: true });
    expect(rootPlan(null)).toEqual({ noDrive: true });
    const s = driveStates([{ want_file_id: "f", synced_file_id: null, status: "error", drive_url: null, op: "upload", attempts: 0, error: `${NO_DRIVE}. The file is saved here`, error_kind: "no_folder" }]);
    expect(s.get("f")).toMatchObject({ status: "error", kind: "no_folder" });
    expect(s.get("f")!.error!.startsWith(NO_DRIVE)).toBe(true);
  });

  it("reads a folder id from a pasted link", () => {
    expect(folderIdOf("https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing")).toBe("1AbCdEfGhIjK");
    expect(folderIdOf("https://drive.google.com/open?id=1AbCdEfGhIjK")).toBe("1AbCdEfGhIjK");
    expect(folderIdOf(" 1AbCdEfGhIjK ")).toBe("1AbCdEfGhIjK");
  });
});

/** A Drive with folders and files, where files only ever move (never copied, re-uploaded or deleted) */
function fakeMoveDrive(seed: Record<string, { id: string; name: string }[]>, files: Record<string, { parents: string[]; name: string; trashed?: boolean }>) {
  const base = fakeDrive(seed);
  const calls = { ...base.calls, move: 0, rename: 0 };
  const drive: MoveDrive = {
    listFolders: (p) => base.drive.listFolders(p),
    createFolder: (p, n) => base.drive.createFolder(p, n),
    async where(id) {
      const f = files[id];
      return f ? { parents: [...f.parents], name: f.name, trashed: Boolean(f.trashed) } : null;
    },
    async move(id, to, from, name) {
      calls.move++;
      const f = files[id];
      f.parents = [...f.parents.filter((x) => !from.includes(x) && x !== to), to];
      if (name) f.name = name;
    },
    async rename(id, name) {
      calls.rename++;
      files[id].name = name;
    },
  };
  return { drive, calls, files, children: base.children, base };
}

describe("moving what's already in Drive", () => {
  // The avatar layout: Ad Creative / Liquidating Seller / Cash in a week / 2026-11 Promo / the file
  const avatarLayout = () => ({
    root: [{ id: "av", name: "Liquidating Seller" }],
    av: [{ id: "an", name: "Cash in a week" }],
    an: [{ id: "c", name: "2026-11 Promo" }],
    c: [{ id: "rep", name: "_Replaced" }],
  });
  const t = { createdAt: "2026-11-10T15:00:00Z", number: 1234, title: "Promo" };

  it("moves a file into Year / Month / #ticket, once, and leaves the old folders where they are", async () => {
    const f = fakeMoveDrive(avatarLayout(), { f1: { parents: ["c"], name: "Acme - Promo - V1 - 4x5.png" } });
    const cache = memoryCache();
    const steps = () => ticketSteps(f.drive, "root", t);
    const first = await relocateFile(f.drive, cache, "root", { fileId: "f1", steps: steps(), replaced: false, name: "Acme_Promo_V1_4x5.png" });
    expect(first.result).toBe("moved");
    expect(f.files.f1).toEqual({ parents: [first.folder], name: "Acme_Promo_V1_4x5.png" });
    expect(cache.map.get("2026/11/#1234")).toBe(first.folder);
    // The avatar folders are still there (nothing deleted)
    expect(names(f.children, "root")).toEqual(["Liquidating Seller", "2026"]);
    // Running again moves nothing and makes nothing
    const again = await relocateFile(f.drive, cache, "root", { fileId: "f1", steps: steps(), replaced: false, name: "Acme_Promo_V1_4x5.png" });
    expect(again).toEqual({ result: "in_place", folder: first.folder });
    expect(f.calls.move).toBe(1);
    expect(f.base.calls.create).toBe(3);
  });

  it("puts a replaced file in _Replaced inside its ticket folder", async () => {
    const f = fakeMoveDrive(avatarLayout(), { f2: { parents: ["rep"], name: "x.mp4" } });
    const cache = memoryCache();
    const r = await relocateFile(f.drive, cache, "root", { fileId: "f2", steps: ticketSteps(f.drive, "root", t), replaced: true });
    expect(r.result).toBe("moved");
    const folder = cache.map.get("2026/11/#1234")!;
    expect(f.children.get(folder)).toEqual([{ id: r.folder, name: "_Replaced" }]);
    expect(f.files.f2.name).toBe("x.mp4"); // no name given: kept
  });

  it("a renamed ticket keeps its folder and only renames the file", async () => {
    const f = fakeMoveDrive(avatarLayout(), { f3: { parents: ["c"], name: "Acme_Promo_V1_4x5.png" } });
    const cache = memoryCache();
    const a = await relocateFile(f.drive, cache, "root", { fileId: "f3", steps: ticketSteps(f.drive, "root", t), replaced: false });
    const b = await relocateFile(f.drive, cache, "root", { fileId: "f3", steps: ticketSteps(f.drive, "root", { ...t, title: "Spring Promo" }), replaced: false, name: "Acme_Spring_Promo_V1_4x5.png" });
    expect(b).toEqual({ result: "renamed", folder: a.folder });
    expect(f.files.f3.name).toBe("Acme_Spring_Promo_V1_4x5.png");
  });

  it("leaves a file deleted or trashed in Drive alone, making no folders for it", async () => {
    const f = fakeMoveDrive(avatarLayout(), { t: { parents: ["c"], name: "x.png", trashed: true } });
    const cache = memoryCache();
    expect((await relocateFile(f.drive, cache, "root", { fileId: "t", steps: ticketSteps(f.drive, "root", t), replaced: false })).result).toBe("gone");
    expect((await relocateFile(f.drive, cache, "root", { fileId: "missing", steps: ticketSteps(f.drive, "root", t), replaced: false })).result).toBe("gone");
    expect(f.base.calls.create).toBe(0);
    expect(f.calls.move).toBe(0);
  });
});

describe("retries and errors", () => {
  it("backs off, then stops", () => {
    const now = 0;
    expect(nextAttempt(1, now)!.getTime()).toBe(60_000);
    expect(nextAttempt(2, now)!.getTime()).toBe(5 * 60_000);
    expect(nextAttempt(MAX_ATTEMPTS, now)).toBeNull();
  });

  it("says when the service account isn't allowed Drive", () => {
    const c = classifyDriveError("unauthorized_client: Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.");
    expect(c.kind).toBe("no_access");
    expect(c.retry).toBe(false);
    expect(c.text).toContain("Drive access not allowed for the service account");
    expect(classifyDriveError("Drive POST /upload: 503 backend").retry).toBe(true);
  });
});

describe("statuses on the ticket", () => {
  const row = (r: Partial<DriveStateRow>): DriveStateRow => ({ want_file_id: null, synced_file_id: null, status: "pending", drive_url: null, op: "upload", attempts: 0, error: null, error_kind: null, ...r });

  it("shows in Drive, syncing, or the error, on the right file", () => {
    const s = driveStates([
      row({ want_file_id: "a", synced_file_id: "a", status: "synced", drive_url: "https://drive/a" }),
      row({ want_file_id: "b2", synced_file_id: "b1", status: "pending", drive_url: "https://drive/b" }),
      row({ want_file_id: "c", status: "error", error: "No Ad Creative folder found for this client", error_kind: "no_folder" }),
      row({ want_file_id: "d", synced_file_id: "d", status: "pending", op: "retire" }),
    ]);
    expect(s.get("a")).toMatchObject({ status: "synced", url: "https://drive/a" });
    expect(s.get("b2")).toMatchObject({ status: "syncing" });
    expect(s.get("b1")).toBeUndefined(); // the earlier round is the Drive file's history
    expect(s.get("c")).toMatchObject({ status: "error", kind: "no_folder" });
    expect(s.get("d")).toBeUndefined();
  });
});
