import { Inflate } from "fflate";
import { parseManifest, type Manifest } from "./claude-export-manifest";
import { accountOf, creatorOf, parseUsers } from "./claude-import";

// The person's Claude export, read in their browser: one ZIP or several (the older export is one ZIP; the newer one
// comes in parts, its chats split across conversations-000.zip, -001.zip and so on, who's who in the light_metadata
// part), or loose JSON files from inside them. Each ZIP's directory is read first, then only the JSON (or JSON Lines)
// files whose names mention conversations, users or projects (at any folder depth) are streamed out of it, who's who
// before anything else; what each holds is told by its content, not its name, and everything is merged across files
// with each chat kept once. A big file (an organization's chats can be over a gigabyte) is never held whole: it's
// split into its chats as it streams and, once we know which account is the person's, only their own are kept.
// Nothing is uploaded until they pick what to import, and from an organization's export only their own chats ever are.

/** The biggest export file we read (each ZIP, or each JSON on its own); what's in it is streamed, never held whole */
export const MAX_FILE_BYTES = 4_000_000_000;
/** A JSON bigger than this is read one item at a time as it streams, instead of whole */
export const STREAM_OVER_BYTES = 50_000_000;
/** The biggest JSON read whole (V8's string limit is about 512 MB); only small ones are, bigger ones stream */
export const MAX_JSON_BYTES = 480_000_000;
/** Manifests are a few KB: a JSON this small is checked for being one before it's read as data */
export const MAX_MANIFEST_BYTES = 2_000_000;

export type ExportFiles = { conversations: unknown[]; projects: unknown[]; users: unknown[] | null };
export type FileSummary = { name: string; chats: number; people: number; projects: number };
/** Other people's chats and projects left out while reading (never parsed or kept), and whose they were */
export type Skipped = { chats: number; projects: number; accounts: string[] };
export type ExportRead = ExportFiles & { files: FileSummary[]; skipped: Skipped };
/** Bytes read so far: of the file being read (its ZIP's compressed bytes), and of everything */
export type ReadProgress = { file: string; fileDone: number; fileTotal: number; done: number; total: number };
export type ReadOptions = {
  /** Their Kaizen email: an organization's export is narrowed to their own chats while it's read */
  email?: string;
  onProgress?: (p: ReadProgress) => void;
  /** JSON bigger than this streams (tests lower it) */
  streamOver?: number;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** A file inside a ZIP worth reading: JSON or JSON Lines whose name mentions conversations, users or projects */
export function isWantedEntry(path: string) {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (!/\.(json|jsonl|ndjson)$/.test(name)) return false;
  if (/memor|design/.test(name)) return false;
  return /conversation|users|members|accounts|projects/.test(name);
}

/** JSON, or JSON Lines (one object per line) */
export function parseJsonOrLines(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try {
      if (lines.length > 1) return lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      // Not JSON Lines either
    }
    throw new Error(`${name} isn't readable JSON. Download that file again.`);
  }
}

const KEYS = ["conversations", "users", "members", "accounts", "projects", "data", "items", "results"];

function objectsIn(raw: unknown): Obj[] {
  if (Array.isArray(raw)) return raw.map(obj).filter((o): o is Obj => Boolean(o));
  const o = obj(raw);
  if (!o) return [];
  const out: Obj[] = [];
  for (const k of KEYS) if (Array.isArray(o[k])) out.push(...objectsIn(o[k]));
  // One object on its own (a single conversation or user)
  return out.length ? out : [o];
}

/** What a parsed file holds, told by content: chats have chat_messages, projects docs or a prompt_template, people an email */
export function classifyExportJson(raw: unknown): ExportFiles {
  const out: ExportFiles = { conversations: [], projects: [], users: [] };
  for (const o of objectsIn(raw)) {
    if (Array.isArray(o.chat_messages) || (Array.isArray(o.messages) && (o.uuid || o.id))) out.conversations.push(o);
    else if (Array.isArray(o.docs) || typeof o.prompt_template === "string") out.projects.push(o);
    else if (typeof o.email_address === "string" || (typeof o.email === "string" && (o.uuid || o.id))) out.users!.push(o);
  }
  return out;
}

