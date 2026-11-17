// The deck Kaizen AI makes (make_deck): what a slide may hold, and the pure clean-up that keeps every slide readable on
// a 16:9 page at 14 points or more. The model fills the loose shape below; clean() turns it into the strict one the
// document draws, cutting what wouldn't fit rather than shrinking the type.

export const SLIDE_KINDS = ["cover", "section", "bullets", "two_column", "stats", "quote", "image_notes", "scorecard"] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];
export type Tone = "good" | "watch" | "bad";

export type LooseSlide = {
  kind?: string;
  title?: string;
  text?: string;
  bullets?: string[];
  left?: { heading?: string; bullets?: string[] };
  right?: { heading?: string; bullets?: string[] };
  stats?: { value?: string; label?: string; note?: string }[];
  by?: string;
  image?: string;
  caption?: string;
  rows?: { label?: string; tone?: string; note?: string }[];
};

export type Column = { heading: string; bullets: string[] };
export type Slide =
  | { kind: "cover"; title: string; text: string }
  | { kind: "section"; title: string; text: string }
  | { kind: "bullets"; title: string; bullets: string[] }
  | { kind: "two_column"; title: string; left: Column; right: Column }
  | { kind: "stats"; title: string; stats: { value: string; label: string; note: string }[]; text: string }
  | { kind: "quote"; title: string; text: string; by: string }
  | { kind: "image_notes"; title: string; image: string | null; caption: string; bullets: string[] }
  | { kind: "scorecard"; title: string; rows: { label: string; tone: Tone; note: string }[] };

export const MAX_SLIDES = 30;

/** Plain text cut at a word, with an ellipsis, to at most n characters */
export function clip(v: unknown, n: number): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-]+$/, "")}…`;
}

const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v : []).map((x) => clip(x, each)).filter(Boolean).slice(0, max);

/** The tone a verdict row is drawn in: good (green), bad (red), anything else is watch (amber) */
export function toneOf(v: unknown): Tone {
  const t = String(v ?? "").toLowerCase();
  if (/^(good|green|pass|ok|strong|yes)/.test(t)) return "good";
  if (/^(bad|red|fail|no|weak|stop)/.test(t)) return "bad";
  return "watch";
}

/** One slide, strict. Null when it has nothing to show. */
export function cleanSlide(raw: LooseSlide): Slide | null {
  const kind = (SLIDE_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as SlideKind) : raw.bullets?.length ? "bullets" : "section";
  const title = clip(raw.title, 52);
  const column = (c: LooseSlide["left"]): Column => ({ heading: clip(c?.heading, 40), bullets: list(c?.bullets, 4, 96) });
  switch (kind) {
    case "cover":
      return title ? { kind, title, text: clip(raw.text, 140) } : null;
    case "section":
      return title ? { kind, title, text: clip(raw.text, 160) } : null;
    case "bullets": {
      const bullets = list(raw.bullets, 5, 110);
      return title || bullets.length ? { kind, title, bullets } : null;
    }
    case "two_column": {
      const left = column(raw.left);
      const right = column(raw.right);
      return left.bullets.length || right.bullets.length ? { kind, title, left, right } : null;
    }
    case "stats": {
      const stats = (raw.stats ?? [])
        .map((s) => ({ value: clip(s.value, 12), label: clip(s.label, 40), note: clip(s.note, 80) }))
        .filter((s) => s.value)
        .slice(0, 4);
      return stats.length ? { kind, title, stats, text: clip(raw.text, 160) } : null;
    }
    case "quote": {
      const text = clip(raw.text, 260);
      return text ? { kind, title, text, by: clip(raw.by, 60) } : null;
    }
    case "image_notes": {
      const bullets = list(raw.bullets, 4, 100);
      return raw.image || bullets.length ? { kind, title, image: raw.image ? String(raw.image).trim() : null, caption: clip(raw.caption, 60), bullets } : null;
    }
    case "scorecard": {
      const rows = (raw.rows ?? [])
        .map((r) => ({ label: clip(r.label, 26), tone: toneOf(r.tone), note: clip(r.note, 90) }))
        .filter((r) => r.label)
        .slice(0, 5);
      return rows.length ? { kind, title, rows } : null;
    }
  }
}

/** The slides, strict, in order, at most MAX_SLIDES. A deck with no cover gets one from its title and subtitle. */
export function cleanSlides(raw: unknown, deckTitle: string, subtitle: string): Slide[] {
  const slides = (Array.isArray(raw) ? raw : []).map((s) => cleanSlide((s ?? {}) as LooseSlide)).filter((s): s is Slide => Boolean(s));
  if (slides[0]?.kind !== "cover") slides.unshift({ kind: "cover", title: clip(deckTitle, 90), text: clip(subtitle, 140) });
  return slides.slice(0, MAX_SLIDES);
}

/** The attached picture a slide names: by its file name (any case), or its position ("1", "2") among the attached pictures. */
export function pickImage<T extends { name: string; kind: string }>(files: T[], want: string | null): T | null {
  if (!want) return null;
  const pics = files.filter((f) => f.kind === "image");
  const w = want.trim().toLowerCase();
  const byName = pics.find((f) => f.name.toLowerCase() === w) ?? pics.find((f) => f.name.toLowerCase().includes(w));
  if (byName) return byName;
  const n = Number(w);
  return Number.isInteger(n) && n >= 1 && n <= pics.length ? pics[n - 1] : null;
}

/** A file name for the PDF: "OceanBox creative assessment" becomes "OceanBox-creative-assessment.pdf" */
export function deckFileName(title: string): string {
  const base = title.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "deck"}.pdf`;
}
