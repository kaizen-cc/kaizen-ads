// Where a ticket's creative goes in the client's Drive, and what each file is called. Pure: no Drive calls, no database,
// so the paths, the names and the idempotent folder logic are unit-tested with a fake Drive.
//
// Ad Creatives / 2026 / 11 - November / #1234 Best Seat Hack / Acme_Best_Seat_Hack_V2_4x5.png
//                                                               Acme_Best_Seat_Hack_V1_Slide03_4x5.png
//                                                               _Replaced / (files taken off the ticket)
// The year and month folders follow the naming the client's folder already uses ("November", "11. Nov", "2026-11");
// "2026" / "11 - November" when there's none yet. The month is the ticket's (when it was made, New York time), so every
// round of a ticket lands in the same folder. One folder per ticket, named by its number and title; format and size
// live in the file name, which follows the brief's file naming.

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const REPLACED = "_Replaced";
/** The folder made in the client's Drive folder when they have none */
export const AD_CREATIVES = "Ad Creatives";
/** The start of the ticket's message when the client has no Drive folder at all (the file stays in Kaizen Ads) */
export const NO_DRIVE = "Drive isn't connected for this client";

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

/** Year and month in New York time, the agency's calendar (a ticket made late on the 31st is still that month). */
export function yearMonth(at: string | Date, timeZone = "America/New_York") {
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")!.value;
  const num = Number(parts.find((p) => p.type === "month")!.value);
  return { year, num, month: MONTHS[num - 1], key: `${year}-${String(num).padStart(2, "0")}` };
}

// ─── Year and month folders, named the way the client's folder already names them ─────────────────────────────────

/** "2026", "FY2026", "Year 2026": the year, else null */
export function parseYearFolder(name: string) {
  const m = /^(?:fy|year)?[\s_-]*(20\d{2})[\s_-]*$/i.exec(name.normalize("NFC").trim());
  return m ? Number(m[1]) : null;
}

/** A new year folder named like the ones already there ("FY2025" makes "FY2026"), else just the year */
export function yearFolderName(year: string, siblings: string[]) {
  const like = siblings.find((s) => parseYearFolder(s) != null);
  return like ? cleanName(like.trim().replace(/20\d{2}/, year)) : year;
}

/** How a client names month folders: "{NUM} - {NAME}" with the number padded, the name full or short, its case */
export type MonthStyle = { template: string; pad: boolean | null; abbr: boolean; case: "title" | "upper" | "lower" };
export const DEFAULT_MONTH_STYLE: MonthStyle = { template: "{NUM} - {NAME}", pad: true, abbr: false, case: "title" };

const MONTH_WORD = /(?<![a-z])(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)(?![a-z])/i;

/**
 * A month folder's month and naming: "11 - November", "November", "11. Nov", "2026-11", "11". Null when it isn't
 * one: anything besides the month, its number, the year and separators ("11 Promo ideas") isn't a month folder.
 */
