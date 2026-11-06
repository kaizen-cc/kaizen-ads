import type { Format, Priority } from "@/lib/stages";
import type { IdeaKey } from "@/lib/saved-references";
import type { BriefStructure } from "@/lib/brief-pdf-model";

export type Size = "1x1" | "4x5" | "9x16";
/** The sizes new work is made in: 4:5 (feed) and 9:16 (Stories, Reels). Kaizen stopped designing 1:1 on Oct 26, 2026; "1x1" stays
 *  in Size so older tickets still read. */
export const SIZES: Size[] = ["4x5", "9x16"];
export const FORMATS: Format[] = ["image", "video", "carousel"];

/** cards: carousels only, how many cards each has */
export type Counts = { new: number; variations: number; cards?: number };

export { MAX_VARIATIONS } from "@/lib/allotment";

/** Everything the request form collects. One batch; one ticket per selected format. */
export type Draft = {
  clientId: string | null;
  formats: Partial<Record<Format, Counts>>;
  sizes: Size[];
  title: string;
  angle: string;
  /** Who it's for: one of the Brand Bible's avatars by name, or a new one under test (avatarTest) */
  avatar?: string;
  avatarTest?: boolean;
  audience: string;
  priority: Priority;
  brief: string;
  refs: string;
  landing?: string; // where the ad sends people
  origin?: Origin | null; // what it's built on (a winner, a market ad, a promise from a call)
  migration?: Migration | null; // coming over from Asana: the stage it lands in and what that stage needs
  savedRefIds?: string[]; // saved references it's built on: marked used (and out of Saved) once it's sent
  ideaKeys?: IdeaKey[]; // the ideas it's built on (a market ad, a pattern, an audit's idea): everyone's save of them is marked used once it's sent
  pdfCache?: { key: string; structure: BriefStructure } | null; // the brief restructured for its PDF, kept until the brief changes (by key)
  ai?: AiStamp | null; // written entirely by the AI: where from, and the fingerprint of what it wrote (unchanged skips the review)
};

/** Where an AI-written brief came from, so the server can read the version the AI wrote (src/lib/brief-fingerprint.ts) */
export type AiSource =
  | { kind: "suggestion"; id: string } // a suggested brief, a quick preview's full brief, a promise's brief (creative_suggestions)
  | { kind: "kaizen-ai"; messageId: string; card: number } // a brief card in Kaizen AI (ai_messages)
  | { kind: "talk"; seal: string }; // talked through with the strategist: nothing stored, so the server signed what it wrote
/** An AI-written brief as it arrived: its source and the fingerprint of its reviewable fields */
export type AiStamp = { source: AiSource; fingerprint: string };

/** A Kaizen AI brief card as the request's fields */
export const briefCardDraft = (b: import("@/lib/kaizen-ai/types").BriefCard): Partial<Draft> => ({
  title: b.title,
  formats: Object.fromEntries(b.formats.map((f) => [f.format, { new: f.new, variations: f.variations }])),
  sizes: ["4x5", "9x16"],
  angle: b.angle,
  audience: b.audience,
  brief: b.brief,
  refs: "",
  landing: b.landing,
});

/** An Asana task becoming a ticket: it lands in the stage it reached, with what that stage needs filled in. */
export type Migration = { gid: string; name: string; url: string; stage: string; stageLabel: string; needsCreative: boolean; needsCopy: boolean; assigneeId: string | null; creativeLink: string; copy: string };

/** What a request is built on, kept on its tickets so the creative team sees the idea behind it. */
export type Origin = { kind: "winner" | "market" | "promise" | "brief"; label: string; link?: string | null; thumb?: string | null; suggestionId?: string | null };

export const emptyDraft = (clientId: string | null): Draft => ({
  clientId,
  formats: {},
  sizes: ["4x5", "9x16"],
  title: "",
  angle: "",
  audience: "",
  priority: "normal",
  brief: "",
  refs: "",
  landing: "",
});

export const refLinks = (refs: string) =>
  refs
    .split(/\s+/)
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 20);

export const selectedFormats = (d: Draft) => FORMATS.filter((f) => d.formats[f]);

export const totalFor = (c: Counts | undefined) => (c ? c.new + c.variations : 0);

/** What the AI reads: the draft in plain words. */
export function describeDraft(d: Draft, clientName: string) {
  const fmts = selectedFormats(d)
    .map((f) => `${f}: ${d.formats[f]!.new} net new + ${d.formats[f]!.variations} variations`)
    .join("; ");
  return [
    `Client: ${clientName}`,
    `Formats: ${fmts || "none picked yet"}`,
    `Sizes: ${d.sizes.map((s) => s.replace("x", ":")).join(", ") || "none"}`,
    `Title: ${d.title || "(empty)"}`,
    `Avatar: ${d.avatar?.trim() ? `${d.avatar.trim()}${d.avatarTest ? " (a new avatar under test, not in the Brand Bible)" : ""}` : "(none picked)"}`,
    `Angle: ${d.angle || "(empty)"}`,
    `Audience: ${d.audience || "(empty)"}`,
    `Priority: ${d.priority}`,
    `Brief:\n${d.brief || "(empty)"}`,
    `References: ${refLinks(d.refs).join(" ") || "(none)"}`,
  ].join("\n");
}

/** A winning ad picked in the winners library, waiting to go into the next request's brief (session storage). */
export const INSPIRE_KEY = "kz:inspire";

/** The brief line for a winning ad: what it is and why it's worth learning from. */
export function inspireLine(w: { detail: string | null; headline: string | null; name: string; text: string | null; ratio: number; result: string | null }) {
  return `Reference: a winning ad for a similar business (${w.detail ?? "same industry"}): "${w.headline ?? w.name}"${w.text ? `, copy: "${w.text.slice(0, 140)}"` : ""}. It's getting ${w.ratio}x better cost per ${w.result ?? "result"} than its account's usual.`;
}
