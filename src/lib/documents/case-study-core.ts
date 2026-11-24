// A client case study: a client-ready PDF in Kaizen's own case-study look (src/lib/documents/case-study.tsx), separate
// from the SOW and proposal template. Made to be sent to prospects and the client: the wins with their numbers, the
// story of how we got there, charts of the months, never a price, a placeholder or next steps. Pure: what a case study
// may hold and the clean-up that keeps it so; the look's palette is code here too, so it can be changed on request.

export const KAIZEN_ACCENT = "#e11d2e";

/** The look's colours: a dark, high-contrast page with one accent (Kaizen red unless asked otherwise) */
export type CaseStudyPalette = { bg: string; panel: string; ink: string; muted: string; line: string; accent: string; accentSoft: string };

export function paletteFor(accent?: string | null): CaseStudyPalette {
  const a = /^#[0-9a-f]{6}$/i.test(String(accent ?? "").trim()) ? String(accent).trim().toLowerCase() : KAIZEN_ACCENT;
  return { bg: "#0b0b0d", panel: "#151519", ink: "#f5f4f2", muted: "#9a978f", line: "#2a2a30", accent: a, accentSoft: `${a}33` };
}

export type CaseStudyStat = { value: string; label: string; note: string };
export type CaseStudyPoint = { label: string; value: number };
export type CaseStudyChart = { title: string; kind: "bar" | "line"; unit: "$" | "%" | "x" | ""; points: CaseStudyPoint[]; note: string };

export type CaseStudy = {
  client: string;
  /** "Crust Pizza: 4.2x return on ad spend in 90 days" */
  title: string;
  subtitle: string;
  /** "Jun to Nov 2026" */
  period: string;
  industry: string;
  /** Two or three sentences: who they are and what changed */
  summary: string;
  challenge: string;
  approach: string[];
  results: CaseStudyStat[];
  charts: CaseStudyChart[];
  highlights: string[];
  quote: { text: string; by: string } | null;
  accent: string;
};

const line = (v: unknown, n: number) => {
  const t = String(v ?? "")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
};
const list = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v : []).map((x) => line(x, n)).filter(Boolean).slice(0, max);

/** Anything that reads as a price or an unfinished figure never goes in a case study */
const PRICEY = /\b(price to confirm|tbd|tbc|\[.*?\]|per month retainer|retainer|\/mo\b|a month for|pricing)\b/i;
const NEXT_STEPS = /^(next steps?|what'?s next|recommendations? for next)/i;

/**
 * A case study as written by the agent, made safe to send: lengths kept, no prices, placeholders or next steps,
 * charts with real numbers only (at least two points each), the accent a real colour.
 */
export function cleanCaseStudy(raw: unknown, opts: { client: string | null }): CaseStudy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const charts = (Array.isArray(r.charts) ? r.charts : [])
    .map((c): CaseStudyChart => {
      const o = (c ?? {}) as Record<string, unknown>;
      const unit = ["$", "%", "x"].includes(String(o.unit)) ? (String(o.unit) as CaseStudyChart["unit"]) : "";
      const points = (Array.isArray(o.points) ? o.points : [])
        .map((p) => ({ label: line((p as Record<string, unknown>)?.label, 14), value: Number((p as Record<string, unknown>)?.value) }))
        .filter((p) => p.label && Number.isFinite(p.value))
        .slice(0, 12);
      return { title: line(o.title, 70), kind: o.kind === "line" ? "line" : "bar", unit, points, note: line(o.note, 140) };
    })
    .filter((c) => c.title && c.points.length >= 2)
    .slice(0, 4);
  const results = (Array.isArray(r.results) ? r.results : [])
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return { value: line(o.value, 14), label: line(o.label, 40), note: line(o.note, 90) };
    })
    .filter((s) => s.value && s.label && !PRICEY.test(`${s.value} ${s.label} ${s.note}`))
    .slice(0, 4);
  const clean = (xs: string[]) => xs.filter((x) => !PRICEY.test(x) && !NEXT_STEPS.test(x));
  const q = (r.quote ?? null) as Record<string, unknown> | null;
  return {
    client: line(r.client ?? opts.client, 80) || opts.client || "",
    title: line(r.title, 110),
    subtitle: line(r.subtitle, 160),
    period: line(r.period, 60),
    industry: line(r.industry, 60),
    summary: PRICEY.test(String(r.summary ?? "")) ? "" : line(r.summary, 600),
    challenge: PRICEY.test(String(r.challenge ?? "")) ? "" : line(r.challenge, 500),
    approach: clean(list(r.approach, 6, 220)),
    results,
    charts,
    highlights: clean(list(r.highlights, 6, 200)),
    quote: q && line(q.text, 300) ? { text: line(q.text, 300), by: line(q.by, 80) } : null,
    accent: paletteFor(r.accent as string | null).accent,
  };
}

/** Enough to send: a title, a story and at least one number */
export const caseStudyReady = (c: CaseStudy) => Boolean(c.title && (c.summary || c.challenge) && (c.results.length || c.charts.length));

export const caseStudyFileName = (c: CaseStudy) =>
  `${`${c.client} case study`
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()}.pdf`;
