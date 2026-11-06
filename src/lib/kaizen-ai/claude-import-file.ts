import { Unzip, UnzipInflate } from "fflate";
import { parseManifest, type Manifest } from "./claude-export-manifest";

// The person's Claude export, read in their browser: one ZIP or several (the older export is one ZIP; the newer one
// comes in parts, its chats split across conversations-000.zip, -001.zip and so on, who's who in the light_metadata
// part), or loose JSON files from inside them. Each ZIP is streamed through, keeping only the JSON (or JSON Lines)
// files whose names mention conversations, users or projects (at any folder depth); what each holds is told by its
// content, not its name, and everything is merged across files with each chat kept once. Nothing is uploaded until
// they pick what to import, and from an organization's export only their own chats ever are.

/** The biggest export file we read (each ZIP, or each JSON on its own) */
export const MAX_FILE_BYTES = 1_500_000_000;
/** The biggest JSON a browser can turn into text (V8's string limit is about 512 MB) */
export const MAX_JSON_BYTES = 480_000_000;
/** Manifests are a few KB: a JSON this small is checked for being one before it's read as data */
export const MAX_MANIFEST_BYTES = 2_000_000;

export type ExportFiles = { conversations: unknown[]; projects: unknown[]; users: unknown[] | null };
export type FileSummary = { name: string; chats: number; people: number; projects: number };
export type ExportRead = ExportFiles & { files: FileSummary[] };

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

/** The manifest, when this small JSON is Claude's export manifest */
export async function readManifest(file: File): Promise<Manifest | null> {
  if (!/\.json$/i.test(file.name) || file.size > MAX_MANIFEST_BYTES) return null;
  try {
    return parseManifest(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

async function readZip(file: File, onRead: (bytes: number) => void): Promise<ExportFiles[]> {
  const entries: { name: string; chunks: Uint8Array[]; done: boolean }[] = [];
  let failed: Error | null = null;
  const uz = new Unzip((entry) => {
    if (!isWantedEntry(entry.name)) return;
    const name = entry.name.split("/").pop() ?? entry.name;
    const kept = { name, chunks: [] as Uint8Array[], done: false };
    entries.push(kept);
    let size = 0;
    entry.ondata = (err, data, final) => {
      if (err) {
        failed = new Error(`Couldn't unzip ${name} in ${file.name}.`);
        return;
      }
      size += data.length;
      if (size > MAX_JSON_BYTES) {
        failed = new Error(`${name} in ${file.name} is too big to read in the browser (over 480 MB).`);
        entry.terminate();
        return;
      }
      kept.chunks.push(data);
      if (final) kept.done = true;
    };
    entry.start();
  });
  uz.register(UnzipInflate);
  const reader = file.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      uz.push(new Uint8Array(0), true);
      break;
    }
    uz.push(value);
    if (failed) {
      void reader.cancel();
      throw failed;
    }
    onRead(value.length);
  }
  if (failed) throw failed;
  return entries.filter((e) => e.done).map((e) => classifyExportJson(parseJsonOrLines(join(e.chunks, e.name), e.name)));
}

/**
 * Every chat, project and person in the dropped files, merged (manifests among them are left out: the caller shows
 * their download links instead). Throws in plain words when a file can't be read.
 */
export async function readClaudeExportFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<ExportRead> {
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let read = 0;
  const parts: ExportFiles[] = [];
  const summary: FileSummary[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 1.5 GB. Export again, or drop just the JSON files from inside it.`);
    let found: ExportFiles[];
    if (/\.zip$/i.test(file.name)) {
      found = await readZip(file, (n) => {
        read += n;
        onProgress?.(read, total);
      });
    } else {
      if (file.size > MAX_JSON_BYTES) throw new Error(`${file.name} is too big to read in the browser (over 480 MB).`);
      const raw = parseJsonOrLines(await file.text(), file.name);
      read += file.size;
      onProgress?.(read, total);
      if (file.size <= MAX_MANIFEST_BYTES && parseManifest(raw)) continue;
      found = [classifyExportJson(raw)];
    }
    const merged = mergeExport(found);
    summary.push({ name: file.name, chats: merged.conversations.length, people: merged.users?.length ?? 0, projects: merged.projects.length });
    parts.push(merged);
  }
  return { ...mergeExport(parts), files: summary };
}

