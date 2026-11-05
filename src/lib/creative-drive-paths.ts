// Where a ticket's creative goes in the client's Drive, and what each file is called. Pure: no Drive calls, no database,
// so the paths, the names and the idempotent folder logic are unit-tested with a fake Drive.
//
// Ad Creative / 2026 / November / Summer Sale / Images / Acme - Summer Sale - V2 - 4x5.png
//                                               Carousels / Acme - Summer Sale - V1 - Slide 03 - 4x5.png

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const REPLACED = "_Replaced";

/** En and em dashes, written as code points so the source holds none */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, "g");

/** A name Drive and every computer it syncs to can hold: no slashes or reserved characters, one line, not too long. */
export function cleanName(s: string | null | undefined, max = 80) {
  const out = (s ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  if (!out) return "Untitled";
  if (out.length <= max) return out;
  return out.slice(0, max).replace(/\s+\S*$/, "").trim() || out.slice(0, max).trim();
}

export type CreativeFormat = "image" | "video" | "carousel";

/** Images, Videos or Carousels: the ticket's format, else what the file is. */
export function formatFolder(format: string | null | undefined, mime?: string | null) {
  if (format === "carousel") return "Carousels";
  if (format === "video") return "Videos";
  if (format === "image") return "Images";
  return mime?.startsWith("video/") ? "Videos" : "Images";
}

/** Year and month name in New York time, the agency's calendar (a ticket made late on the 31st is still that month). */
export function yearMonth(at: string | Date, timeZone = "America/New_York") {
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return { year, month: MONTHS[month - 1] };
}

/**
 * The concept folder: the ticket's title. Two tickets for the client in the same month with the same title would mix
 * their files, so the later one carries its number.
 */
export function conceptName(title: string | null | undefined, number: number | null, sameTitleEarlier: boolean) {
  const base = cleanName(title, 70);
  return sameTitleEarlier && number ? `${base} #${number}` : base;
}

/** The folders under Ad Creative, in order. */
export function folderSegments(p: { createdAt: string | Date; concept: string; format: string | null | undefined; mime?: string | null }) {
  const { year, month } = yearMonth(p.createdAt);
  return [year, month, p.concept, formatFolder(p.format, p.mime)];
}

/** A file's slot in its design: the same slot in the next round is the same Drive file (a new revision). */
export function slotOf(f: { card: number | null; aspect: string | null; original_name: string }) {
  if (f.card != null) return `card:${f.card}`;
  if (f.aspect) return `size:${f.aspect}`;
  return `file:${f.original_name.toLowerCase().replace(/^\d+-[0-9a-f]{4}-/, "")}`;
}

export function extOf(name: string, mime: string | null | undefined) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return (mime && byMime[mime]) || "bin";
}

/** "1x1" stays "1x1"; a pixel size "1200x628" stays as is; nothing → nothing. Drive names can't hold ":". */
const sizeLabel = (aspect: string | null) => (aspect ? (aspect === "191x100" ? "1.91x1" : aspect) : null);

/**
 * "<Client> - <Concept> - V2 - 4x5.png": V is the design's number on the ticket (D2 on the board), so a new round of
 * D2 keeps the same name and becomes a revision of the same file. Carousels add the slide: "... - V1 - Slide 03 - 4x5.png".
 */
export function driveFileName(p: { client: string; concept: string; position: number; card: number | null; aspect: string | null; originalName: string; mime: string | null }) {
  const parts = [cleanName(p.client, 60), p.concept, `V${p.position}`];
  if (p.card != null) parts.push(`Slide ${String(p.card).padStart(2, "0")}`);
  const size = sizeLabel(p.aspect);
  if (size) parts.push(size);
  else if (p.card == null) parts.push(cleanName(p.originalName.replace(/^\d+-[0-9a-f]{4}-/, "").replace(/\.[a-z0-9]{2,5}$/i, ""), 40));
  return `${parts.join(" - ")}.${extOf(p.originalName, p.mime)}`;
}

