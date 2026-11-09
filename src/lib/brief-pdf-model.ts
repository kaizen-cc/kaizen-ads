import { createHash } from "node:crypto";
import { draws, slidesOf, type Allotment } from "@/lib/allotment";

// The brief PDF's content, as plain data: what the request asks for (chips, due, who makes it, what it takes from the
// allotment), the brief restructured into what a maker reads at a glance (the idea in 30 seconds, one row per version or
// slide, dos and don'ts, copy, assets), the specs checklist and the next step. Pure, so it's tested without a network;
// the AI pass that restructures a brief lives in brief-pdf-data, and the drawing in brief-pdf.

export type PdfFormat = "image" | "video" | "carousel";
export type PdfCounts = { new: number; variations: number; cards?: number };

export type BriefVersion = { headline: string; subline: string; visual: string; hook: string };
export type BriefSlide = { headline: string; subline: string; visual: string };

/** The brief as a production sheet. Cached on the draft (by key) so an export doesn't run the AI again. */
export type BriefStructure = {
  /** The idea in one line */
  oneLine: string;
  /** The idea in 30 seconds: what, for whom, why it should work, what to avoid (3 to 5) */
  summary: string[];
  /** One per version, V1 first */
  versions: BriefVersion[];
  /** A carousel's slides in order (empty otherwise) */
  slides: BriefSlide[];
  dos: string[];
  donts: string[];
  copy: { primary: string[]; headlines: string[]; cta: string };
  /** What it's made from, and what to get from the client */
  assets: string[];
  /** Restructured by the AI (true) or read plainly from the brief's own sections (false) */
  ai: boolean;
};

export type StructureSource = { title: string; angle: string; audience: string; brief: string; formats: Partial<Record<PdfFormat, PdfCounts>>; landing?: string | null };

const STRUCTURE_VERSION = "v1";

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

