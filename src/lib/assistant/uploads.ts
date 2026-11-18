import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { CHUNK_CHARS, INLINE_DOC_CHARS, chunkText } from "./long-text";

// Files uploaded during a call (the assistant asked for creatives or a file): kept in the private ai-files bucket under
// the person's id, and looked at once with a cheap model so the assistant can say what it got (pictures as they are,
// videos as the frames the browser captured, PDFs whole). Saved on the call for the assistant's next turns, and passed
// to the chat tools as attachments (a launch sheet uploaded here starts a launch like one attached in Kaizen AI).

export type CallUpload = {
  path: string;
  name: string;
  mime: string;
  bytes: number;
  kind: "image" | "video" | "pdf" | "doc" | "text";
  frames?: { path: string; ms: number }[];
  /** creatives and files the assistant asked for; screen: a screenshot for a look (deleted with the call's audio) */
  purpose: "creatives" | "files" | "screen";
  client: string | null;
  about?: string;
  /** Creatives copied into a launch in progress (ad-media launch/<run>/...) */
  staged?: { launch: string; path: string };
  /** The file's whole text (every page), kept next to it in the bucket as <path>.txt; read_upload reads and searches it */
  textPath?: string;
  chars?: number;
  pages?: number;
  /** Why there's no text, or why only part of it (a scan read by the AI, an old .doc) */
  textNote?: string;
  /** A long document's parts, one line each on what's in them (the whole text stays searchable) */
  outline?: string[];
  /** Still to do after the answer: a scan to type out, or a long document to outline */
  pending?: "scan" | "outline";
};

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MAX_BYTES = 4_500_000;

export function kindOf(name: string, mime: string): CallUpload["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/\.(docx|xlsx|pptx|doc|xls|ppt)$/i.test(name)) return "doc";
  return "text";
}

/** Where an upload's whole text is kept */
export const textPathOf = (path: string) => `${path}.txt`;

const TEXT_CACHE = new Map<string, { at: number; text: string }>();

/** An upload's whole text (from its .txt next to it), cached for a few minutes on this server */
export async function uploadText(admin: SupabaseClient, u: Pick<CallUpload, "textPath">): Promise<string | null> {
  if (!u.textPath) return null;
  const hit = TEXT_CACHE.get(u.textPath);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.text;
  const b = await bytes(admin, u.textPath);
  if (!b) return null;
  const text = b.toString("utf8");
  if (TEXT_CACHE.size > 60) TEXT_CACHE.delete(TEXT_CACHE.keys().next().value!);
  TEXT_CACHE.set(u.textPath, { at: Date.now(), text });
  return text;
}

/** A scanned PDF (no text layer): the AI types it out, page by page */
async function transcribeScan(buf: Buffer, name: string): Promise<string> {
  const out = await askJson<{ pages: { page: number; text: string }[] }>({
    agent: "coach",
    label: "upload scan read",
    bare: true,
    noSample: true,
    override: { model: "haiku", effort: "low" },
    system: "You type out scanned documents exactly as written, page by page: every word, numbers and headings kept, tables as rows separated by |. No summary, no comments.",
    schema: { type: "object", additionalProperties: false, required: ["pages"], properties: { pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["page", "text"], properties: { page: { type: "integer" }, text: { type: "string" } } } } } },
    pdfs: [{ data: buf.toString("base64"), title: name }],
    maxTokens: 32000,
    prompt: `Type out every page of ${name}.`,
  });
  return (out.pages ?? []).map((p) => `[Page ${p.page}]\n${String(p.text ?? "").trim()}`).join("\n\n");
}

