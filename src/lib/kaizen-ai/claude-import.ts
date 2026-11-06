import { matchClientName, type NamedClient } from "@/lib/client-name-match";

// Reading a Claude data export (claude.ai: Settings, Privacy, Export data) into conversations Kaizen AI can import:
// conversations.json (older exports: each message's text; newer ones: content blocks, tool calls and thinking too,
// and a parent link per message when a message was edited into branches), and projects.json (the project's docs).
// Pure, so it runs in the browser on the person's own file and is tested with fixtures.

export const IMPORT_SOURCE = "claude";
/** The most kept from one message, one attached file, and a project's docs (the rest is cut with a note) */
export const MAX_MESSAGE_CHARS = 100_000;
export const MAX_FILE_CHARS = 100_000;
export const MAX_NOTES_CHARS = 300_000;
/** What one import request carries (well under the host's 4.5 MB request limit) */
export const MAX_BATCH_CHARS = 2_500_000;

export type ImportedFile = { name: string; text: string | null };
export type ImportedMessage = { role: "user" | "assistant"; text: string; at: string; files: ImportedFile[] };
export type ImportedConversation = {
  uuid: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ImportedMessage[];
  /** The Claude project it was in, when the export says */
  projectUuid: string | null;
  /** Characters in it (for batching and the preview) */
  chars: number;
};
export type ImportedProject = { uuid: string; name: string; docs: { name: string; text: string }[] };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n\n…(cut: the rest was too long to import)` : s);

function iso(v: unknown, fallback: string) {
  const s = str(v);
  if (!s) return fallback;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

const TOOL_NAMES: Record<string, string> = { web_search: "searched the web", web_fetch: "read a web page", artifacts: "made an artifact", repl: "ran analysis", google_drive_search: "searched Google Drive", drive_search: "searched Google Drive" };

/** A message's text: its text blocks when it has content blocks (thinking and tool internals left out, tool use as a short note), else its text */
export function messageText(m: Obj): string {
  const content = Array.isArray(m.content) ? (m.content as unknown[]).map(obj).filter((b): b is Obj => Boolean(b)) : [];
  const texts = content.filter((b) => b.type === "text" && str(b.text).trim()).map((b) => str(b.text).trim());
  const tools = [...new Set(content.filter((b) => b.type === "tool_use").map((b) => TOOL_NAMES[str(b.name)] ?? (str(b.name) ? `used ${str(b.name).replace(/_/g, " ")}` : "used a tool")))];
  let text = texts.length ? texts.join("\n\n") : str(m.text).trim();
  if (tools.length && text) text = `${text}\n\n_(On the way, Claude ${tools.join("; ")}.)_`;
  else if (tools.length) text = `_(Claude ${tools.join("; ")}.)_`;
  return text;
}

function messageFiles(m: Obj): ImportedFile[] {
  const out: ImportedFile[] = [];
  const seen = new Set<string>();
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []).map(obj)) {
    if (!a) continue;
    const name = str(a.file_name) || str(a.name) || "attachment";
    const text = str(a.extracted_content);
    out.push({ name: name.slice(0, 200), text: text ? cut(text, MAX_FILE_CHARS) : null });
    seen.add(name);
  }
  for (const f of (Array.isArray(m.files) ? m.files : []).map(obj)) {
    if (!f) continue;
    const name = str(f.file_name) || str(f.name);
    if (!name || seen.has(name)) continue;
    out.push({ name: name.slice(0, 200), text: null });
    seen.add(name);
  }
  return out;
}

/**
 * The messages in the order they were said. When messages were edited into branches (newer exports give each a
 * parent), only the branch the conversation ended on: from its last message back to the first.
 */
function mainBranch(list: Obj[], leaf: string | null): Obj[] {
  const byId = new Map(list.filter((m) => str(m.uuid)).map((m) => [str(m.uuid), m]));
  const parented = list.filter((m) => byId.has(str(m.parent_message_uuid))).length;
  if (parented < Math.max(1, list.length - 1) * 0.6) return list;
  const end = (leaf && byId.get(leaf)) || [...list].sort((a, b) => str(a.created_at).localeCompare(str(b.created_at))).at(-1)!;
  const chain: Obj[] = [];
  const seen = new Set<string>();
  for (let m: Obj | undefined = end; m && !seen.has(str(m.uuid)); m = byId.get(str(m.parent_message_uuid))) {
    seen.add(str(m.uuid));
    chain.unshift(m);
  }
  return chain.length ? chain : list;
}

function titleFrom(c: Obj, messages: ImportedMessage[]) {
  const name = str(c.name).replace(/\s+/g, " ").trim();
  if (name) return name.slice(0, 120);
  const summary = str(c.summary).split("\n")[0]?.replace(/[#*_]/g, "").trim();
  if (summary) return summary.slice(0, 80);
  const first = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim() ?? "";
  if (!first) return "Untitled chat";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/** One conversation from the export, or null when it has no id or nothing said */
export function parseConversation(raw: unknown, now = new Date().toISOString()): ImportedConversation | null {
  const c = obj(raw);
  if (!c) return null;
  const uuid = str(c.uuid) || str(c.id);
  if (!uuid) return null;
  const createdAt = iso(c.created_at, now);
  const list = (Array.isArray(c.chat_messages) ? c.chat_messages : Array.isArray(c.messages) ? c.messages : []).map(obj).filter((m): m is Obj => Boolean(m));
  const messages: ImportedMessage[] = [];
  let last = "";
  for (const m of mainBranch(list, str(c.current_leaf_message_uuid) || null)) {
    const sender = str(m.sender) || str(m.role);
    const role = sender === "human" || sender === "user" ? "user" : sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const text = cut(messageText(m), MAX_MESSAGE_CHARS);
    const files = messageFiles(m);
    if (!text && !files.length) continue;
    // Original times, kept strictly in order (the thread is read back by time)
    let at = iso(m.created_at ?? m.updated_at, last || createdAt);
    if (last && at <= last) at = new Date(Date.parse(last) + 1).toISOString();
    last = at;
    messages.push({ role, text, at, files });
  }
  if (!messages.length) return null;
  const updatedAt = [iso(c.updated_at, createdAt), last].sort().at(-1)!;
  const project = obj(c.project);
  return {
    uuid: uuid.slice(0, 100),
    title: titleFrom(c, messages),
    createdAt,
    updatedAt,
    messages,
    projectUuid: str(c.project_uuid) || str(project?.uuid) || null,
    chars: messages.reduce((n, m) => n + m.text.length + m.files.reduce((k, f) => k + (f.text?.length ?? 0) + f.name.length, 0), 0),
  };
}

/** Every conversation in conversations.json (an array; some tools wrap it as { conversations }), newest first */
export function parseConversations(raw: unknown, now = new Date().toISOString()): ImportedConversation[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw)?.conversations) ? (obj(raw)!.conversations as unknown[]) : [];
  const seen = new Set<string>();
  const out: ImportedConversation[] = [];
  for (const c of list) {
    const p = parseConversation(c, now);
    if (!p || seen.has(p.uuid)) continue;
    seen.add(p.uuid);
    out.push(p);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Projects with docs that have text (projects.json) */
export function parseProjects(raw: unknown): ImportedProject[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw)?.projects) ? (obj(raw)!.projects as unknown[]) : [];
  return list.flatMap((x) => {
    const p = obj(x);
    const uuid = p ? str(p.uuid) || str(p.id) : "";
    if (!p || !uuid) return [];
    let room = MAX_NOTES_CHARS;
    const docs = (Array.isArray(p.docs) ? p.docs : []).map(obj).flatMap((d) => {
      const text = d ? str(d.content).trim() : "";
      if (!d || !text || room <= 0) return [];
      const kept = cut(text, room);
      room -= kept.length;
      return [{ name: (str(d.filename) || str(d.name) || "Document").slice(0, 200), text: kept }];
    });
    const prompt = str(p.prompt_template).trim();
    if (prompt && room > 0) docs.unshift({ name: "Project instructions", text: cut(prompt, Math.min(room, 20_000)) });
    return docs.length ? [{ uuid: uuid.slice(0, 100), name: str(p.name).trim().slice(0, 100) || "Claude project", docs }] : [];
  });
}

/** The ones not imported yet (by Claude's conversation id, per person) */
export function notImported<T extends { uuid: string }>(list: T[], imported: Iterable<string>): T[] {
  const done = new Set(imported);
  return list.filter((c) => !done.has(c.uuid));
}

/** The client a conversation is most likely about: named in its title, else clearly named in how it starts */
export function suggestClient<C extends NamedClient>(c: Pick<ImportedConversation, "title" | "messages">, clients: C[]): C | null {
  if (!clients.length) return null;
  const byTitle = matchClientName(c.title, clients).sure;
  if (byTitle) return byTitle;
  const opening = c.messages
    .filter((m) => m.role === "user")
    .slice(0, 3)
    .map((m) => m.text)
    .join("\n")
    .slice(0, 4000);
  return opening ? matchClientName(`${c.title}\n${opening}`, clients).sure : null;
}

export type ImportItem = {
  uuid: string;
  kind: "chat" | "project";
  title: string;
  createdAt: string;
  updatedAt: string;
  clientId: string | null;
  messages: ImportedMessage[];
  notes: { name: string; text: string }[];
  /** Long conversations go in parts: the first creates the thread, the last marks it complete */
  part: number;
  last: boolean;
};

const sizeOf = (m: ImportedMessage) => m.text.length + m.files.reduce((n, f) => n + (f.text?.length ?? 0) + f.name.length + 40, 0) + 120;

/** A conversation as import items: one, or several parts when it's bigger than a request carries */
export function partsOf(base: Omit<ImportItem, "messages" | "part" | "last">, messages: ImportedMessage[], max = MAX_BATCH_CHARS): ImportItem[] {
  const notes = base.notes.reduce((n, d) => n + d.text.length, 0);
  const parts: ImportedMessage[][] = [[]];
  let size = notes;
  for (const m of messages) {
    const s = sizeOf(m);
    if (parts.at(-1)!.length && size + s > max) {
      parts.push([]);
      size = 0;
    }
    parts.at(-1)!.push(m);
    size += s;
  }
  return parts.map((ms, i) => ({ ...base, notes: i === 0 ? base.notes : [], messages: ms, part: i, last: i === parts.length - 1 }));
}

/** Import items grouped into requests that each stay under the size limit */
export function batches(items: ImportItem[], max = MAX_BATCH_CHARS, maxItems = 40): ImportItem[][] {
  const out: ImportItem[][] = [];
  let cur: ImportItem[] = [];
  let size = 0;
  for (const it of items) {
    const s = it.messages.reduce((n, m) => n + sizeOf(m), 0) + it.notes.reduce((n, d) => n + d.text.length, 0) + 300;
    if (cur.length && (size + s > max || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
