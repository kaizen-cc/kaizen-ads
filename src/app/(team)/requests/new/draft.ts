import type { Format, Priority } from "@/lib/stages";

export type Size = "1x1" | "4x5" | "9x16";
export const SIZES: Size[] = ["1x1", "4x5", "9x16"];
export const FORMATS: Format[] = ["image", "video", "carousel"];

export type Counts = { new: number; variations: number };

export { MAX_VARIATIONS } from "@/lib/allotment";

/** Everything the request form collects. One batch; one ticket per selected format. */
export type Draft = {
  clientId: string | null;
  formats: Partial<Record<Format, Counts>>;
  sizes: Size[];
  title: string;
  angle: string;
  audience: string;
  priority: Priority;
  brief: string;
  refs: string;
  landing?: string; // where the ad sends people
};

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
    `Angle or avatar: ${d.angle || "(empty)"}`,
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