export function parseMonthFolder(raw: string): { month: number; style: MonthStyle } | null {
  const name = raw.normalize("NFC").trim();
  if (!name || name.length > 30) return null;
  let t = name;
  let month: number | null = null;
  let abbr = false;
  let kase: MonthStyle["case"] = "title";
  const w = MONTH_WORD.exec(t);
  if (w) {
    const word = w[1];
    const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(word.toLowerCase().slice(0, 3)));
    month = i + 1;
    abbr = word.toLowerCase() !== MONTHS[i].toLowerCase();
    kase = word.length > 1 && word === word.toUpperCase() ? "upper" : word === word.toLowerCase() ? "lower" : "title";
    t = `${t.slice(0, w.index)}{NAME}${t.slice(w.index + word.length)}`;
  }
  t = t.replace(/(?<!\d)20\d{2}(?!\d)/, "{YEAR}");
  // "November 01 2026": the 01 is the day, written the same in every folder, not the month's number
  let day: string | null = null;
  if (month) {
    const d = /(?<=\{NAME\}\s*)(0?1)(?=\s*\{YEAR\})/.exec(t);
    if (d) {
      day = d[1];
      t = `${t.slice(0, d.index)}{DAY}${t.slice(d.index + d[1].length)}`;
    }
  }
  let pad: boolean | null = null;
  const n = /(?<!\d)(\d{1,2})(?!\d)/.exec(t);
  if (n) {
    const v = Number(n[1]);
    if (v < 1 || v > 12 || (month && month !== v)) return null;
    month = v;
    pad = n[1].length === 2 ? true : v < 10 ? false : null;
    t = `${t.slice(0, n.index)}{NUM}${t.slice(n.index + n[1].length)}`;
  }
  if (!month) return null;
  if (/[\p{L}\p{N}]/u.test(t.replace(/\{(?:NAME|NUM|YEAR|DAY)\}/g, ""))) return null;
  if (day) t = t.replace("{DAY}", day);
  return { month, style: { template: t, pad, abbr, case: kase } };
}

/** The naming most of these month folders share (padding taken from any that shows it), or null when none is a month */
export function monthStyleOf(names: string[]): MonthStyle | null {
  const groups = new Map<string, MonthStyle[]>();
  for (const n of names) {
    const p = parseMonthFolder(n);
    if (!p) continue;
    const k = `${p.style.template}|${p.style.abbr}|${p.style.case}`;
    groups.set(k, [...(groups.get(k) ?? []), p.style]);
  }
  let best: MonthStyle[] | null = null;
  for (const g of groups.values()) if (!best || g.length > best.length) best = g;
  if (!best) return null;
  const pad = best.find((s) => s.pad != null)?.pad ?? true;
  return { ...best[0], pad };
}

/** A month folder's name in a style: "11 - November", "Nov", "2026-11" */
export function monthFolderName(month: number, year: string, style: MonthStyle = DEFAULT_MONTH_STYLE) {
  const full = MONTHS[month - 1];
  const word = style.abbr ? full.slice(0, 3) : full;
  const cased = style.case === "upper" ? word.toUpperCase() : style.case === "lower" ? word.toLowerCase() : word;
  const num = style.pad === false ? String(month) : String(month).padStart(2, "0");
  return cleanName(style.template.replace("{NAME}", cased).replace("{NUM}", num).replace("{YEAR}", year));
}

// ─── The ticket's folder ──────────────────────────────────────────────────────────────────────────────────────────

/** "#1234 Best Seat Hack": the ticket's number and a short title */
export function ticketFolderName(number: number, title: string | null | undefined) {
  const t = (title ?? "").trim();
  return t ? cleanName(`#${number} ${cleanName(t, 50)}`) : `#${number}`;
}

/** The ticket's folder by its number ("#1234 ...", "1234 - ..."), whatever its title was when it was made */
export const isTicketFolder = (name: string, number: number) => new RegExp(`^#?\\s*${number}(?!\\d)`).test(name.trim());

/** The ticket folder's place in the cache and on the row (drive_path): "2026/11/#1234", stable whatever the names are */
export function ticketPath(createdAt: string | Date, number: number) {
  const ym = yearMonth(createdAt);
  return `${ym.year}/${String(ym.num).padStart(2, "0")}/#${number}`;
}

/** A top-level folder of an earlier layout (avatar folders, "_Not tied to an avatar"), left in place after its files moved */
export const isOldLayoutPath = (path: string) => !path.includes("/") && !/^\d{4}$/.test(path);

// ─── File names ───────────────────────────────────────────────────────────────────────────────────────────────────

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

/** The brief's file name stem, "Acme_Best_Seat_Hack" (the same formula as the brief's specs checklist) */
export const briefFileStem = (client: string, title: string) =>
  `${client}_${title}`.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Client_Concept";

