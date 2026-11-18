import "server-only";
import { officeText } from "@/lib/client-docs";
import { googleDriveToken, googleConfigured } from "@/lib/context/google";
import { exportTypeFor, googleReadProblem, parseGoogleLink, rowsToCsv } from "@/lib/google-links";
import { pdfPages } from "@/lib/knowledge";
import { readXlsx } from "@/lib/list-clean/xlsx";

// A file's whole text, for the assistant and Kaizen AI: an upload (PDF page by page, Word, PowerPoint, Excel tab by tab,
// CSV and text), or a Google Docs, Sheets, Slides or Drive file opened as the person (the Workspace service account
// acting as them, read only, so they see exactly what they can open in Drive and nothing else).

export type FileText = { text: string; pages?: number; note?: string; title?: string };

/** The most read from one file (about a hundred and fifty pages of text): past this, the note says so */
export const MAX_FILE_CHARS = 600_000;

const clean = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();

function capped(text: string, pages?: number): FileText {
  const t = clean(text);
  return t.length > MAX_FILE_CHARS ? { text: t.slice(0, MAX_FILE_CHARS), pages, note: `Only the first ${MAX_FILE_CHARS.toLocaleString("en-US")} characters were read (the file is ${t.length.toLocaleString("en-US")})` } : { text: t, pages };
}

/** The text of a file's bytes, by its name and type. Empty text with a note when it has none (a scan, a picture). */
export async function fileText(buf: Buffer, name: string, mime: string): Promise<FileText> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") {
    const pages = await pdfPages(buf);
    if (!pages) return { text: "", note: "The PDF couldn't be opened" };
    const text = pages.map((p, i) => `[Page ${i + 1}]\n${p}`).join("\n\n");
    const words = pages.join(" ").replace(/\s+/g, "").length;
    if (words < 40 * Math.max(1, pages.length) && words < 400) return { text: "", pages: pages.length, note: "It's a scan (no text layer)" };
    return capped(text, pages.length);
  }
  if (ext === "xlsx" || mime.includes("spreadsheetml")) {
    const x = readXlsx(new Uint8Array(buf));
    if (x.ok) return capped(x.sheets.map((s) => `[Tab: ${s.name}]\n${rowsToCsv(s.rows)}`).join("\n\n"));
    const t = officeText(buf, "xlsx");
    return t ? capped(t) : { text: "", note: x.error };
  }
  if (ext === "docx" || ext === "pptx") {
    const t = officeText(buf, ext);
    return t ? capped(t) : { text: "", note: "The file couldn't be opened" };
  }
  if (ext === "doc" || ext === "xls" || ext === "ppt") return { text: "", note: `Old .${ext} files can't be read: save it as .${ext}x (or PDF) and upload that` };
  if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) return { text: "" };
  const raw = buf.toString("utf8");
  if (ext === "html" || ext === "htm" || mime === "text/html") return capped(raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "));
  // Anything else that decodes as text (txt, md, csv, json, rtf); binary is refused
  if (/\u0000/.test(raw.slice(0, 4000))) return { text: "", note: "This kind of file can't be read as text" };
  return capped(raw);
}

type DriveMeta = { id: string; name: string; mimeType: string; size?: string; webViewLink?: string; modifiedTime?: string; owners?: { displayName?: string }[] };

async function driveGet(token: string, path: string, params: Record<string, string>): Promise<Response> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams({ supportsAllDrives: "true", ...params })}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`Google /drive/v3/${path.split("/")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export type GoogleRead = { ok: true; title: string; kind: string; url: string; modified: string | null; text: string; note?: string; pages?: number } | { ok: false; problem: ReturnType<typeof googleReadProblem>["kind"]; say: string };

/**
 * Opens a Google Docs, Sheets, Slides or Drive file as the person (their own Drive rights, read only) and returns its
 * whole text: a Doc or Slides as plain text, a Sheet tab by tab as CSV, a PDF, Word, Excel or text file in Drive by its
 * contents. A folder lists what's in it.
 */
export async function readGoogleFile(email: string, link: string): Promise<GoogleRead> {
  const l = parseGoogleLink(link);
  if (!l) return { ok: false, problem: "not_found", say: "That isn't a Google Docs, Sheets, Slides or Drive link." };
  if (!googleConfigured()) return { ok: false, problem: "other", say: "Google isn't connected to Kaizen OS yet." };
  if (!email) return { ok: false, problem: "other", say: "Your profile has no Kaizen email, so Google can't be opened as you." };
  try {
    const token = await googleDriveToken(email);
    const meta = (await (await driveGet(token, `files/${l.id}`, { fields: "id,name,mimeType,size,webViewLink,modifiedTime,owners(displayName)" })).json()) as DriveMeta;
    const base = { ok: true as const, title: meta.name, url: meta.webViewLink ?? l.url, modified: meta.modifiedTime ?? null };
    if (meta.mimeType === "application/vnd.google-apps.folder") {
      const list = (await (await driveGet(token, "files", { q: `'${l.id}' in parents and trashed = false`, fields: "files(id,name,mimeType,modifiedTime,webViewLink)", pageSize: "200", includeItemsFromAllDrives: "true", corpora: "allDrives", orderBy: "modifiedTime desc" })).json()) as { files?: DriveMeta[] };
      const files = list.files ?? [];
      return { ...base, kind: "folder", text: files.length ? files.map((f) => `- ${f.name} (${f.mimeType.replace("application/vnd.google-apps.", "Google ")}, ${String(f.modifiedTime ?? "").slice(0, 10)}): ${f.webViewLink ?? ""}`).join("\n") : "(empty)" };
    }
    const exp = exportTypeFor(meta.mimeType);
    if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
      if (!exp) return { ok: false, problem: "other", say: `That's a ${meta.mimeType.replace("application/vnd.google-apps.", "Google ")} file, which has no text to read.` };
      const res = await driveGet(token, `files/${l.id}/export`, { mimeType: exp.mime });
      if (exp.as === "xlsx") {
        const read = await fileText(Buffer.from(await res.arrayBuffer()), `${meta.name}.xlsx`, exp.mime);
        return { ...base, kind: "sheet", text: read.text, note: read.note };
      }
      const read = capped(await res.text());
      return { ...base, kind: meta.mimeType.endsWith("presentation") ? "slides" : "doc", text: read.text, note: read.note };
    }
    if (Number(meta.size ?? 0) > 60_000_000) return { ok: false, problem: "other", say: `${meta.name} is over 60 MB, too big to read here.` };
    const res = await driveGet(token, `files/${l.id}`, { alt: "media" });
    const read = await fileText(Buffer.from(await res.arrayBuffer()), meta.name, meta.mimeType);
    if (!read.text) return { ok: false, problem: "other", say: `${meta.name} opened, but has no text to read${read.note ? ` (${read.note})` : ""}.` };
    return { ...base, kind: "file", text: read.text, note: read.note, pages: read.pages };
  } catch (e) {
    const p = googleReadProblem(e instanceof Error ? e.message : String(e));
    return { ok: false, problem: p.kind, say: p.say };
  }
}
