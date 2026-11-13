import { createHash } from "node:crypto";
import { draws, slidesOf, type Allotment } from "@/lib/allotment";
import { ASSET_WORD, LIMITS, beatRows, copyOf, fileNamesFor, frameOf, hookOf, openingOf, parseBrief, slideRows, withCopyDirection, type Beat, type CopySet, type Frame, type SlideRow } from "@/lib/brief-spec";

export { beatSpan, pacing } from "@/lib/brief-spec";

// The brief PDF's content, as plain data: the brief in its one structure (src/lib/brief-spec.ts), the same for every
// format with only the build changing (a video's beats, a carousel's slides, a single image's frame), in two pages:
// the idea (the header, the strip, why it works and who it's for, the build) and the guardrails (the versions, Do and
// Don't, Your call, the copy, the assets and export, what to confirm). Nothing is cut with "…". A brief written in today's sections is read
// as it is, no AI; an older or free-text brief gets one fast AI pass in brief-pdf-data that fills only what its own
// sections don't say. Pure, so it's tested without a network; the drawing lives in brief-pdf.

export type PdfFormat = "image" | "video" | "carousel";
export type PdfCounts = { new: number; variations: number; cards?: number };

export type BriefBeat = Beat;
export type BriefSlide = SlideRow;
export type BriefFrame = Frame;

/** The brief as a production sheet. Cached on the draft (by key) so an export doesn't run the AI again. */
export type BriefStructure = {
  /** The idea and its payoff, in one sentence (never the copy direction) */
  oneLine: string;
  /** "Fallback: ..." when the concept hangs on the client: its first sentence, short, for the header */
  fallback: string;
  /** The rest of the fallback, under Confirm with client ("If not: ...") */
  fallbackMore?: string;
  /** The funnel stage ("Evergreen TOF") */
  stage: string;
  /** Why it works: the insight in one or two sentences, and where it comes from */
  why: string;
  whySource: string;
  /** Who it's for, one line */
  who: string;
  /** Video: about how long, and the music and voiceover in one line */
  length: string;
  audio: string;
  /** The build: a video's 4 to 6 beats, a carousel's slides, a single image's frame */
  beats: BriefBeat[];
  slides: BriefSlide[];
  frame: BriefFrame | null;
  /** What changes per version (the hook or the headline), one per version asked for, V1 first */
  versions: string[];
  must: string[];
  never: string[];
  yourCall: string;
  copy: CopySet;
  /** Asset groups, each with its Drive link at the end ("Need: ..." when we don't have it) */
  assets: string[];
  /** Restructured by the AI (true) or read plainly from the brief's own sections (false) */
  ai: boolean;
};

export type StructureSource = { title: string; angle: string; audience: string; brief: string; formats: Partial<Record<PdfFormat, PdfCounts>>; landing?: string | null };

// v4: nothing the brief holds is capped any more (every asset, Must, Never, copy line and question reaches the PDF)
const STRUCTURE_VERSION = "v4";

/** What the structure depends on: the same brief always gives the same key, any edit a new one */
export function structureKey(d: StructureSource) {
  const formats = (["image", "video", "carousel"] as const).map((f) => d.formats[f] ?? null);
  return createHash("sha1").update(JSON.stringify([STRUCTURE_VERSION, d.title, d.angle, d.audience, d.brief, formats, d.landing ?? ""])).digest("hex").slice(0, 24);
}

export const FORMAT_NAME: Record<PdfFormat, string> = { image: "Single image", video: "Video", carousel: "Carousel" };
const ORDER: PdfFormat[] = ["image", "video", "carousel"];
export const picked = (formats: Partial<Record<PdfFormat, PdfCounts>>) => ORDER.filter((f) => formats[f] && formats[f]!.new + formats[f]!.variations > 0);
/** A carousel's slides per version (0 when it isn't one) */
export const slidesFor = (formats: Partial<Record<PdfFormat, PdfCounts>>) => (formats.carousel ? slidesOf(formats.carousel.cards) : 0);
/** Versions asked for across the formats (one concept per brief) */
export const versionCount = (formats: Partial<Record<PdfFormat, PdfCounts>>) => picked(formats).reduce((n, f) => n + formats[f]!.new + formats[f]!.variations, 0);

