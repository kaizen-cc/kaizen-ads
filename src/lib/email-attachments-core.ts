// Email attachments for the AI's Gmail reads (issue #159): which files an email thread carries, which of them the model
// can look at (pictures: screenshots, photos), and a tool answer that carries those pictures to the model as images.
// Plain helpers with no keys or network, so they're tested on their own.

export type ToolImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ToolImage = { name: string; mediaType: ToolImageType; data: string };

/**
 * Where a tool's answer keeps its pictures. A symbol, so JSON.stringify never writes the base64 into a text answer
 * (any loop that doesn't know about pictures just drops them), while spreads and wrappers carry it through.
 */
export const TOOL_IMAGES: unique symbol = Symbol.for("kaizen.toolImages");

/** A tool answer with pictures the model is shown alongside it */
export function withImages<T extends object>(out: T, images: readonly ToolImage[]): T {
  if (!images.length) return out;
  return Object.assign({}, out, { [TOOL_IMAGES]: [...images] });
}

export function imagesOf(out: unknown): ToolImage[] {
  if (!out || typeof out !== "object") return [];
  const got = (out as { [TOOL_IMAGES]?: unknown })[TOOL_IMAGES];
  return Array.isArray(got) ? (got as ToolImage[]) : [];
}

/** A tool_result's content: the text alone, or each picture (named) then the text when the answer carries pictures */
export function toolResultContent(out: unknown, text: string): string | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: ToolImageType; data: string } })[] {
  const images = imagesOf(out);
  if (!images.length) return text;
  return [
    ...images.flatMap((im) => [
      { type: "text" as const, text: `Attachment: ${im.name}` },
      { type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } },
    ]),
    { type: "text" as const, text },
  ];
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

export type AttachmentPart = { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: AttachmentPart[] };

export type EmailAttachment = { messageId: string; from: string; name: string; mime: string; size: number; attachmentId: string | null; data: string | null };

/** At most this many pictures go to the model per thread (the biggest: screenshots over logos) */
export const MAX_EMAIL_IMAGES = 5;
/** The model takes pictures up to 5 MB as base64, so about 3.7 MB of file */
export const MAX_EMAIL_IMAGE_BYTES = 3_700_000;
/** Smaller than this is a signature logo, an icon or a tracking pixel, not something sent to be seen */
export const MIN_EMAIL_IMAGE_BYTES = 4_000;

const IMAGE_EXT: Record<string, ToolImageType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The picture type the model can read, from the file's type or its name; null for anything else (PDF, HEIC, docs) */
export function imageType(mime: string, name: string): ToolImageType | null {
  const m = mime.toLowerCase().replace("image/jpg", "image/jpeg");
  if (m === "image/png" || m === "image/jpeg" || m === "image/gif" || m === "image/webp") return m;
  if (m && m !== "application/octet-stream") return null;
  return IMAGE_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? null;
}

/** Every file in one email (attachments and pictures pasted into it), in the order they appear */
export function attachmentsOf(messageId: string, from: string, part: AttachmentPart): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  const walk = (p: AttachmentPart) => {
    if (p.filename && (p.body?.attachmentId || p.body?.data)) {
      out.push({ messageId, from, name: p.filename, mime: p.mimeType ?? "", size: Number(p.body?.size ?? 0), attachmentId: p.body?.attachmentId ?? null, data: p.body?.data ?? null });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return out;
}

export type AttachmentPlan = { look: EmailAttachment[]; listed: { name: string; from: string; note: string | null; attachment: EmailAttachment }[] };

/**
 * Which files are looked at (the biggest pictures, up to MAX_EMAIL_IMAGES) and what's said about each of the rest:
 * a file the model can't open says so plainly, so it tells the person instead of guessing what's in it.
 */
export function planAttachments(all: readonly EmailAttachment[]): AttachmentPlan {
  const pictures = all.filter((a) => imageType(a.mime, a.name) && a.size >= MIN_EMAIL_IMAGE_BYTES && a.size <= MAX_EMAIL_IMAGE_BYTES);
  const look = [...pictures].sort((a, b) => b.size - a.size).slice(0, MAX_EMAIL_IMAGES);
  const seen = new Set(look);
  const listed = all
    .filter((a) => !(imageType(a.mime, a.name) && a.size > 0 && a.size < MIN_EMAIL_IMAGE_BYTES))
    .map((a) => ({
      name: a.name,
      from: a.from,
      attachment: a,
      note: seen.has(a)
        ? null
        : imageType(a.mime, a.name)
          ? a.size > MAX_EMAIL_IMAGE_BYTES
            ? "Too big to look at here: ask them to share their screen or upload a smaller copy."
            : `Not looked at: only the ${MAX_EMAIL_IMAGES} biggest pictures in a thread are shown.`
          : "Can't be opened from an email here (only pictures can): ask them to upload it in the chat to read it.",
    }));
  return { look, listed };
}

/** Gmail's base64url to the plain base64 the model takes */
export const base64FromUrl = (data: string) => data.replace(/-/g, "+").replace(/_/g, "/");

type FileLine = { name: string; from: string; seen: boolean; note?: string };

/** What a thread read says about its files: each one by name, seen or why not, and how to talk about them */
export function attachmentFields(files: { attachments: FileLine[] } | null): { attachments?: FileLine[]; attachments_note?: string } {
  if (!files?.attachments.length) return {};
  const seen = files.attachments.filter((f) => f.seen).length;
  return {
    attachments: files.attachments,
    attachments_note: `${seen ? `The ${seen === 1 ? "picture" : `${seen} pictures`} marked seen ${seen === 1 ? "is" : "are"} shown to you with this answer: look at ${seen === 1 ? "it" : "them"} and use what ${seen === 1 ? "it shows" : "they show"}. ` : ""}Name the files you looked at, and say plainly which ones you couldn't open and why (never guess what's in them).`,
  };
}
