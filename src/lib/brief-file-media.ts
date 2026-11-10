import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRIEF_BUCKET, KIND_WORD, MAX_BRIEF_FILES, briefFileKind, clock, ownPath, type BriefFile } from "@/lib/brief-files";

// Files added to a brief, made into what the AI reads with the message: pictures (made small JPEGs) and PDFs as they
// are, a video as the few frames the browser took (with its name and length), audio by its name and length. Anything
// that can't be read is named in the text instead, so the AI never pretends it saw it.

export type AskMedia = { images: { mediaType: "image/jpeg"; data: string }[]; pdfs: { data: string; title: string }[]; text: string };

const MAX_IMAGES = 12;
const MAX_PDF_BYTES = 24_000_000;

async function download(admin: SupabaseClient, path: string) {
  const { data, error } = await admin.storage.from(BRIEF_BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** A picture the AI reads well: at most 1568px on its long side, JPEG */
async function small(bytes: Buffer) {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(bytes, { animated: false }).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    return null;
  }
}

/** The files a message came with, checked (this client's own, a kind we take), as the AI's pictures, PDFs and a note */
export async function briefFileMedia(admin: SupabaseClient, clientId: string, raw: BriefFile[] | null | undefined): Promise<AskMedia> {
  const out: AskMedia = { images: [], pdfs: [], text: "" };
  const files = (raw ?? []).filter((f) => f && ownPath(f.path, clientId) && briefFileKind(f.mime ?? "", f.name ?? "") === f.kind).slice(0, MAX_BRIEF_FILES);
  if (!files.length) return out;
  const lines: string[] = [];
  for (const f of files) {
    const name = String(f.name).slice(0, 120);
    const len = clock(f.seconds);
    try {
      if (f.kind === "image") {
        const buf = out.images.length < MAX_IMAGES ? await download(admin, f.path) : null;
        const jpg = buf ? await small(buf) : null;
        if (jpg) {
          out.images.push({ mediaType: "image/jpeg", data: jpg.toString("base64") });
          lines.push(`- Picture ${out.images.length}: ${name}`);
        } else lines.push(`- Picture: ${name} (couldn't be read; only its name is known)`);
      } else if (f.kind === "pdf") {
        const buf = f.bytes <= MAX_PDF_BYTES ? await download(admin, f.path) : null;
        if (buf && buf.length <= MAX_PDF_BYTES) {
          out.pdfs.push({ data: buf.toString("base64"), title: name });
          lines.push(`- PDF: ${name} (attached as a document)`);
        } else lines.push(`- PDF: ${name} (too big to read here; only its name is known)`);
      } else if (f.kind === "video") {
        const frames = (f.frames ?? []).filter((p) => ownPath(p, clientId)).slice(0, 4);
        const first = out.images.length + 1;
        let n = 0;
        for (const p of frames) {
          if (out.images.length >= MAX_IMAGES) break;
          const buf = await download(admin, p);
          if (!buf) continue;
          out.images.push({ mediaType: "image/jpeg", data: buf.toString("base64") });
          n++;
        }
        lines.push(`- Video: ${name}${len ? `, ${len} long` : ""}. ${n ? `Pictures ${first} to ${first + n - 1} are frames from it, in order (its sound isn't read).` : "No frames could be read: only its name and length are known."}`);
      } else {
        lines.push(`- Audio: ${name}${len ? `, ${len} long` : ""} (its sound isn't read: go by its name and what the team member says about it).`);
      }
    } catch {
      lines.push(`- ${KIND_WORD[f.kind]}: ${name} (couldn't be read)`);
    }
  }
  out.text = `<attached_files>\nThe team member added these files with their message. They're references for this same brief (they're kept on it): say in a line what to take from each, and use what you can see in them. Never claim to have seen or heard more than this.\n${lines.join("\n")}\n</attached_files>`;
  return out;
}