/**
 * The brief's file naming: "Acme_Best_Seat_Hack_V2_4x5.png". V is the design's number on the ticket (D2 on the board),
 * so a new round of D2 keeps the same name and becomes a revision of the same file. Carousels add the slide:
 * "..._V1_Slide03_4x5.png". No size known: the uploaded file's own name tells files apart.
 */
export function driveFileName(p: { client: string; title: string; position: number; card: number | null; aspect: string | null; originalName: string; mime: string | null }) {
  const parts = [briefFileStem(p.client, p.title), `V${p.position}`];
  if (p.card != null) parts.push(`Slide${String(p.card).padStart(2, "0")}`);
  const size = sizeLabel(p.aspect);
  if (size) parts.push(size);
  else if (p.card == null)
    parts.push(
      p.originalName
        .replace(/^\d+-[0-9a-f]{4}-/, "")
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[^\w]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "file",
    );
  return `${parts.join("_")}.${extOf(p.originalName, p.mime)}`;
}

// ─── Folders, found or made once ───────────────────────────────────────────────────────────────────────────────────

/** The Drive calls the folder logic needs (the real one in creative-drive.ts, a fake in the tests). */
export type FolderDrive = {
  /** Oldest first */
  listFolders(parent: string): Promise<{ id: string; name: string }[]>;
  createFolder(parent: string, name: string): Promise<string>;
  /** An empty folder this run made that lost a race to another run's: to the Drive trash */
  trashFolder?(id: string): Promise<void>;
};

/** Folder ids already known (client_drive_folders). put returns the id that won when two runs raced. */
export type FolderCache = {
  get(path: string): Promise<string | null>;
  put(path: string, id: string): Promise<string>;
  forget(): Promise<void>;
};

/**
 * One folder level: its key in the cache, which existing folder counts as it ("November" for the month), and the name
 * a new one gets (it can look at the folders already there, to name it like them).
 */
export type FolderStep = { key: string; match: (name: string) => boolean; name: (siblings: { id: string; name: string }[]) => string | Promise<string> };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const exact = (name: string): FolderStep => ({ key: name, match: (n) => sameName(n, name), name: () => name });
const toStep = (s: FolderStep | string) => (typeof s === "string" ? exact(s) : s);

/**
 * One folder under a parent: the existing one, else a new one. Two uploads racing can each make one: after making it,
 * the oldest match wins and a losing new folder (empty) goes to the trash, so there's never a duplicate.
 */
export async function findOrCreateFolder(drive: FolderDrive, parent: string, step: FolderStep | string): Promise<{ id: string; created: boolean }> {
  const s = toStep(step);
  const siblings = await drive.listFolders(parent);
  const hit = siblings.find((f) => s.match(f.name));
  if (hit) return { id: hit.id, created: false };
  const id = await drive.createFolder(parent, await s.name(siblings));
  const winner = (await drive.listFolders(parent)).find((f) => s.match(f.name))?.id ?? id;
  if (winner !== id) {
    await drive.trashFolder?.(id);
    return { id: winner, created: false };
  }
  return { id, created: true };
}

/**
 * Folder levels under the Ad Creatives folder, each found or made once: the cache first, then Drive (someone may
 * have made "November" by hand), then a new folder. Running it twice, or two runs at once, makes nothing twice.
 */
export async function ensureFolderPath(drive: FolderDrive, cache: FolderCache, root: string, steps: (FolderStep | string)[]) {
  let parent = root;
  const keys: string[] = [];
  for (const raw of steps) {
    const step = toStep(raw);
    keys.push(step.key);
    const path = keys.join("/");
    const known = await cache.get(path);
    if (known) {
      parent = known;
      continue;
    }
    const { id, created } = await findOrCreateFolder(drive, parent, step);
    const won = await cache.put(path, id);
    if (won !== id && created) await drive.trashFolder?.(id);
    parent = won;
  }
  return parent;
}

/**
 * Year / month / ticket under the Ad Creatives folder. A new year or month folder is named like the ones already there
 * (this year's months, else the latest other year's), "2026" / "11 - November" when there are none.
 */