const idOf = (o: unknown) => {
  const x = obj(o);
  return x ? String(x.uuid ?? x.id ?? "") : "";
};
const messagesIn = (o: unknown) => {
  const x = obj(o);
  return x ? ((Array.isArray(x.chat_messages) ? x.chat_messages : Array.isArray(x.messages) ? x.messages : []) as unknown[]).length : 0;
};

/** Everything found, merged across files and parts: each chat, project and person once (the fullest copy of a chat) */
export function mergeExport(parts: ExportFiles[]): ExportFiles {
  const convs = new Map<string, unknown>();
  const loose: unknown[] = [];
  for (const p of parts)
    for (const c of p.conversations) {
      const id = idOf(c);
      if (!id) loose.push(c);
      else if (!convs.has(id) || messagesIn(c) > messagesIn(convs.get(id))) convs.set(id, c);
    }
  const once = (list: unknown[]) => {
    const seen = new Map<string, unknown>();
    const rest: unknown[] = [];
    for (const x of list) {
      const id = idOf(x);
      if (!id) rest.push(x);
      else if (!seen.has(id)) seen.set(id, x);
    }
    return [...seen.values(), ...rest];
  };
  const users = parts.flatMap((p) => p.users ?? []);
  return { conversations: [...convs.values(), ...loose], projects: once(parts.flatMap((p) => p.projects)), users: users.length ? once(users) : null };
}