/** "1 concept", "5 versions", "Single image", "4:5, 9:16" (a carousel adds its slides) */
export function formatChips(formats: Partial<Record<PdfFormat, PdfCounts>>, sizes: string[]) {
  const fs = picked(formats);
  const n = versionCount(formats);
  const chips = ["1 concept", `${n} version${n === 1 ? "" : "s"}`];
  for (const f of fs) chips.push(f === "carousel" ? `Carousel of ${slidesOf(formats.carousel?.cards)} slides` : FORMAT_NAME[f]);
  if (sizes.length) chips.push(sizes.map((z) => z.replace("x", ":")).join(", "));
  return chips;
}

/** The header line under the client: the stage, the format and the sizes ("Evergreen TOF · Video · 9:16") */
export function headerLine(formats: Partial<Record<PdfFormat, PdfCounts>>, sizes: string[], stage: string) {
  const fs = picked(formats).map((f) => (f === "carousel" ? `Carousel of ${slidesOf(formats.carousel?.cards)}` : FORMAT_NAME[f]));
  return [stage.trim(), fs.join(" + "), sizes.map((z) => z.replace("x", ":")).join(", ")].filter(Boolean);
}

/** What it takes from this month's allotment, and what's left after it ("Takes 5 of 20 images · 7 left after") */
export function allotmentDraw(formats: Partial<Record<PdfFormat, PdfCounts>>, a: Allotment | null | undefined) {
  const d = draws(formats);
  const parts: string[] = [];
  const pool = (n: number, cap: number | null | undefined, used: number, word: string) => {
    if (!n) return;
    if (cap == null) return void parts.push(`${n} ${word}${n === 1 ? "" : "s"}`);
    const after = cap - used - n;
    parts.push(`${n} of ${cap} ${word}s, ${after < 0 ? `${-after} over` : `${after} left after`}`);
  };
  pool(d.images, a?.images, a?.imagesUsed ?? 0, "image");
  pool(d.videos, a?.videos, a?.videosUsed ?? 0, "video");
  return parts.length ? `Takes ${parts.join(" · ")}` : null;
}

/** The strip's Versions: "3 · 3 of 5 videos this month" (over the allotment says so) */
export function versionsStrip(formats: Partial<Record<PdfFormat, PdfCounts>>, a: Allotment | null | undefined) {
  const n = versionCount(formats);
  const d = draws(formats);
  const month = (k: number, cap: number | null | undefined, used: number, word: string) => {
    if (!k || cap == null) return null;
    const after = cap - used - k;
    return `${k} of ${cap} ${word}s this month${after < 0 ? `, ${-after} over` : ""}`;
  };
  const parts = [month(d.videos, a?.videos, a?.videosUsed ?? 0, "video"), month(d.images, a?.images, a?.imagesUsed ?? 0, "image")].filter(Boolean);
  return [String(n), ...parts].join(" · ");
}

/** Business days from a day (New York), skipping weekends */
export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from.toLocaleString("en-US", { timeZone: "America/New_York" }));
  let n = 0;
  while (n < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return d;
}

// The Board's turnaround in business days (halved for urgent), the same as a ticket made here
const TURNAROUND: Record<PdfFormat, number> = { image: 2, video: 4, carousel: 2 };
export const MAKER_ROLE: Record<PdfFormat, { role: string; label: string }> = {
  image: { role: "graphic_designer", label: "designer" },
  carousel: { role: "graphic_designer", label: "designer" },
  video: { role: "video_editor", label: "video editor" },
};

/** When each format is due if it's sent today */
export function dueFor(f: PdfFormat, priority: string, now = new Date()) {
  const days = priority === "urgent" ? Math.max(1, Math.floor(TURNAROUND[f] / 2)) : TURNAROUND[f];
  return addBusinessDays(now, days);
}
export const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** The specs, safe zones and file names a maker checks before delivering (the export line says it in one line) */
export function specsChecklist(formats: Partial<Record<PdfFormat, PdfCounts>>, sizes: string[], client: string, title: string) {
  const fs = picked(formats);
  const out: string[] = [];
  const px: Record<string, string> = { "4x5": "4:5 at 1080 x 1350", "9x16": "9:16 at 1080 x 1920", "1x1": "1:1 at 1080 x 1080" };
  const list = sizes.map((z) => px[z.replace(":", "x")] ?? z).join(" and ");
  if (list) out.push(`Every version in ${list}${fs.includes("video") ? " (video: MP4, H.264, sound on and captions burned in)" : ""}`);
  if (sizes.some((z) => z.replace(":", "x") === "9x16")) out.push("9:16 safe zone: keep text, logo and faces out of the top 270 px and the bottom 670 px (Stories and Reels buttons)");
  if (sizes.some((z) => z.replace(":", "x") === "4x5")) out.push("4:5: nothing that matters within 60 px of the edges; text readable on a phone at arm's length");
  if (fs.includes("carousel")) out.push("Carousel: each slide works on its own, the first one stops the scroll, the last one asks for the click");
  // File names for every version, in the sizes this request makes, never one it doesn't (a "9:16 only" brief gets no
  // 4x5 name); a carousel's slides one by one
  const rows = fileNamesFor(fs, sizes, client, title, { versions: versionCount(formats), slides: slidesFor(formats) });
  const sized = rows.some((r) => r.names.length > 1);
  out.push(`File names: ${rows.map((r) => r.names.join(", ")).join("; ")}${sized ? " (sizes of one version share a name, so they upload as one design)" : ""}`);
  return out;
}