// ─── Folders, found or made once ───────────────────────────────────────────────────────────────────────────────────

/** The Drive calls the folder logic needs (the real one in creative-drive.ts, a fake in the tests). */
export type FolderDrive = {
  listFolders(parent: string): Promise<{ id: string; name: string }[]>;
  createFolder(parent: string, name: string): Promise<string>;
};

/** Folder ids already known (client_drive_folders). put returns the id that won when two runs raced. */
export type FolderCache = {
  get(path: string): Promise<string | null>;
  put(path: string, id: string): Promise<string>;
  forget(): Promise<void>;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One folder by name under a parent: the existing one (by name, any case), else a new one. */
export async function findOrCreateFolder(drive: FolderDrive, parent: string, name: string) {
  const hit = (await drive.listFolders(parent)).find((f) => sameName(f.name, name));
  return hit ? hit.id : drive.createFolder(parent, name);
}

/**
 * Year / month / concept / format under the Ad Creative folder, each found or made once: the cache first, then Drive by
 * name (someone may have made "November" by hand), then a new folder. Running it twice makes nothing twice.
 */
export async function ensureFolderPath(drive: FolderDrive, cache: FolderCache, root: string, segments: string[]) {
  let parent = root;
  for (let i = 0; i < segments.length; i++) {
    const path = segments.slice(0, i + 1).join("/");
    const known = await cache.get(path);
    if (known) {
      parent = known;
      continue;
    }
    const id = await findOrCreateFolder(drive, parent, segments[i]);
    parent = await cache.put(path, id);
  }
  return parent;
}

/** "Ad Creative", "Ad Creatives", "Ads Creative", "ad-creative": the folder every client has. */
export const isAdCreativeName = (name: string) => /^ads?[\s_-]*creatives?$/i.test(name.trim());

/**
 * The client's Ad Creative folder: a folder of that name in their client folder, or one level down (inside "Marketing"
 * or "Kaizen"). Never made: if it isn't there, the ticket says so and someone sets it on the client page.
 */
export async function locateAdCreative(drive: Pick<FolderDrive, "listFolders">, clientFolder: string) {
  const top = await drive.listFolders(clientFolder);
  const direct = top.find((f) => isAdCreativeName(f.name));
  if (direct) return direct.id;
  for (const f of top.slice(0, 30)) {
    const hit = (await drive.listFolders(f.id)).find((x) => isAdCreativeName(x.name));
    if (hit) return hit.id;
  }
  return null;
}

/** A folder ID from a pasted link ("…/folders/<id>", "…?id=<id>") or the bare ID. */
export const folderIdOf = (v: string) => v.match(/folders\/([\w-]{10,})/)?.[1] ?? v.match(/[?&]id=([\w-]{10,})/)?.[1] ?? v.trim();

// ─── Retries ────────────────────────────────────────────────────────────────────────────────────────────────────────

const BACKOFF_MIN = [1, 5, 30, 120, 360];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

/** When to try again after a failure, or null to stop and show the error. */
export function nextAttempt(attempts: number, now = Date.now()) {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000);
}

export type DriveErrorKind = "no_folder" | "no_access" | "too_large" | "other";

/** What a failure means for the person looking at the ticket. */
export function classifyDriveError(message: string): { kind: DriveErrorKind; text: string; retry: boolean } {
  const m = message.toLowerCase();
  if (m.includes("unauthorized_client") || m.includes("access_denied") || m.includes("insufficient") || m.includes("scope") || m.includes("invalid_grant"))
    return { kind: "no_access", text: "Drive access not allowed for the service account (an admin needs to allow the drive scope)", retry: false };
  if (m.includes("not connected")) return { kind: "no_access", text: "Drive isn't connected (GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_USER)", retry: false };
  if (m.includes("too large")) return { kind: "too_large", text: message, retry: false };
  return { kind: "other", text: message.slice(0, 300), retry: true };
}