/** One line on what each part of a long document covers, so the assistant knows where to look */
async function outlineOf(text: string, name: string): Promise<string[]> {
  const chunks = chunkText(text, CHUNK_CHARS).slice(0, 40);
  const lines = await Promise.all(
    chunks.map((c) =>
      askJson<{ about: string }>({
        agent: "coach",
        label: "upload part summary",
        bare: true,
        noSample: true,
        override: { model: "haiku", effort: "low" },
        system: "Summarize one part of a longer document in one or two plain sentences: what it covers and the specifics in it (names, numbers, dates, decisions, steps). No preamble.",
        schema: { type: "object", additionalProperties: false, required: ["about"], properties: { about: { type: "string" } } },
        maxTokens: 400,
        prompt: `Part ${c.i + 1} of ${chunks.length} of ${name}:\n\n${c.text}`,
      })
        .then((r) => `Part ${c.i + 1}: ${String(r.about ?? "").trim()}`)
        .catch(() => `Part ${c.i + 1}: (not summarized; read it with read_upload)`),
    ),
  );
  return lines;
}

/**
 * Reads the whole text of each document uploaded (PDFs every page, Word, PowerPoint, Excel every tab, CSV and text),
 * keeps it next to the file as <path>.txt, and fills in textPath, chars and pages. Quick: the text layer only. A scan
 * (typed out by the AI) and the outline of a document too long to sit in the context whole are marked `pending` and
 * done by finishUploadTexts after the answer. Pictures and videos are left as they are.
 */
export async function readUploadTexts(admin: SupabaseClient, files: CallUpload[]): Promise<CallUpload[]> {
  const { fileText } = await import("./read-file");
  return Promise.all(
    files.map(async (f) => {
      if (f.kind !== "pdf" && f.kind !== "doc" && f.kind !== "text") return f;
      if (f.bytes > 60_000_000) return { ...f, textNote: "Over 60 MB: too big to read whole" };
      try {
        const buf = await bytes(admin, f.path);
        if (!buf) return { ...f, textNote: "The file isn't there any more" };
        const read = await fileText(buf, f.name, f.mime);
        if (!read.text && f.kind === "pdf" && f.bytes <= 25_000_000) return { ...f, pages: read.pages, textNote: "A scan: being typed out from the pages, ready in a minute or two", pending: "scan" as const };
        if (!read.text) return { ...f, pages: read.pages, textNote: read.note ?? "No text could be read from it" };
        const saved = await saveText(admin, f.path, read.text);
        if (!saved) return { ...f, textNote: "Its text couldn't be saved" };
        return { ...f, textPath: saved, chars: read.text.length, pages: read.pages, ...(read.note ? { textNote: read.note } : {}), ...(read.text.length > INLINE_DOC_CHARS ? { pending: "outline" as const } : {}) };
      } catch (e) {
        console.error("[call uploads] text", e instanceof Error ? e.message : e);
        return { ...f, textNote: "Its text couldn't be read just now" };
      }
    }),
  );
}

async function saveText(admin: SupabaseClient, path: string, text: string): Promise<string | null> {
  const textPath = textPathOf(path);
  const { error } = await admin.storage.from(AI_BUCKET).upload(textPath, Buffer.from(text, "utf8"), { contentType: "text/plain; charset=utf-8", upsert: true });
  if (error) return null;
  TEXT_CACHE.set(textPath, { at: Date.now(), text });
  return textPath;
}

/** The slow part, after the answer: scans typed out, long documents outlined; saved back on the call's uploads */
export async function finishUploadTexts(admin: SupabaseClient, callId: string): Promise<void> {
  const { data } = await admin.from("ai_role_calls").select("uploads").eq("id", callId).maybeSingle();
  const todo = ((data?.uploads ?? []) as CallUpload[]).filter((u) => u.pending);
  if (!todo.length) return;
  const done = new Map<string, Partial<CallUpload>>();
  for (const u of todo) {
    try {
      if (u.pending === "scan") {
        const buf = await bytes(admin, u.path);
        const typed = buf ? await transcribeScan(buf, u.name).catch(() => "") : "";
        const saved = typed ? await saveText(admin, u.path, typed) : null;
        done.set(u.path, saved ? { textPath: saved, chars: typed.length, textNote: "A scan: typed out by the AI from the pages", pending: undefined, ...(typed.length > INLINE_DOC_CHARS ? { outline: await outlineOf(typed, u.name).catch(() => undefined) } : {}) } : { textNote: "A scan, and it couldn't be typed out", pending: undefined });
      } else {
        const text = await uploadText(admin, u);
        done.set(u.path, { outline: text ? await outlineOf(text, u.name).catch(() => undefined) : undefined, pending: undefined });
      }
    } catch (e) {
      console.error("[call uploads] finish", e instanceof Error ? e.message : e);
      done.set(u.path, { pending: undefined });
    }
  }
  // Read again just before saving, so files uploaded meanwhile aren't lost
  const { data: now } = await admin.from("ai_role_calls").select("uploads").eq("id", callId).maybeSingle();
  const merged = ((now?.uploads ?? []) as CallUpload[]).map((u) => {
    const d = done.get(u.path);
    if (!d) return u;
    const next = { ...u, ...d };
    delete next.pending;
    return next;
  });
  await admin.from("ai_role_calls").update({ uploads: merged }).eq("id", callId);
}

