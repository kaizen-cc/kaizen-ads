// Which creative formats someone works in, from their position (profiles.role), in one place. Everywhere the app
// suggests creative or lets someone request it, the formats shown fit the person: a graphic designer only sees and
// requests single images and carousels, a video editor only video, and everyone else (heads of creative, executives,
// media buyers, leads) both. Safe to import anywhere (server and client).

export type CreativeFormat = "image" | "carousel" | "video";

/** In the order the app shows them */
export const CREATIVE_FORMATS: readonly CreativeFormat[] = ["image", "carousel", "video"];

/** Someone, by role alone or as the signed-in staff member (an executive or a lead always sees every format) */
export type FormatViewer = string | null | undefined | { role: string; isExec?: boolean; isLead?: boolean };

const STILLS: readonly CreativeFormat[] = ["image", "carousel"];
const VIDEO: readonly CreativeFormat[] = ["video"];

/** The formats someone works in, in display order (serializable, to hand to the browser) */
export function formatList(who: FormatViewer): CreativeFormat[] {
  const role = typeof who === "string" ? who : (who?.role ?? null);
  if (who && typeof who === "object" && (who.isExec || who.isLead)) return [...CREATIVE_FORMATS];
  if (role === "graphic_designer") return [...STILLS];
  if (role === "video_editor") return [...VIDEO];
  return [...CREATIVE_FORMATS];
}

/** The formats someone works in */
export function formatsFor(who: FormatViewer): ReadonlySet<CreativeFormat> {
  return new Set(formatList(who));
}

type Allowed = ReadonlySet<CreativeFormat> | readonly CreativeFormat[];
const asSet = (a: Allowed): ReadonlySet<CreativeFormat> => (a instanceof Set ? a : new Set(a as readonly CreativeFormat[]));

/** Whether every format is open to them (nothing to hide) */
export function seesAllFormats(allowed: Allowed) {
  const s = asSet(allowed);
  return CREATIVE_FORMATS.every((f) => s.has(f));
}

/** A stored format word as one of ours ("single image", "Video", "carousel_ad" ...), or null when it can't be told */
export function normalizeFormat(format: string | null | undefined): CreativeFormat | null {
  const f = (format ?? "").toLowerCase();
  if (!f) return null;
  if (f.includes("carousel")) return "carousel";
  if (f.includes("video") || f.includes("reel")) return "video";
  if (f.includes("image") || f.includes("photo") || f.includes("static")) return "image";
  return null;
}

/** A market ad's format, from what Motion stored and its media (a video with no still is a video) */
export function marketFormatOf(a: { format: string | null; media: readonly { type: string }[] }): CreativeFormat {
  if (a.format === "carousel") return "carousel";
  if (a.format === "video" || (!a.media.some((m) => m.type === "image") && a.media[0]?.type === "video")) return "video";
  return "image";
}

/** A Hall of Fame ad's format, from its name and creative (the library has no format of its own) */
export function fameFormatOf(a: { adName?: string | null; creative: { video?: string | null } }): CreativeFormat {
  const name = a.adName ?? "";
  if (/carousel/i.test(name)) return "carousel";
  if (a.creative.video || /\b(video|vid|ugc|reel|vsl)\b/i.test(name)) return "video";
  return "image";
}

/** Whether one item's format fits. A format that can't be told (none stored) is kept: nothing says it doesn't fit. */
export function fitsFormat(allowed: Allowed, format: string | null | undefined) {
  const f = normalizeFormat(format);
  return f === null || asSet(allowed).has(f);
}

/** Whether something made of several formats has at least one that fits (none known: it fits) */
export function fitsAnyFormat(allowed: Allowed, formats: readonly (string | null | undefined)[] | null | undefined) {
  const known = (formats ?? []).map(normalizeFormat).filter((f): f is CreativeFormat => f !== null);
  return !known.length || known.some((f) => asSet(allowed).has(f));
}

/** A list with only what fits someone, read where it's loaded so the list isn't padded with hidden items */
export function filterByFormat<T>(items: readonly T[], allowed: Allowed, get: (item: T) => string | null | undefined | readonly (string | null | undefined)[]): T[] {
  if (seesAllFormats(allowed)) return [...items];
  return items.filter((it) => {
    const f = get(it);
    return Array.isArray(f) ? fitsAnyFormat(allowed, f) : fitsFormat(allowed, f as string | null | undefined);
  });
}

/** A request's formats kept to what someone can request; when none is left, one new piece in their first format */
export function clampFormats<T extends { format: CreativeFormat; new: number; variations: number }>(list: readonly T[], allowed: Allowed): T[] {
  const s = asSet(allowed);
  const kept = list.filter((f) => s.has(f.format));
  if (kept.length) return kept;
  const first = CREATIVE_FORMATS.find((f) => s.has(f)) ?? "image";
  return [{ format: first, new: 1, variations: 0 } as T];
}

/** The same for a request form's formats, kept by format (only the ones that fit stay) */
export function clampFormatRecord<V extends { new: number; variations: number }>(rec: Partial<Record<CreativeFormat, V>>, allowed: Allowed): Partial<Record<CreativeFormat, V>> {
  const s = asSet(allowed);
  const out: Partial<Record<CreativeFormat, V>> = {};
  for (const f of CREATIVE_FORMATS) if (rec[f] && s.has(f)) out[f] = rec[f];
  if (!Object.keys(out).length) {
    const first = CREATIVE_FORMATS.find((f) => s.has(f)) ?? "image";
    out[first] = { new: 1, variations: 0 } as V;
  }
  return out;
}

/** A request form's formats with only the ones someone can request (nothing added: they may not have picked yet) */
export function keepFormats<V>(rec: Partial<Record<CreativeFormat, V>>, allowed: Allowed): Partial<Record<CreativeFormat, V>> {
  const s = asSet(allowed);
  if (CREATIVE_FORMATS.every((f) => !rec[f] || s.has(f))) return rec;
  const out: Partial<Record<CreativeFormat, V>> = {};
  for (const f of CREATIVE_FORMATS) if (rec[f] && s.has(f)) out[f] = rec[f];
  return out;
}

/** The formats in a request someone can't request (to say what was left out, or that it's theirs only to read) */
export function formatsOutside(formats: readonly string[], allowed: Allowed): CreativeFormat[] {
  const s = asSet(allowed);
  return CREATIVE_FORMATS.filter((f) => formats.includes(f) && !s.has(f));
}

/** The first format someone works in, for a new request's starting format */
export function firstFormat(allowed: Allowed): CreativeFormat {
  const s = asSet(allowed);
  return CREATIVE_FORMATS.find((f) => s.has(f)) ?? "image";
}

/** What they work in, in words: "single images and carousels", "videos", or "every format" */
export function formatsPhrase(allowed: Allowed) {
  const s = asSet(allowed);
  if (seesAllFormats(s)) return "every format";
  const words: Record<CreativeFormat, string> = { image: "single images", carousel: "carousels", video: "videos" };
  const list = CREATIVE_FORMATS.filter((f) => s.has(f)).map((f) => words[f]);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : (list[0] ?? "every format");
}

/** For an AI prompt: the line that keeps what it suggests to the person's formats (empty when every format is open) */
export function formatsRule(allowed: Allowed) {
  if (seesAllFormats(allowed)) return "";
  const s = asSet(allowed);
  return `The person asking only makes ${formatsPhrase(s)}: every format you give must be one of ${CREATIVE_FORMATS.filter((f) => s.has(f))
    .map((f) => `"${f}"`)
    .join(", ")}. Never suggest any other format.`;
}
