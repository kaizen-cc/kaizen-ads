import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";

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
};

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MAX_BYTES = 4_500_000;

export function kindOf(name: string, mime: string): CallUpload["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/\.(docx|xlsx|pptx)$/i.test(name)) return "doc";
  return "text";
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
