import "server-only";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { readReferences, type RefImage } from "@/lib/references";

// The client's document history: every file and link shared about them (in the client desk chat or on the page),
// what the AI could read in it, and its summary. The AI reads them whenever it works on the client. Nothing is deleted.

export const DOCS_BUCKET = "client-docs";
const MAX_TEXT = 30_000;
const MAX_PDF = 20_000_000;

export type ClientDoc = { id: string; kind: "file" | "link"; name: string; url: string | null; path: string | null; mime: string | null; bytes: number | null; title: string | null; summary: string | null; status: string; note: string | null; via: string; by: string | null; at: string };

/** What the AI gets from one document: its text, or the PDF itself, or the picture */
export type DocRead = { id: string; label: string; text: string | null; pdf: string | null; image: RefImage | null; note: string | null };

const TEXTY = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|rtf))/;
const OFFICE: Record<string, RegExp> = { docx: /^word\/document\.xml$/, pptx: /^ppt\/slides\/slide\d+\.xml$/, xlsx: /^xl\/sharedStrings\.xml$/ };

/** The text inside an Office file (Word, PowerPoint, Excel): it's a zip of XML; read the parts with the words. */
function officeText(buf: Buffer, ext: keyof typeof OFFICE) {
  // The zip's directory is at the end: find it, then each entry's data
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const parts: { name: string; xml: string }[] = [];
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!OFFICE[ext].test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try {
      parts.push({ name, xml: (method === 8 ? inflateRawSync(raw) : raw).toString("utf8") });
    } catch {
      // A part that won't open is skipped
    }
  }
  const order = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return parts
    .sort((a, b) => order(a.name) - order(b.name))
    .map((p) =>
      p.xml
        .replace(/<\/w:p>|<\/a:p>|<\/si>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    )
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Open one document for the AI. */
export async function readDoc(admin: SupabaseClient, d: { id: string; kind: string; name: string; path: string | null; url: string | null; mime: string | null; text?: string | null }): Promise<DocRead> {
  const base = { id: d.id, label: d.name, text: null, pdf: null, image: null, note: null };
  if (d.kind === "link") {
    if (d.text) return { ...base, text: d.text };
    const { reads, images } = await readReferences([d.url!]);
    const r = reads[0];
    return { ...base, label: r?.label ?? d.name, text: r?.ok ? r.text : null, image: images[0] ?? null, note: r?.ok ? null : (r?.note ?? "Couldn't open the link") };
  }
  if (!d.path) return { ...base, note: "No file" };
  const { data } = await admin.storage.from(DOCS_BUCKET).download(d.path);
  if (!data) return { ...base, note: "The file is missing" };
  const buf = Buffer.from(await data.arrayBuffer());
  const mime = d.mime ?? "";
  const ext = d.name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return buf.byteLength <= MAX_PDF ? { ...base, pdf: buf.toString("base64"), text: d.text ?? null } : { ...base, note: "The PDF is too big to read (over 20 MB)" };
  if (mime.startsWith("image/")) {
    try {
      const jpeg = await sharp(buf, { limitInputPixels: 120_000_000 }).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
      return { ...base, image: { mediaType: "image/jpeg", data: jpeg.toString("base64") } };
    } catch {
      return { ...base, note: "The picture couldn't be opened" };
    }
  }
  if (ext in OFFICE) {
    const text = officeText(buf, ext as keyof typeof OFFICE);
    return text ? { ...base, text: text.slice(0, MAX_TEXT) } : { ...base, note: "The file couldn't be opened" };
  }
  if (TEXTY.test(mime) || ["txt", "md", "csv", "json", "html", "htm"].includes(ext)) {
    const raw = buf.toString("utf8");
    const text = ext.startsWith("htm") || mime === "text/html" ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : raw;
    return { ...base, text: text.slice(0, MAX_TEXT) };
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return { ...base, note: "Videos and audio are kept, not read (share a transcript to have it read)" };
  return { ...base, note: "This kind of file is kept, not read (PDF, Word, PowerPoint, Excel, text and pictures are)" };
}

/** Saves the documents (files already in storage, and links) for the client, as "reading". Returns their rows. */
export async function addDocs(
  admin: SupabaseClient,
  clientId: string,
  by: string,
  via: "chat" | "page",
  files: { path: string; name: string; mime: string; bytes: number }[],
  links: string[],
) {
  // Only files stored under this client's folder
  const mine = files.filter((f) => f.path.startsWith(`${clientId}/`));
  const rows = [
    ...mine.map((f) => ({ client_id: clientId, kind: "file", name: f.name.slice(0, 200), path: f.path, mime: f.mime || null, bytes: f.bytes, via, uploaded_by: by })),
    ...[...new Set(links)].slice(0, 6).map((u) => ({ client_id: clientId, kind: "link", name: u.slice(0, 300), url: u, via, uploaded_by: by })),
  ];
  if (!rows.length) return [];
  const { data, error } = await admin.from("client_documents").insert(rows).select("id, kind, name, path, url, mime");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Records what the AI read in a document: its title and summary, and the text for later reads. */
export async function finishDoc(admin: SupabaseClient, read: DocRead, out: { title?: string; summary?: string } | null) {
  await admin
    .from("client_documents")
    .update({
      title: out?.title?.slice(0, 200) || null,
      summary: out?.summary?.slice(0, 2000) || null,
      text: read.text?.slice(0, MAX_TEXT) ?? null,
      status: read.text || read.pdf || read.image ? "ready" : "unreadable",
      note: read.note,
    })
    .eq("id", read.id);
}

/** Documents shared on the page (not in the chat): read and summarized on their own. */
export async function summarizeDocs(admin: SupabaseClient, clientId: string, ids: string[]) {
  const { data: docs } = await admin.from("client_documents").select("id, kind, name, path, url, mime, text").in("id", ids).eq("client_id", clientId);
  const { data: c } = await admin.from("clients").select("name").eq("id", clientId).single();
  for (const d of docs ?? []) {
    const read = await readDoc(admin, d).catch((e) => ({ id: d.id, label: d.name, text: null, pdf: null, image: null, note: e instanceof Error ? e.message : "Couldn't read it" }) as DocRead);
    let out: { title: string; summary: string } | null = null;
    if (read.text || read.pdf || read.image)
      out = await askJson<{ title: string; summary: string }>({
        agent: "briefing",
        label: "client document",
        bare: true,
        maxTokens: 3000,
        system: "You file documents shared about a client of Kaizen, a paid ads and creative agency. Say what the document is in a few words (title), then in two to four sentences what in it matters for running this client's ads and creative (offers, prices, dates, audiences, brand rules, claims, results, decisions). Plain text.",
        schema: { type: "object", properties: { title: { type: "string" }, summary: { type: "string" } }, required: ["title", "summary"], additionalProperties: false },
        pdfs: read.pdf ? [{ data: read.pdf, title: d.name }] : [],
        images: read.image ? [read.image] : [],
        prompt: `Client: ${c?.name ?? "the client"}\nDocument: ${read.label}\n${read.text ? `<content>\n${read.text.slice(0, MAX_TEXT)}\n</content>` : "(attached)"}`,
      }).catch(() => null);
    await finishDoc(admin, read, out);
  }
}

/** The client's documents as the AI reads them as background: the latest few, each with its summary. */
export async function docsBlock(admin: SupabaseClient, clientId: string, limit = 12) {
  const { data } = await admin.from("client_documents").select("name, title, summary, created_at, kind").eq("client_id", clientId).eq("status", "ready").not("summary", "is", null).order("created_at", { ascending: false }).limit(limit);
  if (!data?.length) return "";
  return `<client_documents>\nFiles and links the team shared about this client (newest first):\n${data.map((d) => `- ${String(d.created_at).slice(0, 10)} · ${d.title ?? d.name}${d.kind === "link" ? ` (${d.name})` : ""}: ${d.summary}`).join("\n")}\n</client_documents>`;
}
