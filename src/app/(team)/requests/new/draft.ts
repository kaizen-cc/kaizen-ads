import type { Format, Priority } from "@/lib/stages";

export type Size = "1x1" | "4x5" | "9x16";
export const SIZES: Size[] = ["1x1", "4x5", "9x16"];
export const FORMATS: Format[] = ["image", "video", "carousel"];

export type Counts = { new: number; variations: number };

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
