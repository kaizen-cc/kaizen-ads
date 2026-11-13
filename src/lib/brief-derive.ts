import { detectClientFacts } from "./brief-facts";
import { holdsWork } from "./brief-spec";

// The PDF's and the sheet's headings, derived from what the brief says instead of fixed: a "Confirm with client" line
// that blocks the work is shown as a blocker (never under "doesn't hold the work"), "only the hook changes" appears
// only when every version really shares the body (otherwise each version says what else changes), and every line is
// shown as the brief holds it, word for word. Pure: the same in the PDF (src/lib/brief-pdf.tsx) and on screen
// (src/components/brief-sheet.tsx), tested in tests/brief-derive.test.ts.

export type ConfirmItem = {
  /** The question as the brief holds it (a "Blocker:" prefix taken off, nothing else changed) */
  text: string;
  /** It blocks the work: it says so, it's about clearance, rights or approval, or the ad's claim hangs on it */
  blocker: boolean;
};

const BLOCKER_PREFIX = /^\s*(?:blocker|blocks?(?: the work)?|critical|must confirm)\s*[:\-–]\s*/i;
/** Clearance, rights, releases and approval: the clip or the claim can't run without it */
const CLEARANCE = /\b(?:clear(?:ed|ance)|approv(?:e|ed|al)|rights|right to use|licen[cs](?:e|ed|ing)|releases?|permission|consent|legal(?:ly)?|compliance|sign(?:ed)?[- ]off)\b/i;

/**
 * Each open question to confirm, classified. claims: the words the ad says (the hook, the versions, the beats, the
 * copy): a question about a number or an offer those words state is one the ad can't run without.
 */
export function confirmItems(questions: string[], claims = ""): ConfirmItem[] {
  const stated = new Set(detectClientFacts(claims).filter((f) => f.kind === "stat" || f.kind === "offer").map((f) => f.phrase.toLowerCase()));
  // One item per question, in order (an empty one stays empty, for the caller to drop)
  return questions
    .map((q) => q.trim())
    .map((q) => {
      const prefixed = BLOCKER_PREFIX.test(q);
      const text = q.replace(BLOCKER_PREFIX, "").trim();
      const claim = [...stated].some((p) => text.toLowerCase().includes(p));
      return { text, blocker: prefixed || holdsWork(text) || CLEARANCE.test(text) || claim };
    });
}

/** The two headings, each only when it has a line under it */
export const CONFIRM_HEAD = { blockers: "Blocker · confirm before it runs", open: "Confirm with client · doesn't hold the work" } as const;

// ─── Versions: what really changes ────────────────────────────────────────

export type VersionLine = { num: string; line: string; also: string };

/** A version's line read: its words, and what else it changes ("| Also changes: the clip in beat 3") */
export function versionLines(versions: string[]): VersionLine[] {
  return versions.map((raw, i) => {
    const m = /^(.*?)\s*\|\s*(?:also changes|changes|body|also)\s*:\s*(.+)$/i.exec(raw.trim());
    return { num: `V${i + 1}`, line: (m ? m[1] : raw).trim(), also: (m ? m[2] : "").trim() };
  });
}

// A version line that names a different body, footage, photo or slides (not "same body")
const BODY_WORDS: Record<"video" | "image" | "carousel", RegExp> = {
  video: /\b(?:body|middle|beats?|story(?:line)?|script|voice ?over|testimonial|demo|footage|clips?|scenes?|b-?roll|ending|end card|structure)\b/i,
  image: /\b(?:photo|picture|image|background|layout|design|scene|product shot|visual)\b/i,
  carousel: /\b(?:slides?|order|sequence|photos?|images?|layout|design|story)\b/i,
};
const SAME = /\b(?:same|identical|unchanged|shared)\s+(?:\w+\s+){0,2}(?:body|beats?|footage|clips?|photo|picture|image|design|layout|slides?|story|edit|frame)\b|\b(?:as|like)\s+V\d{1,2}\b/i;

/**
 * Whether the versions share their body, and the note the versions' heading carries: "only the hook changes" only when
 * that's true, else what changes per version. word: what the line is ("hook" for a video, "headline" otherwise).
 */
/**
 * A single image's versions (as src/lib/brief-cards.ts imageVersions reads them): "only the headline changes" only when
 * V1 is the one net new design and every other version keeps its design and photo; otherwise each card says what.
 */
export function imageVersionNote(vs: { kind: string; shows: string }[]) {
  if (vs.length < 2) return null;
  const netNew = vs.filter((v) => v.kind === "Net new").length;
  const onlyHeadline = netNew <= 1 && vs.every((v) => v.kind === "Net new" || /^Same design and photo as V\d+$/i.test(v.shows.trim()));
  return onlyHeadline ? "only the headline changes; V1 is net new" : "what changes is on each card; V1 is net new";
}

export function versionChange(versions: string[], format: "video" | "image" | "carousel") {
  const rows = versionLines(versions);
  const word = format === "video" ? "hook" : "headline";
  const changes = rows.map((r) => {
    if (r.also) return r.also;
    if (!r.line) return "";
    if (SAME.test(r.line)) return "";
    // A quoted line is the words on screen: what's outside the quotes is what it runs on
    const outside = r.line.replace(/[“"][^”"]*[”"]/g, " ");
    return BODY_WORDS[format].test(outside) && /[“"]/.test(r.line) ? outside.replace(/\((?:net[- ]new|new|variation[^)]*)\)/gi, "").replace(/\s+/g, " ").replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim() : "";
  });
  const shared = changes.every((c) => !c);
  const note =
    rows.length < 2 ? null : shared ? `only the ${word} changes; V1 is net new` : format === "image" ? `the ${word} and what's in the frame change; each version says what; V1 is net new` : `each version changes more than the ${word}: what else changes is on its card; V1 is net new`;
  return { shared, note, rows: rows.map((r, i) => ({ ...r, also: changes[i] })) };
}
