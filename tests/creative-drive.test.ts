import { describe, expect, it } from "vitest";
import {
  classifyDriveError,
  cleanName,
  conceptName,
  driveFileName,
  ensureFolderPath,
  folderIdOf,
  folderSegments,
  formatFolder,
  isAdCreativeName,
  locateAdCreative,
  MAX_ATTEMPTS,
  nextAttempt,
  slotOf,
  yearMonth,
  type FolderCache,
  type FolderDrive,
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

  it("puts each format in its folder", () => {
    expect(formatFolder("image")).toBe("Images");
    expect(formatFolder("video")).toBe("Videos");
    expect(formatFolder("carousel")).toBe("Carousels");
    expect(formatFolder(null, "video/mp4")).toBe("Videos");
  });

  it("dates by New York month", () => {
    // 2am UTC on Dec 1 is still Nov 30 in New York
    expect(yearMonth("2026-12-01T02:00:00Z")).toEqual({ year: "2026", month: "November" });
    expect(folderSegments({ createdAt: "2027-01-15T15:00:00Z", concept: "Promo", format: "carousel" })).toEqual(["2027", "January", "Promo", "Carousels"]);
  });

  it("gives each size and slide a stable slot (the next round is the same Drive file)", () => {
    expect(slotOf({ card: 2, aspect: "4x5", original_name: "a.png" })).toBe("card:2");
    expect(slotOf({ card: null, aspect: "9x16", original_name: "a.png" })).toBe("size:9x16");
    expect(slotOf({ card: null, aspect: null, original_name: "01-ab12-Hero.mov" })).toBe(slotOf({ card: null, aspect: null, original_name: "03-ff00-hero.mov" }));
  });
});

describe("folders", () => {
  it("makes year, month, concept and format once, then reuses them", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const segs = ["2026", "November", "Summer Sale", "Images"];
    const a = await ensureFolderPath(drive, cache, "root", segs);
    expect(calls.create).toBe(4);
    const b = await ensureFolderPath(drive, cache, "root", segs);
    expect(b).toBe(a);
    expect(calls.create).toBe(4); // nothing made twice
    // A sibling concept reuses year and month
    await ensureFolderPath(drive, cache, "root", ["2026", "November", "Black Friday", "Videos"]);
    expect(calls.create).toBe(6);
  });

  it("uses folders someone already made by hand (any case), without the cache", async () => {
    const { drive, calls } = fakeDrive({ root: [{ id: "y", name: "2026" }], y: [{ id: "m", name: "november" }] });
    const cache = memoryCache();
    await ensureFolderPath(drive, cache, "root", ["2026", "November", "Promo", "Images"]);
    expect(calls.create).toBe(2);
    expect(cache.map.get("2026")).toBe("y");
    expect(cache.map.get("2026/November")).toBe("m");
  });

  it("makes nothing twice after the cache is forgotten (found by name again)", async () => {
    const { drive, calls } = fakeDrive();
    const cache = memoryCache();
    const segs = ["2026", "November", "Promo", "Images"];
    const first = await ensureFolderPath(drive, cache, "root", segs);
    await cache.forget();
    expect(await ensureFolderPath(drive, cache, "root", segs)).toBe(first);
    expect(calls.create).toBe(4);
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