/** The checklist every maker ticks before delivering */
export function specsChecklist(formats: Partial<Record<PdfFormat, PdfCounts>>, sizes: string[], client: string, title: string) {
  const fs = picked(formats);
  const out: string[] = [];
  const px: Record<string, string> = { "4x5": "4:5 at 1080 x 1350", "9x16": "9:16 at 1080 x 1920", "1x1": "1:1 at 1080 x 1080" };
  const list = sizes.map((z) => px[z.replace(":", "x")] ?? z).join(" and ");
  if (list) out.push(`Every version in ${list}${fs.includes("video") ? " (video: MP4, H.264, sound on and captions burned in)" : ""}`);
  if (sizes.some((z) => z.replace(":", "x") === "9x16")) out.push("9:16 safe zone: keep text, logo and faces out of the top 270 px and the bottom 670 px (Stories and Reels buttons)");
  if (sizes.some((z) => z.replace(":", "x") === "4x5")) out.push("4:5: nothing that matters within 60 px of the edges; text readable on a phone at arm's length");
  if (fs.includes("carousel")) out.push("Carousel: each slide works on its own, the first one stops the scroll, the last one asks for the click");
  const stem = `${client}_${title}`.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Client_Concept";
  // File names in the sizes this request makes, never one it doesn't (a "9:16 only" brief gets no 4x5 name)
  const keys = sizes.map((z) => z.replace(":", "x")).filter((z) => z === "4x5" || z === "9x16");
  const names = (keys.length ? keys : ["4x5", "9x16"]).map((k) => `${stem}_V1_${k}`);
  out.push(`File names: ${names.join(", ")}${names.length > 1 ? " (sizes of one version share a name, so they upload as one design)" : ""}`);
  out.push("Deliver on the ticket in Kaizen Ads with every size together, then run the AI review before internal review");
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
const sentence = (s: string, max = 180) => {
  const t = s.replace(/\s+/g, " ").trim();
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
};

export function plainStructure(d: StructureSource): BriefStructure {
  const { base, sections } = briefSections(d.brief);
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
  const versions: BriefVersion[] = Array.from({ length: n }, (_, i) => {
    const c = concepts[i] ?? (i === 0 ? concepts[0] : undefined);
    return { headline: c?.copy || c?.name || "", subline: "", visual: c?.visual || (i > 0 ? "A variation of V1" : ""), hook: c?.hook || hooks[i] || "" };
  });
  const all = d.brief.split("\n").map(clean).filter(Boolean);
  const donts = all.filter((l) => /^(don'?t|do not|never|avoid|no )\b/i.test(l)).slice(0, 6);
  const dos = all.filter((l) => /^(do|always|make sure|use|show|keep)\b/i.test(l) && !donts.includes(l)).slice(0, 6);
  const pick = (re: RegExp) => all.map((l) => re.exec(l)?.[1]?.trim()).filter((x): x is string => Boolean(x));
  const lead = base.join(" ");
  const summary = [lead && sentence(lead, 220), d.audience && `For ${sentence(d.audience, 160).replace(/^for\s+/i, "")}`, d.angle && `The angle: ${sentence(d.angle, 160)}`, donts[0] && `Avoid: ${donts[0].replace(/^(don'?t|do not|never|avoid)\s+/i, "")}`].filter((x): x is string => Boolean(x));
  const slides: BriefSlide[] = d.formats.carousel ? Array.from({ length: slidesOf(d.formats.carousel.cards) }, () => ({ headline: "", subline: "", visual: "" })) : [];
  return {
    oneLine: sentence(lead || d.angle || d.title, 170),
    summary: summary.slice(0, 5),
    versions,
    slides,
    dos,
    donts,
    copy: { primary: pick(/^primary text:\s*(.+)$/i), headlines: pick(/^headlines?:\s*(.+)$/i), cta: pick(/^cta:\s*(.+)$/i)[0] ?? "" },
    assets: [...(sections.get("assets") ?? []), ...(sections.get("what to use") ?? [])].map(clean).slice(0, 6),
    ai: false,
  };
}

/** The AI's answer made safe to draw: trimmed, capped, the rows the request asks for (never more, never fewer) */
export function fitStructure(raw: Partial<BriefStructure> | null | undefined, d: StructureSource, ai: boolean): BriefStructure {
  const plain = plainStructure(d);
  const t = (s: unknown, max = 400) => (typeof s === "string" ? s.replace(/\s*\u2014\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const list = (xs: unknown, n: number, max = 260) => (Array.isArray(xs) ? xs.map((x) => t(x, max)).filter(Boolean).slice(0, n) : []);
  const n = Math.max(1, versionCount(d.formats));
  const rv = Array.isArray(raw?.versions) ? raw!.versions : [];
  const versions = Array.from({ length: n }, (_, i) => {
    const v = (rv[i] ?? {}) as Partial<BriefVersion>;
    const p = plain.versions[i];
    return { headline: t(v.headline, 160) || p.headline, subline: t(v.subline, 200), visual: t(v.visual, 360) || p.visual, hook: t(v.hook, 200) || p.hook };
  });
  const cards = d.formats.carousel ? slidesOf(d.formats.carousel.cards) : 0;
  const rs = Array.isArray(raw?.slides) ? raw!.slides : [];
  const slides = Array.from({ length: cards }, (_, i) => {
    const s = (rs[i] ?? {}) as Partial<BriefSlide>;
    return { headline: t(s.headline, 160), subline: t(s.subline, 200), visual: t(s.visual, 300) };
  });
  const summary = list(raw?.summary, 5, 240);
  return {
    oneLine: t(raw?.oneLine, 200) || plain.oneLine,
    summary: summary.length >= 2 ? summary : plain.summary,
    versions,
    slides,
    dos: list(raw?.dos, 6).length ? list(raw?.dos, 6) : plain.dos,
    donts: list(raw?.donts, 6).length ? list(raw?.donts, 6) : plain.donts,
    copy: { primary: list(raw?.copy?.primary, 3, 600), headlines: list(raw?.copy?.headlines, 5, 120), cta: t(raw?.copy?.cta, 40) },
    assets: list(raw?.assets, 6, 200),
    ai,
  };
}

/** The JSON shape the AI fills */
export const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    oneLine: { type: "string" },
    summary: { type: "array", items: { type: "string" } },
    versions: {
      type: "array",
      items: { type: "object", properties: { headline: { type: "string" }, subline: { type: "string" }, visual: { type: "string" }, hook: { type: "string" } }, required: ["headline", "subline", "visual", "hook"], additionalProperties: false },
    },
    slides: {
      type: "array",
      items: { type: "object", properties: { headline: { type: "string" }, subline: { type: "string" }, visual: { type: "string" } }, required: ["headline", "subline", "visual"], additionalProperties: false },
    },
    dos: { type: "array", items: { type: "string" } },
    donts: { type: "array", items: { type: "string" } },
    copy: {
      type: "object",
      properties: { primary: { type: "array", items: { type: "string" } }, headlines: { type: "array", items: { type: "string" } }, cta: { type: "string" } },
      required: ["primary", "headlines", "cta"],
      additionalProperties: false,
    },
    assets: { type: "array", items: { type: "string" } },
  },
  required: ["oneLine", "summary", "versions", "slides", "dos", "donts", "copy", "assets"],
  additionalProperties: false,
} as const;