export function ticketSteps(drive: Pick<FolderDrive, "listFolders">, root: string, p: { createdAt: string | Date; number: number; title: string | null }): FolderStep[] {
  const ym = yearMonth(p.createdAt);
  const otherYears = async () => {
    const years = (await drive.listFolders(root))
      .map((f) => ({ ...f, year: parseYearFolder(f.name) }))
      .filter((f) => f.year != null && String(f.year) !== ym.year)
      .sort((a, b) => b.year! - a.year!);
    for (const y of years.slice(0, 2)) {
      const style = monthStyleOf((await drive.listFolders(y.id)).map((f) => f.name));
      if (style) return style;
    }
    return null;
  };
  return [
    { key: ym.year, match: (n) => parseYearFolder(n) === Number(ym.year), name: (sib) => yearFolderName(ym.year, sib.map((s) => s.name)) },
    {
      key: String(ym.num).padStart(2, "0"),
      match: (n) => parseMonthFolder(n)?.month === ym.num,
      name: async (sib) => monthFolderName(ym.num, ym.year, monthStyleOf(sib.map((s) => s.name)) ?? (await otherYears()) ?? DEFAULT_MONTH_STYLE),
    },
    { key: `#${p.number}`, match: (n) => isTicketFolder(n, p.number), name: () => ticketFolderName(p.number, p.title) },
  ];
}

