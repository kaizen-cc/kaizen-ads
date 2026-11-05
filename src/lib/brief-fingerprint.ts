import { keepFormats, type CreativeFormat } from "@/lib/creative-formats";
import type { AiSource, AiStamp, Draft } from "@/app/(team)/requests/new/draft";

// A brief written entirely by the AI (a quick preview's full brief, a suggested brief, talked through, Kaizen AI) and
// sent as it was skips the AI review: it's the AI's own work. Any change to what the review reads (title, angle,
// audience, formats and versions, sizes, landing page, references, brief, copy) brings the review back. Whitespace and
// pure reordering aren't changes, and editing it back to how it was counts as unchanged. The same code runs in the
// form (the quiet line, skipping the review) and on the server (which recomputes it from the stored AI version).

type Fields = Pick<Draft, "title" | "angle" | "audience" | "formats" | "sizes" | "landing" | "refs" | "brief" | "migration">;
type Allowed = ReadonlySet<CreativeFormat> | readonly CreativeFormat[];

/** The fields an AI patch leaves out, as an empty request has them */
const BLANK: Fields = { title: "", angle: "", audience: "", formats: {}, sizes: ["4x5", "9x16"], landing: "", refs: "", brief: "" };

const text = (s: unknown) => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
const num = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));

/** The reviewable fields in a stable form: whitespace collapsed, lists sorted */
export function canonicalDraft(d: Partial<Fields>): string {
  const formats = Object.entries(d.formats ?? {})
    .filter(([, c]) => Boolean(c))
    .map(([f, c]) => `${f}:${num(c!.new)}+${num(c!.variations)}${f === "carousel" ? `x${num(c!.cards ?? 5)}` : ""}`)
    .sort();
  const sizes = [...new Set(d.sizes ?? [])].sort();
  const refs = (d.refs ?? "").split(/\s+/).filter(Boolean).sort();
  return JSON.stringify([
    text(d.title),
    text(d.angle),
    text(d.audience),
    formats,
    sizes,
    text(d.landing),
    refs,
    text(d.brief),
    text(d.migration?.copy),
    text(d.migration?.creativeLink),
  ]);
}

/** cyrb53: a quick, stable 53-bit string hash (the same in the browser and on the server) */
function hash(s: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The fingerprint of a request's reviewable fields */
export const fingerprintDraft = (d: Partial<Fields>) => hash(canonicalDraft(d));

/** The fingerprint of what the AI wrote: its fields on an empty request, kept to the formats this person requests (as the form keeps them) */
export const aiFingerprint = (patch: Partial<Draft>, allowed: Allowed) => fingerprintDraft({ ...BLANK, ...patch, formats: keepFormats(patch.formats ?? {}, allowed) });

/** The stamp an AI-written brief carries into the form */
export const stampAi = (patch: Partial<Draft>, source: AiSource, allowed: Allowed): AiStamp => ({ source, fingerprint: aiFingerprint(patch, allowed) });

/** Written by the AI and not changed since (edited back to how it was counts as unchanged) */
export const aiUnedited = (d: Partial<Draft>) => Boolean(d.ai?.fingerprint) && fingerprintDraft(d) === d.ai!.fingerprint;
