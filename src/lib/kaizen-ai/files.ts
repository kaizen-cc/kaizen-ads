import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { officeText } from "@/lib/client-docs";
import type { Attachment } from "./types";

// Files attached in Kaizen AI, turned into what the model reads: pictures as pictures, PDFs whole, Word, Excel and
// PowerPoint as their text, CSV and text as text, and videos as the frames the browser captured plus a transcript of
// the audio (read once, then kept on the message). Files live in the private ai-files bucket under the person's id.

export const AI_BUCKET = "ai-files";
const MAX_TEXT = 120_000;
const MAX_FRAMES = 16;

type Block = Anthropic.ContentBlockParam;

async function download(admin: SupabaseClient, path: string) {
  const { data, error } = await admin.storage.from(AI_BUCKET).download(path);
  if (error || !data) throw new Error("The file isn't there any more");
  return Buffer.from(await data.arrayBuffer());
}

/** The frames to show the model: evenly spread through the video, at most MAX_FRAMES */
function spread<T>(list: T[], n: number) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

/**
 * The content blocks for a message's attachments. full: send pictures, PDFs and frames themselves (the newest messages);
 * otherwise only their names and the text already read from them (older messages, so the thread stays affordable).
 * Returns the attachments with anything newly read filled in, to save back.
 */
export async function attachmentBlocks(admin: SupabaseClient, files: Attachment[], full: boolean): Promise<{ blocks: Block[]; files: Attachment[] }> {
  const blocks: Block[] = [];
  const out: Attachment[] = [];
  for (const f of files) {
    const a = { ...f };
    try {
      if (a.kind === "image") {
        if (full) {
          const buf = await download(admin, a.path);
          blocks.push({ type: "text", text: `Attached picture: ${a.name}` });
          blocks.push({ type: "image", source: { type: "base64", media_type: a.mime as "image/png", data: buf.toString("base64") } });
        } else blocks.push({ type: "text", text: `(Earlier in the thread they attached a picture: ${a.name})` });
      } else if (a.kind === "pdf") {
        if (full) {
          const buf = await download(admin, a.path);
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: a.name });
        } else blocks.push({ type: "text", text: `(Earlier in the thread they attached a PDF: ${a.name})` });
      } else if (a.kind === "doc" || a.kind === "text") {
        if (a.text == null) {
          const buf = await download(admin, a.path);
          const ext = a.name.toLowerCase().split(".").pop() as "docx" | "xlsx" | "pptx";
          a.text = (a.kind === "doc" ? officeText(buf, ext) : buf.toString("utf8"))?.slice(0, MAX_TEXT) ?? null;
          if (!a.text) a.note = "No text could be read from it";
        }
        blocks.push({ type: "text", text: `<attached_file name="${a.name.replace(/"/g, "'")}">\n${(full ? a.text : a.text?.slice(0, 6000)) ?? `(${a.note ?? "couldn't be read"})`}\n</attached_file>` });
      } else if (a.kind === "video") {
        if (a.transcript == null && a.audio) {
          try {
            const { transcribe } = await import("@/lib/transcribe");
            const lines = await transcribe(await download(admin, a.audio));
            a.transcript = lines.map((l) => `[${(l.ms / 1000).toFixed(1)}s] ${l.text}`).join("\n") || "(nothing is said)";
          } catch (e) {
            a.transcript = "";
            a.note = `No transcript: ${e instanceof Error ? e.message : "it couldn't be read"}`;
          }
        }
        const frames = spread(a.frames ?? [], MAX_FRAMES);
        blocks.push({ type: "text", text: `Attached video: ${a.name}. ${frames.length ? `${frames.length} frames through it follow, each with its time.` : "No frames could be captured."}${a.transcript ? `\nTranscript:\n${a.transcript.slice(0, 20_000)}` : a.note ? `\n${a.note}` : a.audio ? "" : "\n(No sound track.)"}` });
        if (full)
          for (const fr of frames) {
            const buf = await download(admin, fr.path).catch(() => null);
            if (!buf) continue;
            blocks.push({ type: "text", text: `${(fr.ms / 1000).toFixed(1)}s` });
            blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
          }
      }
    } catch (e) {
      blocks.push({ type: "text", text: `(${a.name} couldn't be opened: ${e instanceof Error ? e.message : "unknown"})` });
    }
    out.push(a);
  }
  return { blocks, files: out };
}