/** What moving a file already in Drive needs on top of folders: where it is, and moving or renaming it (never a re-upload, never a delete) */
export type MoveDrive = FolderDrive & {
  /** Null when the file is gone from Drive */
  where(id: string): Promise<{ parents: string[]; name: string; trashed: boolean } | null>;
  move(id: string, to: string, from: string[], name?: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
};

/**
 * A file already in Drive, put where the layout says: its ticket folder (made once, like an upload's), or the
 * "_Replaced" folder inside it when it was taken off the ticket. Moves only change the file's parents (and its name
 * when the title changed); the old folders stay where they are.
 */
export async function relocateFile(
  drive: MoveDrive,
  cache: FolderCache,
  root: string,
  p: { fileId: string; steps: (FolderStep | string)[]; replaced: boolean; name?: string | null },
): Promise<{ result: "moved" | "in_place" | "renamed" | "gone"; folder: string | null }> {
  const at = await drive.where(p.fileId);
  if (!at || at.trashed) return { result: "gone", folder: null };
  const folder = await ensureFolderPath(drive, cache, root, p.replaced ? [...p.steps, REPLACED] : p.steps);
  const rename = p.name && p.name !== at.name ? p.name : undefined;
  if (at.parents.length === 1 && at.parents[0] === folder) {
    if (!rename) return { result: "in_place", folder };
    await drive.rename(p.fileId, rename);
    return { result: "renamed", folder };
  }
  await drive.move(p.fileId, folder, at.parents.filter((x) => x !== folder), rename);
  return { result: "moved", folder };
}

// ─── The client's Ad Creatives folder ─────────────────────────────────────────────────────────────────────────────

const AD_CREATIVE_WORDS = /(^|[^a-z])ads?[\s_-]*creatives?([^a-z]|$)/i;
const NOT_IN_USE = /\b(old|archived?|backups?|copy|unused)\b/i;

/** "Ad Creatives", "20 - Ad Creatives", "Ad Creative", "ads-creative": the folder every client has (not an old copy) */
export const isAdCreativeName = (name: string) => AD_CREATIVE_WORDS.test(name) && !NOT_IN_USE.test(name);

/** Exactly "Ad Creatives" once its numbering ("20 - ") is set aside: preferred over a longer name that mentions it */
const isPlainAdCreative = (name: string) => /^ads?[\s_-]*creatives?$/i.test(name.trim().replace(/^[\d.\s_-]+/, ""));

const pick = (folders: { id: string; name: string }[]) => {
  const hits = folders.filter((f) => isAdCreativeName(f.name));
  return (hits.find((f) => isPlainAdCreative(f.name)) ?? hits[0])?.id ?? null;
};

/** The client's Ad Creatives folder: in their client folder first, else one level down (inside "Marketing" or "Kaizen"). */
export async function locateAdCreative(drive: Pick<FolderDrive, "listFolders">, clientFolder: string) {
  const top = await drive.listFolders(clientFolder);
  const direct = pick(top);
  if (direct) return direct;
  for (const f of top.slice(0, 30)) {
    const hit = pick(await drive.listFolders(f.id));
    if (hit) return hit;
  }
  return null;
}

/** The Ad Creatives folder, or a new "Ad Creatives" in the client's folder when there's none (made once, even racing) */
export async function ensureAdCreative(drive: FolderDrive, clientFolder: string): Promise<{ id: string; made: boolean }> {
  const found = await locateAdCreative(drive, clientFolder);
  if (found) return { id: found, made: false };
  const r = await findOrCreateFolder(drive, clientFolder, { key: AD_CREATIVES, match: isAdCreativeName, name: () => AD_CREATIVES });
  return { id: r.id, made: r.created };
}

/**
 * Where a client's uploads go before any Drive call: the Ad Creatives folder set by hand or found earlier, else look
 * in (or make it in) their Drive folder, else nowhere: Drive isn't connected for them, the file stays in Kaizen Ads.
 */
export function rootPlan(c: { ad_creative_folder_id?: string | null; drive_folder_id?: string | null } | null): { use: string } | { lookIn: string } | { noDrive: true } {
  if (c?.ad_creative_folder_id) return { use: c.ad_creative_folder_id };
  if (c?.drive_folder_id) return { lookIn: c.drive_folder_id };
  return { noDrive: true };
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

// ─── Reports ──────────────────────────────────────────────────────────────────────────────────────────────────────
//
// <client folder> / 30 - Reports / 2026 / November 01 2026 / OceanBox - Meta report - Nov 6 - Nov 12.pdf
// The month is the one we're in when the report is saved (New York time), not the report's period.

/** Made in the client's Drive folder when there's no reports folder yet */
export const REPORTS_FOLDER = "30 - Reports";
/** Month folders of the reports folders: "November 01 2026" */
export const REPORT_MONTH_STYLE: MonthStyle = { template: "{NAME} 01 {YEAR}", pad: true, abbr: false, case: "title" };

/** "30 - Reports", "Reports": the client's reports folder (not an old copy) */
export const isReportsFolder = (name: string) => /reports/i.test(name) && !NOT_IN_USE.test(name);

/** The reports folder's year and month levels for when a report is saved: found, else made like their siblings */
export function reportSteps(at: string | Date): FolderStep[] {
  const ym = yearMonth(at);
  return [
    { key: ym.year, match: (n) => parseYearFolder(n) === Number(ym.year), name: (sib) => yearFolderName(ym.year, sib.map((s) => s.name)) },
    {
      key: String(ym.num).padStart(2, "0"),
      match: (n) => parseMonthFolder(n)?.month === ym.num,
      name: (sib) => monthFolderName(ym.num, ym.year, monthStyleOf(sib.map((s) => s.name)) ?? REPORT_MONTH_STYLE),
    },
  ];
}

/**
 * The folder a report is saved in, each level found or made once: the client's reports folder, the year, the month.
 * Nothing is ever deleted or moved.
 */
export async function ensureReportFolder(drive: FolderDrive, clientFolder: string, at: string | Date): Promise<string> {
  let parent = (await findOrCreateFolder(drive, clientFolder, { key: REPORTS_FOLDER, match: isReportsFolder, name: () => REPORTS_FOLDER })).id;
  for (const step of reportSteps(at)) parent = (await findOrCreateFolder(drive, parent, step)).id;
  return parent;
}
