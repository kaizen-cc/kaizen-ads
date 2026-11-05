// What the media connectors can make, shared by the server and the screens (no keys, no calls): the Higgsfield
// models with the fields each one takes, ElevenLabs' voice settings and models, and the checks that keep what's
// sent inside what each provider accepts.

import { worksAs } from "./roles";

// ─── Roles ──────────────────────────────────────────────────────────────────

/** Who can spend credits: the creative team (designers, editors, copywriters), leads and execs. Everyone else views. */
export function canGenerateMedia(s: { isExec: boolean; isLead: boolean; isCreative: boolean; isCopywriter: boolean; role: string }) {
  return s.isExec || s.isLead || s.isCreative || s.isCopywriter || worksAs(s.role, "head_of_creative", "graphic_designer", "video_editor", "copywriter");
}

// ─── ElevenLabs ─────────────────────────────────────────────────────────────

export type VoiceSettings = { stability: number; similarityBoost: number; style: number; speed: number; speakerBoost: boolean };
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true };

export const VO_MODELS = [
  { id: "eleven_multilingual_v2", label: "Multilingual v2", about: "The most natural read; best for finished voiceovers" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5", about: "Fast and half the characters' cost; good for drafts" },
  { id: "eleven_flash_v2_5", label: "Flash v2.5", about: "Fastest; for quick timing checks" },
] as const;
export type VoModel = (typeof VO_MODELS)[number]["id"];
export const DEFAULT_VO_MODEL: VoModel = "eleven_multilingual_v2";

/** The longest text one voiceover takes (ElevenLabs' own limit is higher; a 60s ad is ~900 characters) */
export const MAX_VO_CHARS = 5000;

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const x = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Settings from a slider or the AI, kept inside what ElevenLabs takes (0–1; speed 0.7–1.2) */
export function clampVoiceSettings(s: Partial<Record<keyof VoiceSettings, unknown>> | null | undefined): VoiceSettings {
  const d = DEFAULT_VOICE_SETTINGS;
  return {
    stability: round2(clamp(s?.stability, 0, 1, d.stability)),
    similarityBoost: round2(clamp(s?.similarityBoost, 0, 1, d.similarityBoost)),
    style: round2(clamp(s?.style, 0, 1, d.style)),
    speed: round2(clamp(s?.speed, 0.7, 1.2, d.speed)),
    speakerBoost: typeof s?.speakerBoost === "boolean" ? s.speakerBoost : d.speakerBoost,
  };
}

export const voModelOf = (m: unknown): VoModel => (VO_MODELS.some((x) => x.id === m) ? (m as VoModel) : DEFAULT_VO_MODEL);

/** Text ready to read: trimmed, whitespace tidied, within the limit (or an error to show) */
export function voText(text: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const t = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return { ok: false, error: "Write or paste the voiceover first." };
  if (t.length > MAX_VO_CHARS) return { ok: false, error: `That's ${t.length.toLocaleString("en-US")} characters; a voiceover takes up to ${MAX_VO_CHARS.toLocaleString("en-US")}. Split it in two.` };
  return { ok: true, text: t };
}

/** The voiceover lines in a video script: the chosen hook's spoken line, then each beat's VO, in order */
export function voFromScript(s: { hooks?: { spoken?: string | null }[]; beats?: { voiceover?: string | null }[]; cta?: string | null } | null | undefined, hook = 0): string {
  if (!s) return "";
  const lines: string[] = [];
  const h = s.hooks?.[hook]?.spoken?.trim();
  if (h) lines.push(h);
  for (const b of s.beats ?? []) {
    const v = b.voiceover?.replace(/^\s*(VO|Voiceover)\s*:\s*/i, "").trim();
    if (v && v !== h && !/^(none|n\/a|-|—)$/i.test(v)) lines.push(v);
  }
  return lines.join("\n");
}

// ─── Higgsfield ─────────────────────────────────────────────────────────────

type Field =
  | { key: string; type: "enum"; options: readonly string[]; default: string; label: string }
  | { key: string; type: "int"; min: number; max: number; default: number; label: string; step?: number }
  | { key: string; type: "bool"; default: boolean; label: string };

export type HfModel = {
  key: string;
  label: string;
  kind: "image" | "video";
  /** The path after https://api.higgsfield.ai */
  path: string;
  about: string;
  /** How a reference image is sent: not at all, as image_url (required or optional), or as image_urls[] */
  reference: "none" | "image_url" | "image_url_required" | "image_urls";
  /** The same model's text-only path, used when no reference image is given (image-to-video needs one) */
  textPath?: string;
  promptRequired: boolean;
  fields: Field[];
  /** Typical time to finish, for the progress bar until real runs are logged */
  typicalMs: number;
};

const SOUL_RATIOS = ["9:16", "3:4", "2:3", "1:1", "4:3", "3:2", "16:9"] as const;
const SEEDANCE_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"] as const;

export const HF_MODELS: HfModel[] = [
  {
    key: "soul-v2",
    label: "Soul",
    kind: "image",
    path: "/higgsfield-ai/soul/v2/standard",
    about: "Photoreal people and lifestyle shots; the everyday choice",
    reference: "none",
    promptRequired: true,
    typicalMs: 45_000,
    fields: [
      { key: "aspect_ratio", type: "enum", options: SOUL_RATIOS, default: "9:16", label: "Shape" },
      { key: "resolution", type: "enum", options: ["720p", "1080p"], default: "1080p", label: "Resolution" },
      { key: "batch_size", type: "enum", options: ["1", "4"], default: "1", label: "Images" },
      { key: "enhance_prompt", type: "bool", default: true, label: "Improve the prompt" },
    ],
  },
  {
    key: "soul-cinema",
    label: "Soul Cinema",
    kind: "image",
    path: "/higgsfield-ai/soul/cinema",
    about: "Film-still look: moody light, depth, story",
    reference: "none",
    promptRequired: true,
    typicalMs: 50_000,
    fields: [
      { key: "aspect_ratio", type: "enum", options: SOUL_RATIOS, default: "9:16", label: "Shape" },
      { key: "resolution", type: "enum", options: ["720p", "1080p"], default: "1080p", label: "Resolution" },
      { key: "batch_size", type: "enum", options: ["1", "4"], default: "1", label: "Images" },
    ],
  },
  {
    key: "marketing-image",
    label: "Marketing Studio",
    kind: "image",
    path: "/marketing-studio/image",
    about: "Product and ad visuals; give it the product photo as a reference",
    reference: "image_urls",
    promptRequired: true,
    typicalMs: 60_000,
    fields: [
      { key: "aspect_ratio", type: "enum", options: ["9:16", "3:4", "1:1", "4:3", "16:9", "auto"], default: "9:16", label: "Shape" },
      { key: "resolution", type: "enum", options: ["1k", "2k", "4k"], default: "2k", label: "Resolution" },
    ],
  },
  {
    key: "seedance-2",
    label: "Seedance 2.0",
    kind: "video",
    path: "/bytedance/seedance-2.0/image-to-video",
    textPath: "/bytedance/seedance-2.0/text-to-video",
    about: "Realistic motion with sound; animates a reference image or works from the prompt alone",
    reference: "image_url",
    promptRequired: false,
    typicalMs: 240_000,
    fields: [
      { key: "duration", type: "int", min: 4, max: 15, default: 5, label: "Seconds" },
      { key: "resolution", type: "enum", options: ["480p", "720p", "1080p"], default: "720p", label: "Resolution" },
      { key: "aspect_ratio", type: "enum", options: SEEDANCE_RATIOS, default: "9:16", label: "Shape (prompt only)" },
      { key: "generate_audio", type: "bool", default: true, label: "Sound" },
    ],
  },
  {
    key: "kling-2.5",
    label: "Kling 2.5 Turbo",
    kind: "video",
    path: "/kling-video/v2.5-turbo/pro/image-to-video",
    textPath: "/kling-video/v2.5-turbo/pro/text-to-video",
    about: "Fast, punchy motion for product and UGC-style shots",
    reference: "image_url",
    promptRequired: true,
    typicalMs: 180_000,
    fields: [{ key: "duration", type: "enum", options: ["5", "10"], default: "5", label: "Seconds" }],
  },
];

export const hfModel = (key: unknown) => HF_MODELS.find((m) => m.key === key) ?? null;

export const MAX_PROMPT_CHARS = 2500;

/**
 * The body and path for one Higgsfield request: only the fields that model takes, each inside what it accepts
 * (anything else falls back to its default). A reference image picks the image path when the model has one.
 */
export function hfRequest(
  modelKey: string,
  input: { prompt?: string | null; options?: Record<string, unknown> | null; referenceUrl?: string | null },
): { ok: true; path: string; body: Record<string, unknown>; model: HfModel } | { ok: false; error: string } {
  const m = hfModel(modelKey);
  if (!m) return { ok: false, error: "Pick a model." };
  const prompt = String(input.prompt ?? "").trim();
  const ref = input.referenceUrl?.trim() || null;
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `Keep the prompt under ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.` };
  if (!prompt && (m.promptRequired || !ref)) return { ok: false, error: "Write a prompt first." };
  if (m.reference === "image_url_required" && !ref) return { ok: false, error: `${m.label} needs a reference image.` };
  const useText = m.reference === "image_url" && !ref && Boolean(m.textPath);
  const body: Record<string, unknown> = {};
  if (prompt) body.prompt = prompt;
  const opts = input.options ?? {};
  for (const f of m.fields) {
    // Image-to-video takes its shape from the picture; the aspect ratio only applies to prompt-only video
    if (f.key === "aspect_ratio" && m.kind === "video" && !useText) continue;
    const v = opts[f.key];
    if (f.type === "enum") {
      const s = v == null ? f.default : String(v);
      const val = f.options.includes(s) ? s : f.default;
      body[f.key] = /^\d+$/.test(val) && (f.key === "batch_size" || f.key === "duration") ? Number(val) : val;
    } else if (f.type === "int") body[f.key] = Math.round(clamp(v, f.min, f.max, f.default));
    else body[f.key] = typeof v === "boolean" ? v : f.default;
  }
  if (ref && m.reference === "image_urls") body.image_urls = [ref];
  if (ref && (m.reference === "image_url" || m.reference === "image_url_required")) body.image_url = ref;
  return { ok: true, path: useText ? m.textPath! : m.path, body, model: m };
}

