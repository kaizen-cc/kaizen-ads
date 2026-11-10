// Files added to a brief in "Talk it through" and in its revise chat ("Tell me what to change"): pictures (JPEG, PNG,
// WebP), videos (MP4, MOV), audio (MP3, WAV, M4A) and PDFs. They live in the private brief-files bucket under the
// client's id (the browser uploads straight to a signed slot) and become references on the brief: an address in the
// app (/api/brief-files/<path>?name=...) that opens the file for anyone on the team and shows as a card with its
// picture. Pictures and PDFs are read by the AI as they are; a video by a few frames the browser takes, and audio by
// its name, length and the person's note. Pure: safe in the browser, tested in tests/brief-files.test.ts.

export const BRIEF_BUCKET = "brief-files";
export type BriefFileKind = "image" | "video" | "audio" | "pdf";

/** Up to this many files with one message */
export const MAX_BRIEF_FILES = 6;
/** Size caps per kind (pictures are read by the AI whole, so they stay small) */
export const BRIEF_FILE_MAX: Record<BriefFileKind, number> = { image: 10_000_000, pdf: 30_000_000, video: 300_000_000, audio: 50_000_000 };
/** What the file picker offers */
export const BRIEF_FILE_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,application/pdf,.jpg,.jpeg,.png,.webp,.mp4,.mov,.mp3,.wav,.m4a,.pdf";

/** The kind of a file from its type and name, or null when it isn't one we take */
export function briefFileKind(mime: string, name: string): BriefFileKind | null {
  const m = (mime || "").toLowerCase();
  const ext = (name.toLowerCase().split(".").pop() ?? "").trim();
  if (/^image\/(jpeg|jpg|png|webp)$/.test(m)) return "image";
  // Other pictures (GIF, HEIC) aren't taken: the AI and every browser read these three
  if (m.startsWith("image/")) return null;
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === "video/mp4" || m === "video/quicktime" || ["mp4", "mov"].includes(ext)) return "video";
  if (/^audio\/(mpeg|mp3|wav|x-wav|wave|mp4|x-m4a|m4a|aac)$/.test(m) || ["mp3", "wav", "m4a"].includes(ext)) return "audio";
  return null;
}

const MB = (n: number) => `${Math.round(n / 1_000_000)} MB`;

/** Why a file can't be added (its type or size), or null when it can */
export function briefFileProblem(f: { name: string; mime: string; bytes: number }): string | null {
  const kind = briefFileKind(f.mime, f.name);
  if (!kind) return `${f.name}: pictures (JPEG, PNG, WebP), videos (MP4, MOV), audio (MP3, WAV, M4A) and PDFs only.`;
  if (!(f.bytes > 0)) return `${f.name} is empty.`;
  if (f.bytes > BRIEF_FILE_MAX[kind]) return `${f.name} is too big (up to ${MB(BRIEF_FILE_MAX[kind])} for ${kind === "pdf" ? "a PDF" : kind === "audio" ? "audio" : `a ${kind}`}).`;
  return null;
}

/** A file added to a brief, as the browser keeps it and the server reads it */
export type BriefFile = {
  /** Its place in the bucket: <client id>/<batch>/<name> */
  path: string;
  name: string;
  mime: string;
  kind: BriefFileKind;
  bytes: number;
  /** A video's frames the browser took (paths in the bucket, the first is its picture) */
  frames?: string[];
  /** A video's or audio's length */
  seconds?: number | null;
};

/** A safe file name for the bucket */
export const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "").slice(-80) || "file";

/** Is this path one of this client's files (and nothing sneaky)? */
export const ownPath = (path: string, clientId: string) => typeof path === "string" && path.startsWith(`${clientId}/`) && !path.includes("..") && /^[\w./-]+$/.test(path) && path.length < 300;

/** The file's address in the app: what goes on the brief as a reference */
export function briefFileUrl(origin: string, f: Pick<BriefFile, "path" | "name" | "kind" | "frames">): string {
  const q = new URLSearchParams({ name: f.name.slice(0, 120), kind: f.kind });
  if (f.frames?.[0]) q.set("thumb", f.frames[0]);
  return `${origin.replace(/\/$/, "")}/api/brief-files/${f.path}?${q.toString()}`;
}

export type BriefFileRef = { path: string; name: string; kind: BriefFileKind; thumb: string | null };

/** A reference read back as a file: its path, name, kind and picture's path, or null when it isn't one */
export function parseBriefFileUrl(url: string): BriefFileRef | null {
  try {
    const u = new URL(url, "https://x.invalid");
    const m = /^\/api\/brief-files\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    const path = decodeURIComponent(m[1]);
    if (!/^[\w./-]+$/.test(path) || path.includes("..")) return null;
    const k = u.searchParams.get("kind");
    const name = u.searchParams.get("name") || path.split("/").pop() || "File";
    const kind: BriefFileKind = k === "image" || k === "video" || k === "audio" || k === "pdf" ? k : (briefFileKind("", name) ?? "pdf");
    const thumb = u.searchParams.get("thumb");
    return { path, name, kind, thumb: thumb && /^[\w./-]+$/.test(thumb) && !thumb.includes("..") ? thumb : null };
  } catch {
    return null;
  }
}

/** The address of one stored file (a picture, a video's frame) on the same origin as a reference */
export function briefFileSrc(url: string, path: string) {
  try {
    const u = new URL(url);
    return `${u.origin}/api/brief-files/${path}`;
  } catch {
    return `/api/brief-files/${path}`;
  }
}

export const KIND_WORD: Record<BriefFileKind, string> = { image: "Picture", video: "Video", audio: "Audio", pdf: "PDF" };

/** "0:42" */
export const clock = (s: number | null | undefined) => (s && s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/** A file reference as a card (no fetching: its name, what it is, its picture), or null when the link isn't a file */
export function briefFilePreview(url: string): { url: string; kind: "link"; title: string; subtitle: string; thumbnail: string | null; site: string; adId: null } | null {
  const f = parseBriefFileUrl(url);
  if (!f) return null;
  const thumbnail = f.kind === "image" ? url : f.kind === "video" && f.thumb ? briefFileSrc(url, f.thumb) : null;
  return { url, kind: "link", title: f.name, subtitle: KIND_WORD[f.kind], thumbnail, site: "Added file", adId: null };
}

/** How a file reads in a message's text, so the conversation keeps it ("[Video: launch.mov, 0:42]") */
export const fileMention = (f: Pick<BriefFile, "name" | "kind" | "seconds">) => `[${KIND_WORD[f.kind]}: ${f.name}${clock(f.seconds) ? `, ${clock(f.seconds)}` : ""}]`;
