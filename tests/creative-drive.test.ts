import { describe, expect, it } from "vitest";
import {
  angleFolderName,
  avatarFolderName,
  avatarSegments,
  classifyDriveError,
  cleanName,
  conceptName,
  driveFileName,
  ensureFolderPath,
  folderIdOf,
  folderSegments,
  isAdCreativeName,
  isOldLayoutPath,
  locateAdCreative,
  MAX_ATTEMPTS,
  nextAttempt,
  relocateFile,
  slotOf,
  yearMonth,
  type FolderCache,
  type FolderDrive,
  type MoveDrive,
} from "@/lib/creative-drive-paths";
import { driveStates, type DriveStateRow } from "@/lib/creative-drive";

/** A Drive with folders only, counting what it makes */
function fakeDrive(seed: Record<string, { id: string; name: string }[]> = {}) {
  const children = new Map(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  let n = 0;
  const calls = { list: 0, create: 0 };
  const drive: FolderDrive = {
    async listFolders(parent) {
      calls.list++;
      return children.get(parent) ?? [];
    },
    async createFolder(parent, name) {
      calls.create++;
      const id = `new${++n}`;
      children.set(parent, [...(children.get(parent) ?? []), { id, name }]);
      return id;
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

describe("names", () => {
  it("cleans what Drive and computers can't hold", () => {
    expect(cleanName('Summer / Sale: "50%" off?')).toBe("Summer Sale 50% off");
    expect(cleanName("  ")).toBe("Untitled");
    expect(cleanName(null)).toBe("Untitled");
    expect(cleanName(`Mother's Day ${String.fromCharCode(0x2014)} Gifts & More`)).toBe("Mother's Day - Gifts & More");
    expect(cleanName("a".repeat(100)).length).toBeLessThanOrEqual(80);
    expect(cleanName("...hidden.")).toBe("hidden");
  });

  it("names files by client, concept, design number and size", () => {
    expect(driveFileName({ client: "Acme Co", concept: "Summer Sale", position: 2, card: null, aspect: "4x5", originalName: "01-ab12-final.PNG", mime: "image/png" })).toBe("Acme Co - Summer Sale - V2 - 4x5.png");
    expect(driveFileName({ client: "Acme", concept: "Promo", position: 1, card: 3, aspect: "4x5", originalName: "x.jpg", mime: "image/jpeg" })).toBe("Acme - Promo - V1 - Slide 03 - 4x5.jpg");
    expect(driveFileName({ client: "Acme", concept: "Promo", position: 1, card: null, aspect: "9x16", originalName: "clip", mime: "video/mp4" })).toBe("Acme - Promo - V1 - 9x16.mp4");
    // No size known: the original name tells files apart
    expect(driveFileName({ client: "Acme", concept: "Promo", position: 1, card: null, aspect: null, originalName: "01-ab12-hero shot.mov", mime: "video/quicktime" })).toBe("Acme - Promo - V1 - hero shot.mov");
  });

  it("keeps a concept's number only when another ticket that month has the same title", () => {
    expect(conceptName("Summer Sale", 42, false)).toBe("Summer Sale");
    expect(conceptName("Summer Sale", 42, true)).toBe("Summer Sale #42");
  });

  it("names an avatar's folder by its Bible name, without the letter, the confidence or a description", () => {
    expect(avatarFolderName("A · Liquidating Seller (Likely)")).toBe("Liquidating Seller");
    expect(avatarFolderName("**B. Fresh-Fish Seeker**: buys every week (Proven)")).toBe("Fresh-Fish Seeker");
    expect(avatarFolderName(`C) Weekend Warrior Dad ${String.fromCharCode(0x2014)} 35 to 50`)).toBe("Weekend Warrior Dad");
    expect(avatarFolderName("Busy Mom")).toBe("Busy Mom");
    expect(avatarFolderName("  ")).toBeNull();
    expect(avatarFolderName(null)).toBeNull();
    expect(avatarSegments(null)).toEqual(["_Not tied to an avatar"]);
    expect(avatarSegments("", true)).toEqual(["_Not tied to an avatar"]);
    expect(avatarSegments("Weekend Warrior Dad", true)).toEqual(["_Avatar tests", "Weekend Warrior Dad"]);
    expect(avatarSegments("A · Liquidating Seller (Likely)", false)).toEqual(["Liquidating Seller"]);
  });

  it("shortens an angle to its first clause, five words at most, the same every time", () => {
    expect(angleFolderName("Cash in a week, without open houses or repairs")).toBe("Cash in a week");
    expect(angleFolderName("fear of missing out for busy parents")).toBe("Fear of missing out");
    expect(angleFolderName(`Speed ${String.fromCharCode(0x2014)} sold in 7 days`)).toBe("Speed");
    expect(angleFolderName('"Stop overpaying": the real cost of agents')).toBe("Stop overpaying");
    expect(angleFolderName("Before / after: the kitchen")).toBe("Before");
    expect(angleFolderName("Social proof")).toBe(angleFolderName("Social proof"));
    expect(angleFolderName("  ")).toBeNull();
    expect(angleFolderName(null)).toBeNull();
  });

  it("lays folders out by avatar, angle, then the dated concept (New York month)", () => {
    // 2am UTC on Dec 1 is still Nov 30 in New York
    expect(yearMonth("2026-12-01T02:00:00Z")).toEqual({ year: "2026", month: "November", key: "2026-11" });
    expect(folderSegments({ createdAt: "2026-12-01T02:00:00Z", concept: "Promo", avatar: "A · Liquidating Seller (Likely)", angle: "Cash in a week, no repairs" })).toEqual([
      "Liquidating Seller",
      "Cash in a week",
      "2026-11 Promo",
    ]);
    expect(folderSegments({ createdAt: "2027-01-15T15:00:00Z", concept: "Summer Sale #42", avatar: "Weekend Warrior Dad", avatarTest: true, angle: null })).toEqual([
      "_Avatar tests",
      "Weekend Warrior Dad",
      "_No angle",
      "2027-01 Summer Sale #42",
    ]);
    expect(folderSegments({ createdAt: "2027-01-15T15:00:00Z", concept: "Promo" })).toEqual(["_Not tied to an avatar", "_No angle", "2027-01 Promo"]);
  });

  it("knows the first layout's Year and Month folders", () => {
    expect(isOldLayoutPath("2026")).toBe(true);
    expect(isOldLayoutPath("2026/November")).toBe(true);
    expect(isOldLayoutPath("2026/November/Promo")).toBe(false);
    expect(isOldLayoutPath("Liquidating Seller")).toBe(false);
    expect(isOldLayoutPath("2026/Cash in a week")).toBe(false);
  });

  it("gives each size and slide a stable slot (the next round is the same Drive file)", () => {
    expect(slotOf({ card: 2, aspect: "4x5", original_name: "a.png" })).toBe("card:2");
    expect(slotOf({ card: null, aspect: "9x16", original_name: "a.png" })).toBe("size:9x16");
    expect(slotOf({ card: null, aspect: null, original_name: "01-ab12-Hero.mov" })).toBe(slotOf({ card: null, aspect: null, original_name: "03-ff00-hero.mov" }));
  });
});

describe("folders", () => {
  it("makes avatar, angle and concept once, then reuses them", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const segs = ["Liquidating Seller", "Cash in a week", "2026-11 Summer Sale"];
    const a = await ensureFolderPath(drive, cache, "root", segs);
    expect(calls.create).toBe(3);
    const b = await ensureFolderPath(drive, cache, "root", segs);
    expect(b).toBe(a);
    expect(calls.create).toBe(3); // nothing made twice
    // A sibling concept reuses the avatar and angle
    await ensureFolderPath(drive, cache, "root", ["Liquidating Seller", "Cash in a week", "2026-11 Black Friday"]);
    expect(calls.create).toBe(4);
  });

  it("uses folders someone already made by hand (any case), without the cache", async () => {
    const { drive, calls } = fakeDrive({ root: [{ id: "av", name: "liquidating seller" }], av: [{ id: "an", name: "Cash In A Week" }] });
    const cache = memoryCache();
    await ensureFolderPath(drive, cache, "root", ["Liquidating Seller", "Cash in a week", "2026-11 Promo"]);
    expect(calls.create).toBe(1);
    expect(cache.map.get("Liquidating Seller")).toBe("av");
    expect(cache.map.get("Liquidating Seller/Cash in a week")).toBe("an");
  });

  it("makes nothing twice after the cache is forgotten (found by name again)", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const segs = ["_Not tied to an avatar", "_No angle", "2026-11 Promo"];
    const first = await ensureFolderPath(drive, cache, "root", segs);
    await cache.forget();
    expect(await ensureFolderPath(drive, cache, "root", segs)).toBe(first);
    expect(calls.create).toBe(3);
  });

  it("keeps the cached id that won a race", async () => {
    const { drive } = fakeDrive();
    const cache = memoryCache();
    cache.map.set("2026", "winner");
    expect(await ensureFolderPath(drive, cache, "root", ["2026"])).toBe("winner");
  });

  it("finds the Ad Creative folder in the client folder or one level down, never makes it", async () => {
    expect(isAdCreativeName("Ad Creative")).toBe(true);
    expect(isAdCreativeName("ad creatives")).toBe(true);
    expect(isAdCreativeName("Ads-Creative")).toBe(true);
    expect(isAdCreativeName("Ad Creative Old")).toBe(false);
    const direct = fakeDrive({ c: [{ id: "x", name: "Brand" }, { id: "ac", name: "Ad Creative" }] });
    expect(await locateAdCreative(direct.drive, "c")).toBe("ac");
    const nested = fakeDrive({ c: [{ id: "k", name: "Kaizen" }], k: [{ id: "ac2", name: "AD CREATIVE" }] });
    expect(await locateAdCreative(nested.drive, "c")).toBe("ac2");
    const none = fakeDrive({ c: [{ id: "k", name: "Kaizen" }] });
    expect(await locateAdCreative(none.drive, "c")).toBeNull();
    expect(none.calls.create).toBe(0);
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
  // The first layout: Ad Creative / 2026 / November / Promo / Images / the file
  const oldLayout = () => ({
    root: [{ id: "y", name: "2026" }],
    y: [{ id: "m", name: "November" }],
    m: [{ id: "c", name: "Promo" }],
    c: [{ id: "img", name: "Images" }, { id: "rep", name: "_Replaced" }],
  });
  const segments = ["Liquidating Seller", "Cash in a week", "2026-11 Promo"];

  it("moves a file into avatar / angle / concept, once, and leaves the old folders where they are", async () => {
    const f = fakeMoveDrive(oldLayout(), { f1: { parents: ["img"], name: "Acme - Promo - V1 - 4x5.png" } });
    const cache = memoryCache();
    const first = await relocateFile(f.drive, cache, "root", { fileId: "f1", segments, replaced: false, name: "Acme - Promo - V1 - 4x5.png" });
    expect(first.result).toBe("moved");
    expect(f.files.f1.parents).toEqual([first.folder]);
    expect(cache.map.get(segments.join("/"))).toBe(first.folder);
    expect(f.calls.move).toBe(1);
    expect(f.calls.rename).toBe(0);
    // The old Year / Month / Concept / Format folders are still there (nothing deleted)
    expect(f.children.get("root")!.map((x) => x.name)).toEqual(["2026", "Liquidating Seller"]);
    expect(f.children.get("c")!.map((x) => x.id)).toEqual(["img", "rep"]);
    // Running again moves nothing and makes nothing
    const again = await relocateFile(f.drive, cache, "root", { fileId: "f1", segments, replaced: false, name: "Acme - Promo - V1 - 4x5.png" });
    expect(again).toEqual({ result: "in_place", folder: first.folder });
    expect(f.calls.move).toBe(1);
    expect(f.base.calls.create).toBe(3);
  });

  it("puts a replaced file in _Replaced inside its new concept folder", async () => {
    const f = fakeMoveDrive(oldLayout(), { f2: { parents: ["rep"], name: "Acme - Promo - V2 - 9x16.mp4" } });
    const cache = memoryCache();
    const r = await relocateFile(f.drive, cache, "root", { fileId: "f2", segments, replaced: true });
    expect(r.result).toBe("moved");
    const concept = cache.map.get(segments.join("/"))!;
    expect(f.children.get(concept)).toEqual([{ id: r.folder, name: "_Replaced" }]);
    expect(f.files.f2.parents).toEqual([r.folder]);
    expect(f.files.f2.name).toBe("Acme - Promo - V2 - 9x16.mp4"); // no name given: kept
  });

  it("follows a ticket whose avatar or angle changed, renaming only when the concept did", async () => {
    const f = fakeMoveDrive(oldLayout(), { f3: { parents: ["img"], name: "Acme - Promo - V1 - 4x5.png" } });
    const cache = memoryCache();
    const a = await relocateFile(f.drive, cache, "root", { fileId: "f3", segments, replaced: false });
    const changed = ["_Avatar tests", "Weekend Warrior Dad", "_No angle", "2026-11 Promo"];
    const b = await relocateFile(f.drive, cache, "root", { fileId: "f3", segments: changed, replaced: false, name: "Acme - Promo - V1 - 4x5.png" });
    expect(b.result).toBe("moved");
    expect(b.folder).not.toBe(a.folder);
    expect(f.files.f3.parents).toEqual([b.folder]);
    // Same place, new title: renamed in place, not moved
    const c = await relocateFile(f.drive, cache, "root", { fileId: "f3", segments: changed, replaced: false, name: "Acme - Spring Promo - V1 - 4x5.png" });
    expect(c.result).toBe("renamed");
    expect(f.files.f3.name).toBe("Acme - Spring Promo - V1 - 4x5.png");
    expect(f.calls.move).toBe(2);
  });

  it("leaves a file deleted or trashed in Drive alone, making no folders for it", async () => {
    const f = fakeMoveDrive(oldLayout(), { t: { parents: ["img"], name: "x.png", trashed: true } });
    const cache = memoryCache();
    expect((await relocateFile(f.drive, cache, "root", { fileId: "t", segments, replaced: false })).result).toBe("gone");
    expect((await relocateFile(f.drive, cache, "root", { fileId: "missing", segments, replaced: false })).result).toBe("gone");
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
