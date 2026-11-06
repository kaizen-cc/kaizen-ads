// Where a ticket's creative goes in the client's Drive, and what each file is called. Pure: no Drive calls, no database,
// so the paths, the names and the idempotent folder logic are unit-tested with a fake Drive.
//
// Ad Creative / Liquidating Seller / Cash in a week / 2026-11 Summer Sale / Acme - Summer Sale - V2 - 4x5.png
//                                                                          Acme - Summer Sale - V1 - Slide 03 - 4x5.png
//                                                                          _Replaced / (files taken off the ticket)
// No avatar: "_Not tied to an avatar"; an avatar under test: "_Avatar tests / <avatar>"; no angle: "_No angle".
// Format and size live in the file name, not in folders.

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

export const NO_AVATAR = "_Not tied to an avatar";
export const AVATAR_TESTS = "_Avatar tests";
export const NO_ANGLE = "_No angle";

/** Year and month name in New York time, the agency's calendar (a ticket made late on the 31st is still that month). */
export function yearMonth(at: string | Date, timeZone = "America/New_York") {
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return { year, month: MONTHS[month - 1], key: `${year}-${String(month).padStart(2, "0")}` };
}

/** Bold markers and quotes the Bible or a brief may wrap a name in */
const unwrap = (s: string) => s.replace(/\*\*|__|[`"“”]/g, "").trim();

/**
 * An avatar's folder name: the Bible profile's name without its letter ("A · ", "B. ") or its confidence ("(Likely)"),
 * and without a description after a colon or a spaced dash. Null when nothing is left.
 */
export function avatarFolderName(avatar: string | null | undefined) {
  let s = unwrap((avatar ?? "").normalize("NFC")).replace(DASHES, " - ");
  s = s.replace(/^[A-Z0-9]{1,2}\s*[·.:)-]\s+/, "");
  s = s.split(/\s*:\s+|\s+-\s+/)[0];
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();
  }
  s = s.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const out = cleanName(s, 50);
  return out === "Untitled" ? null : out;
}

/** Words an angle's short name never ends on ("Cash in a week for" reads as "Cash in a week") */
const DANGLING = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "so", "the", "to", "via", "vs", "with", "your", "their", "our", "that", "who", "when"]);

/**
 * An angle's folder name, the same every time for the same angle: its first clause (up to a comma, period, colon,
 * semicolon, bracket or spaced dash), at most five words, no dangling "and"/"for" at the end, first letter capital.
 * Null when nothing is left.
 */
export function angleFolderName(angle: string | null | undefined) {
  const s = unwrap((angle ?? "").normalize("NFC")).replace(DASHES, " - ");
  const clause = s.split(/[,.;:!?()[\]\n]|\s+-\s+|\s+\/\s+/).map((c) => c.trim()).find(Boolean) ?? "";
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 5);
  while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  const joined = words.join(" ");
  const out = cleanName(joined.charAt(0).toUpperCase() + joined.slice(1), 50);
  return out === "Untitled" ? null : out;
}

/** The avatar's folders: its own, inside "_Avatar tests" when it's under test, or "_Not tied to an avatar" */
export function avatarSegments(avatar: string | null | undefined, test?: boolean | null) {
  const name = avatarFolderName(avatar);
  if (!name) return [NO_AVATAR];
  return test ? [AVATAR_TESTS, name] : [name];
}

/**
 * The concept folder: the ticket's title. Two tickets for the client in the same month with the same title would mix
 * their files, so the later one carries its number.
 */
export function conceptName(title: string | null | undefined, number: number | null, sameTitleEarlier: boolean) {
  const base = cleanName(title, 70);
  return sameTitleEarlier && number ? `${base} #${number}` : base;
}

/** The folders under Ad Creative, in order: avatar (or "_Avatar tests / avatar"), angle, "2026-11 Concept". */
export function folderSegments(p: { createdAt: string | Date; concept: string; avatar?: string | null; avatarTest?: boolean | null; angle?: string | null }) {
  return [...avatarSegments(p.avatar, p.avatarTest), angleFolderName(p.angle) ?? NO_ANGLE, `${yearMonth(p.createdAt).key} ${p.concept}`];
}

/** A Year or Year / Month folder from the first Ad Creative layout, left in place after its files moved */
export const isOldLayoutPath = (path: string) => {
  const [year, month, ...rest] = path.split("/");
  return /^\d{4}$/.test(year) && !rest.length && (month === undefined || MONTHS.includes(month));
};

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

/** What moving a file already in Drive needs on top of folders: where it is, and moving or renaming it (never a re-upload, never a delete) */
export type MoveDrive = FolderDrive & {
  /** Null when the file is gone from Drive */
  where(id: string): Promise<{ parents: string[]; name: string; trashed: boolean } | null>;
  move(id: string, to: string, from: string[], name?: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
};

/**
 * A file already in Drive, put where the layout says: its concept folder (made once, like an upload's), or the
 * "_Replaced" folder inside it when it was taken off the ticket. Moves only change the file's parents (and its name
 * when the concept was renamed); the old folders stay where they are.
 */
export async function relocateFile(
  drive: MoveDrive,
  cache: FolderCache,
  root: string,
  p: { fileId: string; segments: string[]; replaced: boolean; name?: string | null },
): Promise<{ result: "moved" | "in_place" | "renamed" | "gone"; folder: string | null }> {
  const at = await drive.where(p.fileId);
  if (!at || at.trashed) return { result: "gone", folder: null };
  const folder = await ensureFolderPath(drive, cache, root, p.replaced ? [...p.segments, REPLACED] : p.segments);
  const rename = p.name && p.name !== at.name ? p.name : undefined;
  if (at.parents.length === 1 && at.parents[0] === folder) {
    if (!rename) return { result: "in_place", folder };
    await drive.rename(p.fileId, rename);
    return { result: "renamed", folder };
  }
  await drive.move(p.fileId, folder, at.parents.filter((x) => x !== folder), rename);
  return { result: "moved", folder };
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
