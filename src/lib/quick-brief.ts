import type { SuggestionDraft, TalkTurn, WinnerSource } from "@/lib/suggestions";

// The quick preview a brief starts from: before the strategist writes the whole brief (a couple of minutes), a short
// summary in a few seconds (the concept, angle, audience, hook, what gets made and why it fits), which the person can
// change line by line. The full brief is then written from it, so it follows their edits. Safe to import anywhere.

export type QuickFormat = { format: "image" | "video" | "carousel"; new: number; variations: number };

export type QuickBrief = {
  title: string;
  concept: string;
  angle: string;
  audience: string;
  hook: string;
  formats: QuickFormat[];
  /** Why it fits this client now */
  why: string;
  /** Anything the person adds for the strategist */
  note: string;
};

/** What a brief can be started from. Serializable, so it can travel to the server and into a background job. */
export type BriefSource =
  | { kind: "winner"; winner: WinnerSource; format?: QuickFormat["format"] }
  | { kind: "market"; adId: string; format?: QuickFormat["format"] }
  | { kind: "pattern"; patternId: string }
  | { kind: "refresh"; adId: string }
  /** A brief already written (a suggested brief): its summary shows at once */
  | { kind: "suggestion"; id: string }
  | { kind: "promise"; commitmentId: string }
  /** An idea in words (an audit's creative idea, a note): label says where it came from */
  | { kind: "idea"; label: string; text: string }
  /** "Talk it through": the conversation so far */
  | { kind: "talk"; turns: TalkTurn[] };

export const FORMAT_WORD: Record<QuickFormat["format"], [string, string]> = { image: ["image", "images"], video: ["video", "videos"], carousel: ["carousel", "carousels"] };

/** "2 new images + 1 variation · 1 new video" */
export function makingLine(formats: QuickFormat[]) {
  return (
    formats
      .filter((f) => f.new + f.variations > 0)
      .map((f) => {
        const word = FORMAT_WORD[f.format][f.new === 1 ? 0 : 1];
        const v = f.variations ? ` + ${f.variations} ${f.variations === 1 ? "variation" : "variations"}` : "";
        return f.new ? `${f.new} new ${word}${v}` : `${f.variations} ${f.variations === 1 ? "variation" : "variations"} (${FORMAT_WORD[f.format][1]})`;
      })
      .join(" · ") || "Nothing picked yet"
  );
}

/** A brief already written, one summary per distinct concept (one concept per brief): no AI, shown at once */
export function quickFromDraftAll(d: SuggestionDraft, why = ""): QuickBrief[] {
  const own = (d.concepts ?? []).filter((c) => c.format && (c.new ?? 0) + (c.variations ?? 0) > 0);
  if ((d.concepts ?? []).length < 2) return [quickFromDraft(d, why)];
  return d.concepts.map((c) => ({
    title: c.name.slice(0, 80),
    concept: `${c.visual}`.slice(0, 400),
    angle: d.angle ?? "",
    audience: d.audience ?? "",
    hook: c.hook ?? "",
    formats: own.length === d.concepts.length ? [{ format: c.format!, new: c.new ?? 0, variations: c.variations ?? 0 }] : (d.formats ?? []).slice(0, 1).map((f) => ({ format: f.format, new: 1, variations: 0 })),
    why: why.slice(0, 400),
    note: "",
  }));
}

/** The summary of a brief that's already written: no AI, shown at once */
export function quickFromDraft(d: SuggestionDraft, why = ""): QuickBrief {
  const first = d.concepts?.[0];
  const firstLine = (s: string) => s.split(/\n+/).map((x) => x.trim()).find(Boolean) ?? "";
  return {
    title: d.title ?? "",
    // A summary's concept is already the one line; a written brief's is its name and what it shows
    concept: first ? (d.summary ? first.visual : `${first.name}: ${first.visual}`).slice(0, 400) : firstLine(d.brief ?? "").slice(0, 400),
    angle: d.angle ?? "",
    audience: d.audience ?? "",
    hook: first?.hook ?? d.hooks?.[0] ?? "",
    formats: (d.formats ?? []).map((f) => ({ format: f.format, new: f.new, variations: f.variations })),
    why: why.slice(0, 400),
    note: "",
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Did the person change anything from the summary they were shown? */
export function quickEdited(was: QuickBrief, now: QuickBrief) {
  if (norm(now.note)) return true;
  const keys = ["title", "concept", "angle", "audience", "hook", "why"] as const;
  if (keys.some((k) => norm(was[k]) !== norm(now[k]))) return true;
  const fmt = (x: QuickFormat[]) =>
    x
      .filter((f) => f.new + f.variations > 0)
      .map((f) => `${f.format}:${f.new}:${f.variations}`)
      .sort()
      .join("|");
  return fmt(was.formats) !== fmt(now.formats);
}

/** The agreed direction, for the prompt that writes the full brief */
export function seedBlock(seed: QuickBrief | null | undefined) {
  if (!seed) return "";
  return `

<agreed_direction>
A person on the team previewed a short summary of this brief and agreed this direction (they may have edited any line). Build the full brief on it: keep its concept, angle, audience, hook and exactly these formats and counts, and follow their note. One concept per brief (this overrides any instruction above to write several): draft.concepts has exactly one entry, this concept, and its versions are the counts below. Only change something when it would break a hard rule (client memory, an "avoid" item, the allotment, what Meta rejects), and then say so in the brief.
Title: ${seed.title || "(yours to write)"}
Concept: ${seed.concept || "(yours to write)"}
Angle: ${seed.angle || "(yours to write)"}
Audience: ${seed.audience || "(yours to write)"}
Hook: ${seed.hook || "(yours to write)"}
Making: ${makingLine(seed.formats)}
Why it fits: ${seed.why || "(yours to write)"}${norm(seed.note) ? `\nTheir note: ${seed.note.trim()}` : ""}
</agreed_direction>`;
}

/** The full brief held to what was agreed: the formats and counts the person set, and their title */
export function applySeed<T extends { title: string; formats: QuickFormat[] }>(draft: T, seed: QuickBrief | null | undefined): T {
  if (!seed) return draft;
  const formats = seed.formats.filter((f) => f.new + f.variations > 0);
  return { ...draft, title: seed.title.trim() ? seed.title.trim().slice(0, 80) : draft.title, formats: formats.length ? formats : draft.formats };
}