/** The manifest, when this small JSON is Claude's export manifest */
export async function readManifest(file: File): Promise<Manifest | null> {
  if (!/\.json$/i.test(file.name) || file.size > MAX_MANIFEST_BYTES) return null;
  try {
    return parseManifest(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

// ---- Streaming JSON: the items of a big file, one at a time ----

const WRAPPER_KEYS = new Set(KEYS);
const QUOTE_OR_BACKSLASH = /["\\]/g;

/**
 * Splits JSON arriving in byte chunks into its items, without ever holding the whole text: the elements of a top-level
 * array ([{...}, {...}]), of the first wrapper array in a top-level object ({"conversations": [...]}; any of the
 * wrapper keys, the rest of the wrapper is skipped), or each top-level object in turn (JSON Lines; a lone object that
 * isn't a wrapper comes out whole). It tracks nesting, strings and escapes, and decodes UTF-8 across chunk edges, so a
 * brace or quote inside a message never confuses it. Each item's text goes to onItem as soon as it closes.
 */
export class JsonItemSplitter {
  private readonly decoder = new TextDecoder();
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Items open at this depth (1 in a top-level array, 2 in a wrapper's array); -1 when not in such an array */
  private itemDepth = -1;
  private topObject = false;
  /** The depth the item being captured opened at, or -1 */
  private capture = -1;
  private parts: string[] = [];
  /** The last key read directly inside a top-level object (to spot a wrapper's array) */
  private key = "";
  private readingKey = false;

  constructor(private readonly onItem: (text: string) => void) {}

  push(bytes: Uint8Array) {
    this.scan(this.decoder.decode(bytes, { stream: true }));
  }

  /** The end of the input: throws when it stopped partway through */
  end() {
    this.scan(this.decoder.decode());
    if (this.depth !== 0 || this.inString) throw new Error("The JSON ends partway through.");
  }

  private scan(s: string) {
    const n = s.length;
    let start = this.capture >= 0 ? 0 : -1;
    let i = 0;
    if (this.escaped && n) {
      // The character after a backslash at the end of the last chunk
      this.escaped = false;
      i = 1;
    }
    while (i < n) {
      if (this.inString) {
        QUOTE_OR_BACKSLASH.lastIndex = i;
        const m = QUOTE_OR_BACKSLASH.exec(s);
        const j = m ? m.index : n;
        if (this.readingKey && this.key.length < 64) this.key += s.slice(i, Math.min(j, i + 64));
        if (!m) break;
        if (s.charCodeAt(j) === 92) {
          if (j + 1 >= n) {
            this.escaped = true;
            break;
          }
          i = j + 2;
          continue;
        }
        this.inString = false;
        this.readingKey = false;
        i = j + 1;
        continue;
      }
      const c = s.charCodeAt(i);
      if (c === 34) {
        this.inString = true;
        this.readingKey = this.topObject && this.depth === 1;
        if (this.readingKey) this.key = "";
      } else if (c === 123 || c === 91) {
        if (this.depth === 0) {
          if (c === 123) {
            this.topObject = true;
            this.capture = 0;
            start = i;
          } else this.itemDepth = 1;
        } else if (c === 91 && this.topObject && this.depth === 1 && this.itemDepth < 0 && WRAPPER_KEYS.has(this.key)) {
          // A wrapper: its array's items come out one by one, the wrapper itself isn't kept
          this.capture = -1;
          start = -1;
          this.parts = [];
          this.itemDepth = 2;
        } else if (this.capture < 0 && this.depth === this.itemDepth) {
          this.capture = this.depth;
          start = i;
        }
        this.depth++;
      } else if (c === 125 || c === 93) {
        this.depth--;
        if (this.depth < 0) throw new Error("The JSON has an extra closing bracket.");
        if (this.capture >= 0 && this.depth === this.capture) {
          this.parts.push(s.slice(start, i + 1));
          const text = this.parts.length === 1 ? this.parts[0] : this.parts.join("");
          this.parts = [];
          this.capture = -1;
          start = -1;
          this.onItem(text);
        }
        if (this.depth === this.itemDepth - 1) this.itemDepth = -1;
        if (this.depth === 0) this.topObject = false;
      }
      i++;
    }
    if (this.capture >= 0) this.parts.push(s.slice(start));
  }
}

// ---- Whose chats: an organization's export is narrowed to the person's own while it's read ----

const CHAT_HINT = /"(?:chat_messages|messages)"\s*:/;
const PROJECT_HINT = /"(?:docs|prompt_template)"\s*:/;
const ID_RE = /"(?:uuid|id)"\s*:\s*"([^"\\]{1,200})"/;
const ACCOUNT_RE = /"account"\s*:\s*\{\s*"uuid"\s*:\s*"([^"\\]{1,200})"|"account_uuid"\s*:\s*"([^"\\]{1,200})"/;

class StopReading extends Error {}

/**
 * Decides, once who's who is read, which chats are kept: with no email given, or no list of members (or just one),
 * everything (as before; ownChats sorts it out after). With several members, only the chats whose account is the
 * member with the person's email; other people's are counted but never parsed or kept (a cheap look at the text
 * first: no mention of the person's account, not theirs). Members listed but not the person: no chats are read at all.
 * With no members list and chats from a second account turning up, it stops: that export can't be narrowed.
 */
class OwnerGate {
  private readonly emails = new Map<string, string>();
  private mode: "all" | "mine" | "none" = "all";
  me = "";
  /** Accounts of the chats kept while keeping everything */
  private readonly accounts = new Set<string>();
  private readonly skippedIds = new Set<string>();
  private skippedLoose = 0;
  private skippedProjects = 0;
  private readonly skippedAccounts = new Set<string>();
  canStop = false;
  stopped = false;

  constructor(private readonly email: string | null) {}

  /** Called before each file that isn't who's who: settles whose chats to keep from what's been read so far */
  decide() {
    if (this.email === null || this.emails.size <= 1) return;
    const mine = this.email.trim().toLowerCase();
    this.me = [...this.emails].find(([, e]) => mine && e === mine)?.[0] ?? "";
    this.mode = this.me ? "mine" : "none";
  }

  get readsChats() {
    return this.mode !== "none" && !this.stopped;
  }

  private skipChat(id: string, account: string | null) {
    if (id) this.skippedIds.add(id);
    else this.skippedLoose++;
    if (account && account !== this.me) this.skippedAccounts.add(account);
  }

  /** A cheap look at an item before it's parsed: false leaves it out unparsed (someone else's chat or project) */
  wants(text: string): boolean {
    if (this.mode === "all" || text.includes(this.me)) return true;
    if (CHAT_HINT.test(text)) {
      if (this.mode === "mine") {
        const a = ACCOUNT_RE.exec(text);
        this.skipChat(ID_RE.exec(text)?.[1] ?? "", a ? (a[1] ?? a[2] ?? null) : null);
      }
      return false;
    }
    if (PROJECT_HINT.test(text)) {
      if (this.mode === "mine") this.skippedProjects++;
      return false;
    }
    // A person, or something else small: parsed
    return true;
  }

  /** What's kept of a parsed item or file */
  keep(found: ExportFiles): ExportFiles {
    for (const u of parseUsers(found.users ?? [])) if (!this.emails.has(u.uuid)) this.emails.set(u.uuid, u.email);
    if (this.mode === "none") return { ...found, conversations: [], projects: [] };
    if (this.mode === "mine") {
      const conversations = found.conversations.filter((c) => {
        if (accountOf(c) === this.me) return true;
        this.skipChat(idOf(c), accountOf(c));
        return false;
      });
      const projects = found.projects.filter((p) => creatorOf(p) === this.me);
      this.skippedProjects += found.projects.length - projects.length;
      return { ...found, conversations, projects };
    }
    for (const c of found.conversations) {
      const a = accountOf(c);
      if (a) this.accounts.add(a);
    }
    if (this.canStop && this.emails.size === 0 && this.accounts.size > 1) this.stopped = true;
    return found;
  }

  skipped(): Skipped {
    return { chats: this.skippedIds.size + this.skippedLoose, projects: this.skippedProjects, accounts: [...this.skippedAccounts] };
  }
}

// ---- ZIPs: the directory at the end says where each file is, so only the wanted ones are read ----

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number };

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 0x100000000;
const bytesOf = async (file: Blob, from: number, to: number) => new Uint8Array(await file.slice(from, to).arrayBuffer());

/** The files listed in a ZIP's central directory (ZIP64 too), or null when it has none (not a ZIP, or cut short) */
async function zipDirectory(file: File): Promise<ZipEntry[] | null> {
  const tailFrom = Math.max(0, file.size - 65_557);
  const tail = await bytesOf(file, tailFrom, file.size);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (u32(tail, i) === 0x06054b50) {
      at = i;
      break;
    }
  if (at < 0) return null;
  let count = u16(tail, at + 10);
  let dirSize = u32(tail, at + 12);
  let dirOffset = u32(tail, at + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // ZIP64: a locator just before the end record points at the bigger end record
    const loc = at - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) return null;
    const rec = await bytesOf(file, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
    if (rec.length < 56 || u32(rec, 0) !== 0x06064b50) return null;
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }
  if (dirOffset + dirSize > file.size) return null;
  const dir = await bytesOf(file, dirOffset, dirOffset + dirSize);
  const names = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= dir.length && u32(dir, p) === 0x02014b50; k++) {
    const flags = u16(dir, p + 8);
    const method = u16(dir, p + 10);
    let compressedSize = u32(dir, p + 20);
    let size = u32(dir, p + 24);
    const nameLen = u16(dir, p + 28);
    const extraLen = u16(dir, p + 30);
    const commentLen = u16(dir, p + 32);
    let offset = u32(dir, p + 42);
    const name = names.decode(dir.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 sizes and offset, in that order, for whichever didn't fit
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end; e += 4 + u16(dir, e + 2)) {
      if (u16(dir, e) !== 1) continue;
      let v = e + 4;
      if (size === 0xffffffff) {
        size = u64(dir, v);
        v += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = u64(dir, v);
        v += 8;
      }
      if (offset === 0xffffffff) offset = u64(dir, v);
      break;
    }
    if (!(flags & 1) && !name.endsWith("/")) out.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let breathedAt = 0;
/** Lets the page paint and respond between chunks of a long read */
async function breathe() {
  const now = Date.now();
  if (now - breathedAt < 30) return;
  breathedAt = now;
  await new Promise((r) => setTimeout(r, 0));
}

/** Streams bytes from a blob, chunk by chunk, to onData; onRead gets how many of the blob's bytes were read */
async function pump(blob: Blob, onData: (bytes: Uint8Array) => void, onRead: (n: number) => void) {
  const reader = blob.stream().getReader();
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      onData(value);
      onRead(value.length);
      await breathe();
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
  }
}

/** One ZIP entry's bytes, decompressed as they stream */
async function streamEntry(file: File, entry: ZipEntry, onData: (bytes: Uint8Array) => void, onRead: (n: number) => void) {
  const name = entry.name.split("/").pop() ?? entry.name;
  const bad = () => new Error(`Couldn't unzip ${name} in ${file.name}. Download it again.`);
  const head = await bytesOf(file, entry.offset, entry.offset + 30);
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw bad();
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${name} in ${file.name} is packed in a way the browser can't open. Download it again.`);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const inflate = entry.method === 8 ? new Inflate((d) => onData(d)) : null;
  const push = (bytes: Uint8Array, final = false) => {
    if (!inflate) return bytes.length && onData(bytes);
    try {
      inflate.push(bytes, final);
    } catch (e) {
      // fflate's own errors (they carry a numeric code) mean a broken download; ours (a stop, bad JSON) pass through
      if (typeof (e as { code?: unknown } | null)?.code === "number") throw bad();
      throw e;
    }
  };
  await pump(file.slice(start, start + entry.compressedSize), (b) => push(b), onRead);
  push(new Uint8Array(0), true);
}

// ---- Reading everything ----

type Item = {
  fileIndex: number;
  /** The JSON's own name (inside its ZIP, or the loose file's) */
  name: string;
  where: string;
  /** 0 who's who, 1 projects, 2 chats and the rest: read in that order */
  rank: number;
  size: number;
  /** Bytes read from the file for it (its compressed size in a ZIP) */
  cost: number;
  loose: boolean;
  open: (onData: (bytes: Uint8Array) => void, onRead: (n: number) => void) => Promise<void>;
};

const rankOf = (name: string, fileName: string) => (/users|members|accounts/i.test(name) || /light_metadata/i.test(fileName) ? 0 : /projects/i.test(name) ? 1 : 2);

function join(chunks: Uint8Array[], name: string) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total > MAX_JSON_BYTES) throw new Error(`${name} is too big to read in the browser (over 480 MB).`);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

/**
 * Every chat, project and person in the dropped files, merged (manifests among them are left out: the caller shows
 * their download links instead). Who's who is read first whatever order the files came in; given the person's email,
 * an organization's export keeps only their own chats and projects as it streams (the rest counted in skipped).
 * Throws in plain words when a file can't be read.
 */
export async function readClaudeExportFiles(files: File[], opts: ReadOptions = {}): Promise<ExportRead> {
  const streamOver = opts.streamOver ?? STREAM_OVER_BYTES;
  const items: Item[] = [];
  for (const [fileIndex, file] of files.entries()) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 4 GB. Export again, or drop just the JSON files from inside it.`);
    if (/\.zip$/i.test(file.name)) {
      const entries = await zipDirectory(file);
      if (!entries) throw new Error(`${file.name} isn't a complete ZIP. Download it again.`);
      for (const e of entries.filter((x) => isWantedEntry(x.name))) {
        const name = e.name.split("/").pop() ?? e.name;
        items.push({ fileIndex, name, where: `${name} in ${file.name}`, rank: rankOf(name, file.name), size: e.size, cost: e.compressedSize, loose: false, open: (onData, onRead) => streamEntry(file, e, onData, onRead) });
      }
    } else {
      items.push({ fileIndex, name: file.name, where: file.name, rank: rankOf(file.name, file.name), size: file.size, cost: file.size, loose: true, open: (onData, onRead) => pump(file, onData, onRead) });
    }
  }
  // Who's who first, then projects, then the chats (stable: otherwise in the order given)
  items.sort((a, b) => a.rank - b.rank);

  const gate = new OwnerGate(opts.email ?? null);
  const perFile: ExportFiles[][] = files.map(() => []);
  const manifests = new Set<number>();
  const fileTotals = files.map((_, i) => items.filter((it) => it.fileIndex === i).reduce((n, it) => n + it.cost, 0));
  const fileDone = files.map(() => 0);
  const total = items.reduce((n, it) => n + it.cost, 0) || 1;
  let done = 0;
  let toldAt = 0;
  const tell = (fileIndex: number, force = false) => {
    const now = Date.now();
    if (!opts.onProgress || (!force && now - toldAt < 100)) return;
    toldAt = now;
    opts.onProgress({ file: files[fileIndex].name, fileDone: fileDone[fileIndex], fileTotal: fileTotals[fileIndex], done, total });
  };

  for (const it of items) {
    if (it.rank > 0) gate.decide();
    gate.canStop = it.rank > 0;
    const isChats = it.rank === 2;
    if ((isChats && !gate.readsChats) || gate.stopped) {
      done += it.cost;
      continue;
    }
    const onRead = (n: number) => {
      fileDone[it.fileIndex] += n;
      done += n;
      tell(it.fileIndex);
    };
    const found: ExportFiles = { conversations: [], projects: [], users: [] };
    if (it.size <= streamOver) {
      // Small: read whole, as it always was
      const chunks: Uint8Array[] = [];
      await it.open((b) => chunks.push(b.slice()), onRead);
      const raw = parseJsonOrLines(join(chunks, it.where), it.where);
      if (it.loose && it.size <= MAX_MANIFEST_BYTES && parseManifest(raw)) {
        manifests.add(it.fileIndex);
        continue;
      }
      const kept = gate.keep(classifyExportJson(raw));
      found.conversations.push(...kept.conversations);
      found.projects.push(...kept.projects);
      found.users!.push(...(kept.users ?? []));
    } else {
      // Big: one item at a time, someone else's left unparsed
      const splitter = new JsonItemSplitter((text) => {
        if (!gate.wants(text)) return;
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Error(`${it.where} isn't readable JSON. Download that file again.`);
        }
        const kept = gate.keep(classifyExportJson(raw));
        for (const c of kept.conversations) found.conversations.push(c);
        for (const p of kept.projects) found.projects.push(p);
        for (const u of kept.users ?? []) found.users!.push(u);
        if (gate.stopped) throw new StopReading();
      });
      try {
        await it.open((b) => splitter.push(b), onRead);
        splitter.end();
      } catch (e) {
        if (!(e instanceof StopReading)) {
          if (e instanceof Error && !/^The JSON/.test(e.message)) throw e;
          throw new Error(`${it.where} isn't readable JSON. Download that file again.`);
        }
      }
    }
    perFile[it.fileIndex].push(found);
    tell(it.fileIndex, true);
  }

  const parts: ExportFiles[] = [];
  const summary: FileSummary[] = [];
  for (const [i, file] of files.entries()) {
    if (manifests.has(i)) continue;
    const merged = mergeExport(perFile[i]);
    summary.push({ name: file.name, chats: merged.conversations.length, people: merged.users?.length ?? 0, projects: merged.projects.length });
    parts.push(merged);
  }
  return { ...mergeExport(parts), files: summary, skipped: gate.skipped() };
}