// ─── Reading the brief plainly (no AI, or when the AI can't run) ─────────────────────────────────

/** The brief's labelled sections ("Concepts:", "Hooks to try:") and the lines before them */
export function briefSections(brief: string) {
  const sections = new Map<string, string[]>();
  let head = "";
  const base: string[] = [];
  for (const raw of brief.split("\n")) {
    const line = raw.trim();
    const h = /^([A-Z][A-Za-z' /&-]{1,40}):\s*$/.exec(line);
    if (h) {
      head = h[1].toLowerCase();
      sections.set(head, []);
      continue;
    }
    if (!line) {
      if (head && sections.get(head)?.length) head = "";
      continue;
    }
    if (head) sections.get(head)!.push(line);
    else base.push(line);
  }
  return { base, sections };
}

const clean = (s: string) => s.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
// Text is never cut with "…" (the owner, Nov 11 2026: show every field in full; the PDF wraps it a step smaller)
const cut = (s: string) => s.replace(/\s*\u2014\s*/g, ", ").replace(/\s+/g, " ").trim();
const asset = (a: { item: string; status: keyof typeof ASSET_WORD }) => (a.status === "have" ? a.item : `${ASSET_WORD[a.status]}: ${a.item}`);

/**
 * The brief read as it's written: a brief in today's sections fills every part from its own lines; an older one gives
 * what it can (its concepts and hooks as versions, its do and don't lines, its copy lines).
 */
export function plainStructure(d: StructureSource): BriefStructure {
  const p = parseBrief(d.brief);
  const sp = p.spec;
  const { sections } = briefSections(p.overview || d.brief);
  // Older briefs: "Concepts:" with Hook / Visual / Copy lines, and "Hooks to try:"
  const concepts: { name: string; hook: string; visual: string; copy: string }[] = [];
  for (const line of sections.get("concepts") ?? []) {
    if (/^\d+[.)]\s+/.test(line)) concepts.push({ name: clean(line), hook: "", visual: "", copy: "" });
    else if (concepts.length) {
      const c = concepts[concepts.length - 1];
      const m = /^(Hook|Visual|Copy):\s*(.+)$/i.exec(line);
      if (m) c[m[1].toLowerCase() as "hook" | "visual" | "copy"] = m[2].trim();
    }
  }
  const hooks = (sections.get("hooks to try") ?? sections.get("hooks") ?? []).map(clean).filter(Boolean);
  const n = Math.max(1, versionCount(d.formats));
  const own = sp.versions.filter(Boolean);
  const versions = Array.from({ length: n }, (_, i) => cut(own[i] ?? (i === 0 ? hookOf(sp) : "") ?? "") || cut(hooks[i] ?? concepts[i]?.hook ?? (i === 0 ? concepts[0]?.copy || concepts[0]?.name || "" : "")));

  // Must and Never: the brief's own lists, or (an older free-text brief) its do and don't lines
  const all = d.brief.split("\n").map(clean).filter(Boolean);
  const looseNever = all.filter((l) => /^(don'?t|do not|never|avoid|no )\b/i.test(l));
  const looseMust = all.filter((l) => /^(do|always|make sure|use|show|keep)\b/i.test(l) && !looseNever.includes(l));
  const structured = p.structured;
  // An older brief's Constraints join Must, but not its sizes and safe zones (the export line says those once)
  const constraints = sp.constraints.filter((x) => !/(?<![\d.])\d{1,2}\s?[:x×]\s?\d{1,2}(?!\d)|safe zone|\bpx\b|\bsizes?\b|file names?/i.test(x));
  // Every line the brief holds (two pages is the writer's guide, flagged by the lint; the PDF never drops one)
  const must = (structured ? [...sp.dos, ...constraints] : looseMust).map((x) => cut(x));
  const never = (structured ? sp.donts : looseNever).map((x) => cut(x));

  const pick = (re: RegExp) => all.map((l) => re.exec(l)?.[1]?.trim()).filter((x): x is string => Boolean(x));
  // Copy direction a writer put in the opening fills what the Copy section leaves empty
  const opening = openingOf(p.overview || d.brief);
  const ownCopy = withCopyDirection(copyOf(sp.copy), opening.copy);
  const copy: CopySet = ownCopy.primary.length || ownCopy.headlines.length || ownCopy.cta ? ownCopy : { primary: pick(/^primary text:\s*(.+)$/i).slice(0, LIMITS.primary), headlines: pick(/^headlines?:\s*(.+)$/i).slice(0, LIMITS.headlines), cta: pick(/^cta:\s*(.+)$/i)[0] ?? "" };

  // The idea in one sentence (the first of the opening, never its copy direction or Fallback), the fallback short
  const cards = slidesFor(d.formats);
  const frame = frameOf(sp.frame);
  const hasFrame = Boolean(frame.headline || frame.subline || frame.shows || frame.readsFirst || frame.cta);
  return {
    oneLine: cut(opening.idea || d.angle || d.title),
    fallback: cut(opening.fallback),
    fallbackMore: cut(opening.fallbackMore),
    stage: cut(sp.stage),
    why: cut(sp.insight),
    whySource: cut(sp.insightSource),
    who: cut(sp.who || d.audience),
    length: cut(sp.length),
    audio: cut(sp.audio),
    beats: d.formats.video ? beatRows(sp) : [],
    slides: cards ? slideRows(sp).slice(0, cards) : [],
    frame: d.formats.image ? (hasFrame ? frame : versions[0] ? { headline: versions[0], subline: "", shows: "", readsFirst: "", cta: "" } : null) : null,
    versions,
    must,
    never,
    yourCall: cut(sp.yourCall),
    copy,
    assets: sp.assets.length ? sp.assets.map(asset) : [...(sections.get("assets") ?? []), ...(sections.get("what to use") ?? [])].map(clean),
    ai: false,
  };
}

/** The brief already says everything the format needs (no AI pass to make) */
export function needsStructure(s: BriefStructure, d: StructureSource) {
  if (!s.why || !s.oneLine) return true;
  if (d.formats.video && !s.beats.length) return true;
  if (d.formats.carousel && s.slides.length < 2) return true;
  if (d.formats.image && !s.frame?.headline) return true;
  return false;
}

/**
 * The AI's answer fitted to the brief: what the brief's own sections say always wins (it's what was reviewed); the AI
 * only fills what they leave empty. What the brief holds is kept whole; only what the AI adds is capped (5 Must, 5 Never,
 * 4 to 6 beats, 5 assets), the rows the request asks for (never more).
 */
export function fitStructure(raw: Partial<BriefStructure> | null | undefined, d: StructureSource, ai: boolean): BriefStructure {
  const plain = plainStructure(d);
  const t = (s: unknown) => (typeof s === "string" ? cut(s) : "");
  const list = (xs: unknown, n: number) => (Array.isArray(xs) ? xs.map((x) => t(x)).filter(Boolean).slice(0, n) : []);
  const n = Math.max(1, versionCount(d.formats));
  const rv = Array.isArray(raw?.versions) ? raw!.versions : [];
  const versions = Array.from({ length: n }, (_, i) => plain.versions[i] || t(rv[i]));
  const beat = (b: Partial<BriefBeat>): BriefBeat => ({ time: t(b?.time), name: t(b?.name), onScreen: t(b?.onScreen), text: t(b?.text), says: t(b?.says), source: t(b?.source) });
  const beats = plain.beats.length ? plain.beats : d.formats.video && Array.isArray(raw?.beats) ? raw!.beats.map(beat).filter((b) => b.name || b.onScreen || b.says || b.text).slice(0, LIMITS.beats) : [];
  const cards = slidesFor(d.formats);
  const slide = (s: Partial<BriefSlide>): BriefSlide => ({ job: t(s?.job), headline: t(s?.headline), shows: t(s?.shows) });
  const slides = plain.slides.length >= 2 ? plain.slides : cards && Array.isArray(raw?.slides) ? raw!.slides.map(slide).filter((s) => s.headline || s.shows).slice(0, cards) : plain.slides;
  const rf = raw?.frame as Partial<BriefFrame> | null | undefined;
  const aiFrame: BriefFrame | null = d.formats.image && rf ? { headline: t(rf.headline), subline: t(rf.subline), shows: t(rf.shows), readsFirst: t(rf.readsFirst), cta: t(rf.cta) } : null;
  // The frame field by field: the brief's own (or V1's line as its headline) wins, the AI fills the empty ones
  const pf = plain.frame;
  const frame: BriefFrame | null = !pf ? (aiFrame?.headline ? aiFrame : null) : aiFrame ? { headline: pf.headline || aiFrame.headline, subline: pf.subline || aiFrame.subline, shows: pf.shows || aiFrame.shows, readsFirst: pf.readsFirst || aiFrame.readsFirst, cta: pf.cta || aiFrame.cta } : pf;
  const rc = raw?.copy as Partial<CopySet> | undefined;
  const hasCopy = plain.copy.primary.length || plain.copy.headlines.length || plain.copy.cta;
  const or = <T,>(a: T[], b: T[]) => (a.length ? a : b);
  return {
    oneLine: plain.oneLine && plain.oneLine !== cut(d.title) ? plain.oneLine : openingOf(t(raw?.oneLine)).idea || plain.oneLine,
    fallback: plain.fallback,
    fallbackMore: plain.fallbackMore ?? "",
    stage: plain.stage || t(raw?.stage),
    why: plain.why || t(raw?.why),
    whySource: plain.why ? plain.whySource : t(raw?.whySource),
    who: plain.who || t(raw?.who),
    length: plain.length || (d.formats.video ? t(raw?.length) : ""),
    audio: plain.audio || (d.formats.video ? t(raw?.audio) : ""),
    beats,
    slides,
    frame,
    versions,
    must: or(plain.must, list(raw?.must, LIMITS.must)),
    never: or(plain.never, list(raw?.never, LIMITS.never)),
    yourCall: plain.yourCall || t(raw?.yourCall),
    copy: hasCopy ? plain.copy : { primary: list(rc?.primary, LIMITS.primary), headlines: list(rc?.headlines, LIMITS.headlines), cta: t(rc?.cta) },
    assets: or(plain.assets, list(raw?.assets, LIMITS.assets)),
    ai,
  };
}

/** The JSON shape the AI fills: small and flat (one level of objects in arrays, no enums) */
export const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    oneLine: { type: "string" },
    stage: { type: "string" },
    why: { type: "string" },
    whySource: { type: "string" },
    who: { type: "string" },
    length: { type: "string" },
    audio: { type: "string" },
    beats: {
      type: "array",
      items: { type: "object", properties: { time: { type: "string" }, name: { type: "string" }, onScreen: { type: "string" }, text: { type: "string" }, says: { type: "string" }, source: { type: "string" } }, required: ["time", "name", "onScreen", "text", "says", "source"], additionalProperties: false },
    },
    slides: { type: "array", items: { type: "object", properties: { job: { type: "string" }, headline: { type: "string" }, shows: { type: "string" } }, required: ["job", "headline", "shows"], additionalProperties: false } },
    frame: { type: "object", properties: { headline: { type: "string" }, subline: { type: "string" }, shows: { type: "string" }, readsFirst: { type: "string" }, cta: { type: "string" } }, required: ["headline", "subline", "shows", "readsFirst", "cta"], additionalProperties: false },
    versions: { type: "array", items: { type: "string" } },
    must: { type: "array", items: { type: "string" } },
    never: { type: "array", items: { type: "string" } },
    yourCall: { type: "string" },
    copy: {
      type: "object",
      properties: { primary: { type: "array", items: { type: "string" } }, headlines: { type: "array", items: { type: "string" } }, cta: { type: "string" } },
      required: ["primary", "headlines", "cta"],
      additionalProperties: false,
    },
    assets: { type: "array", items: { type: "string" } },
  },
  required: ["oneLine", "stage", "why", "whySource", "who", "length", "audio", "beats", "slides", "frame", "versions", "must", "never", "yourCall", "copy", "assets"],
  additionalProperties: false,
} as const;