/** Higgsfield's request states, in ours */
export function hfStatus(s: unknown): "queued" | "running" | "ready" | "failed" | "canceled" {
  switch (s) {
    case "queued":
      return "queued";
    case "in_progress":
      return "running";
    case "completed":
      return "ready";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "failed";
  }
}

/** The result files in a finished Higgsfield request (images, a video, sometimes audio) */
export function hfOutputs(r: { images?: { url?: string }[] | null; video?: { url?: string } | null; audio?: { url?: string } | null } | null | undefined): { url: string; kind: "image" | "video" | "audio" }[] {
  const out: { url: string; kind: "image" | "video" | "audio" }[] = [];
  for (const i of r?.images ?? []) if (i?.url) out.push({ url: i.url, kind: "image" });
  if (r?.video?.url) out.push({ url: r.video.url, kind: "video" });
  if (r?.audio?.url) out.push({ url: r.audio.url, kind: "audio" });
  return out;
}

// ─── Shared ─────────────────────────────────────────────────────────────────

export type MediaJobStatus = "queued" | "running" | "ready" | "failed" | "canceled";
export type MediaFile = { path: string; mime: string; bytes: number; url?: string | null };
/** One generation, as the screens show it */
export type MediaJob = {
  id: string;
  provider: "elevenlabs" | "higgsfield" | "motion";
  kind: "voiceover" | "image" | "video" | "reference";
  model: string | null;
  title: string | null;
  status: MediaJobStatus;
  error: string | null;
  files: MediaFile[];
  prompt: string | null;
  requestId: string | null;
  clientId: string | null;
  client: string | null;
  by: string | null;
  mine: boolean;
  attached: boolean;
  driveNote: string | null;
  characters: number | null;
  credits: number | null;
  expectedMs: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  seen: boolean;
};

export const extOf = (mime: string) =>
  mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("gif") ? "gif" : mime.includes("mp4") ? "mp4" : mime.includes("quicktime") ? "mov" : "bin";

/** A file name people recognise: what it is, the client and the time */
export function mediaFileName(kind: string, client: string | null, at: Date, n: number, mime: string) {
  const slug = (client ?? "kaizen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "kaizen";
  const stamp = at.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${slug}-${kind}-${stamp}${n > 1 ? `-${n}` : ""}.${extOf(mime)}`;
}