async function bytes(admin: SupabaseClient, path: string): Promise<Buffer | null> {
  const { data } = await admin.storage.from(AI_BUCKET).download(path);
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

/** A short description of each upload (what's in the picture, the video, the PDF), filled into `about` */
export async function describeUploads(admin: SupabaseClient, files: CallUpload[]): Promise<CallUpload[]> {
  const images: { mediaType: (typeof IMAGE_TYPES)[number]; data: string }[] = [];
  const pdfs: { data: string; title: string }[] = [];
  const order: string[] = [];
  for (const f of files) {
    if (images.length >= 12) break;
    if (f.kind === "image" && IMAGE_TYPES.includes(f.mime as (typeof IMAGE_TYPES)[number]) && f.bytes <= MAX_BYTES) {
      const b = await bytes(admin, f.path);
      if (b) {
        images.push({ mediaType: f.mime as (typeof IMAGE_TYPES)[number], data: b.toString("base64") });
        order.push(`picture ${images.length}: ${f.name}`);
      }
    } else if (f.kind === "video") {
      for (const fr of (f.frames ?? []).slice(0, 3)) {
        const b = await bytes(admin, fr.path);
        if (b) {
          images.push({ mediaType: "image/jpeg", data: b.toString("base64") });
          order.push(`picture ${images.length}: a frame at ${(fr.ms / 1000).toFixed(1)}s of the video ${f.name}`);
        }
      }
    } else if (f.kind === "pdf" && f.bytes <= MAX_BYTES && pdfs.length < 2) {
      const b = await bytes(admin, f.path);
      if (b) {
        pdfs.push({ data: b.toString("base64"), title: f.name });
        order.push(`PDF: ${f.name}`);
      }
    }
  }
  if (!images.length && !pdfs.length) return files.map((f) => ({ ...f, about: f.about ?? `a ${f.kind} file` }));
  try {
    const out = await askJson<{ files: { name: string; about: string }[] }>({
      agent: "coach",
      label: "call upload read",
      bare: true,
      noSample: true,
      override: { model: "haiku", effort: "low" },
      system: "You look at files someone just uploaded during a call with their AI assistant at a marketing agency (ad creatives, launch sheets, reports). For each file say in one plain sentence what it is and what's in it (format, what's shown, any headline or offer, the size or length when you can tell). No judgement unless something is clearly broken.",
      schema: { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "about"], properties: { name: { type: "string" }, about: { type: "string" } } } } } },
      images,
      pdfs,
      maxTokens: 2000,
      prompt: `The files, in order:\n${order.join("\n")}\n\nAlso uploaded (not shown): ${files.filter((f) => !order.some((o) => o.includes(f.name))).map((f) => f.name).join(", ") || "nothing"}`,
    });
    const about = new Map((out.files ?? []).map((x) => [x.name, String(x.about).slice(0, 300)]));
    return files.map((f) => ({ ...f, about: about.get(f.name) ?? f.about ?? `a ${f.kind} file` }));
  } catch (e) {
    console.error("[call uploads]", e instanceof Error ? e.message : e);
    return files.map((f) => ({ ...f, about: f.about ?? `a ${f.kind} file (couldn't be read just now)` }));
  }
}
