import { Unzip, UnzipInflate } from "fflate";

// The person's Claude export, read in their browser: the ZIP streamed through (only conversations.json, projects.json
// and users.json are kept; everything else in it is skipped as it passes), or conversations.json on its own. Nothing
// is uploaded until they pick what to import, and from an organization's export only their own chats ever are.

/** The biggest export file we read (the ZIP, or the JSON on its own) */
export const MAX_FILE_BYTES = 1_500_000_000;
/** The biggest conversations.json a browser can turn into text (V8's string limit is about 512 MB) */
export const MAX_JSON_BYTES = 480_000_000;

export type ExportFiles = { conversations: unknown; projects: unknown | null; users: unknown | null };

const KEPT = ["conversations.json", "projects.json", "users.json"];

const base = (name: string) => name.split("/").pop()?.toLowerCase() ?? "";

function join(chunks: Uint8Array[]) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total > MAX_JSON_BYTES) throw new Error("conversations.json is too big to read in the browser (over 480 MB).");
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

function parse(text: string, name: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${name} isn't readable JSON. Download the export again.`);
  }
}

export async function readClaudeExport(file: File, onProgress?: (done: number, total: number) => void): Promise<ExportFiles> {
  if (file.size > MAX_FILE_BYTES) throw new Error("That file is over 1.5 GB. Export again, or drop just conversations.json from inside the ZIP.");
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".json")) {
    if (file.size > MAX_JSON_BYTES) throw new Error("conversations.json is too big to read in the browser (over 480 MB).");
    const raw = parse(await file.text(), file.name);
    return { conversations: raw, projects: null, users: null };
  }
  const wanted: Record<string, Uint8Array[]> = {};
  const done = new Set<string>();
  let failed: Error | null = null;
  const uz = new Unzip((entry) => {
    const name = base(entry.name);
    if (!KEPT.includes(name)) return;
    if (wanted[name]) return;
    const chunks: Uint8Array[] = [];
    wanted[name] = chunks;
    let size = 0;
    entry.ondata = (err, data, final) => {
      if (err) {
        failed = new Error(`Couldn't unzip ${name}.`);
        return;
      }
      size += data.length;
      if (size > MAX_JSON_BYTES) {
        failed = new Error("conversations.json is too big to read in the browser (over 480 MB).");
        entry.terminate();
        return;
      }
      chunks.push(data);
      if (final) done.add(name);
    };
    entry.start();
  });
  uz.register(UnzipInflate);
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) {
      uz.push(new Uint8Array(0), true);
      break;
    }
    read += value.length;
    uz.push(value);
    if (failed) throw failed;
    onProgress?.(read, file.size);
    // All found and whole: the rest of the ZIP isn't needed
    if (KEPT.every((k) => done.has(k))) {
      void reader.cancel();
      break;
    }
  }
  if (failed) throw failed;
  if (!wanted["conversations.json"]) throw new Error("There's no conversations.json in that ZIP. Is it the export from Claude (Settings › Privacy › Export data, or an owner's Admin settings › Data and privacy)?");
  const conversations = parse(join(wanted["conversations.json"]), "conversations.json");
  let projects: unknown = null;
  if (wanted["projects.json"]) {
    try {
      projects = JSON.parse(join(wanted["projects.json"]));
    } catch {
      projects = null;
    }
  }
  // Who's who in an organization's export: without it, chats from several accounts can't be told apart (and are refused)
  const users = wanted["users.json"] ? parse(join(wanted["users.json"]), "users.json") : null;
  return { conversations, projects, users };
}
