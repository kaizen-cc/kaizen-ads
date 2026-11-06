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
  /** Who it's for: one of the Brand Bible's avatars by name (src/lib/bible-sections.ts avatarsOf), or a new one under test */
  avatar?: string;
  /** The avatar isn't in the Bible yet: this brief tests it */
  avatarTest?: boolean;
  /** Links the person added as references (any page: Motion, Pinterest, Instagram, TikTok, the Ads Library, YouTube) */
  refs?: string[];
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
  /** "Talk it through": the conversation so far, and the preview as it stands (refined, never rewritten from scratch) */
  | { kind: "talk"; turns: TalkTurn[]; current?: QuickBrief | null; refs?: string[]; /** Refine current by what was said since (otherwise it's shown as it is) */ refine?: boolean };

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
    avatar: d.avatar ?? "",
    avatarTest: Boolean(d.avatarTest),
    refs: d.refs ?? [],
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
    avatar: d.avatar ?? "",
    avatarTest: Boolean(d.avatarTest),
    refs: d.refs ?? [],
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Did the person change anything from the summary they were shown? */
export function quickEdited(was: QuickBrief, now: QuickBrief) {
  if (norm(now.note)) return true;
  const keys = ["title", "concept", "angle", "audience", "hook", "why"] as const;
  if (keys.some((k) => norm(was[k]) !== norm(now[k]))) return true;
  if (norm(was.avatar ?? "") !== norm(now.avatar ?? "") || Boolean(was.avatarTest) !== Boolean(now.avatarTest)) return true;
  if ((was.refs ?? []).join(" ") !== (now.refs ?? []).join(" ")) return true;
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
Avatar: ${seed.avatar?.trim() ? `${seed.avatar.trim()}${seed.avatarTest ? " (a NEW avatar under test, not in the Brand Bible yet: write for it, and say in the brief that it's an avatar test)" : " (from the Brand Bible: keep it exactly, as draft.avatar)"}` : "(pick one from the Brand Bible's audience profiles, by name)"}
Angle: ${seed.angle || "(yours to write)"}
Audience: ${seed.audience || "(yours to write)"}
Hook: ${seed.hook || "(yours to write)"}
Making: ${makingLine(seed.formats)}
Why it fits: ${seed.why || "(yours to write)"}${norm(seed.note) ? `\nTheir note: ${seed.note.trim()}` : ""}${seed.refs?.length ? `\nReferences they added (keep every one in draft.refs and say what to take from each): ${seed.refs.join(" ")}` : ""}
</agreed_direction>`;
}

/** The full brief held to what was agreed: the formats and counts the person set, their title, avatar and references */
export function applySeed<T extends { title: string; formats: QuickFormat[]; refs?: string[]; avatar?: string; avatarTest?: boolean }>(draft: T, seed: QuickBrief | null | undefined): T {
  if (!seed) return draft;
  const formats = seed.formats.filter((f) => f.new + f.variations > 0);
  const refs = [...new Set([...(seed.refs ?? []), ...(draft.refs ?? [])].filter((u) => /^https?:\/\/\S+$/i.test(u)))].slice(0, 10);
  return {
    ...draft,
    title: seed.title.trim() ? seed.title.trim().slice(0, 80) : draft.title,
    formats: formats.length ? formats : draft.formats,
    ...(refs.length ? { refs } : {}),
    ...(seed.avatar?.trim() ? { avatar: seed.avatar.trim().slice(0, 80), avatarTest: Boolean(seed.avatarTest) } : {}),
  };
}

/** A short, stable hash of some text (for a key, not for security) */
const shortHash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/**
 * What a background brief job is keyed by for this source (src/lib/brief-jobs.ts): the server queues it under this
 * key, and the card it was started from finds its own job (and its progress) by it. The briefs of a split add "#part".
 */
export function jobKeyOf(source: BriefSource): string {
  switch (source.kind) {
    case "winner":
      return source.winner.adId;
    case "refresh":
    case "market":
      return source.adId;
    case "pattern":
      return source.patternId;
    case "promise":
      return source.commitmentId;
    case "suggestion":
      return source.id;
    case "idea":
      return `idea:${source.label.slice(0, 120)}`;
    case "talk":
      // One conversation: keyed by how it started, so its card finds it while the talk goes on
      return `talk:${shortHash(source.turns.find((t) => t.role === "user")?.text ?? "")}`;
  }
}
