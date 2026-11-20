// Assets a client waived or confirmed they don't have (creative team, Nov 20 2026: generated briefs kept asking for
// assets that were already waived). Pure rules, tested in tests/asset-waivers.test.ts: how an asked-for asset is
// matched to a waiver, and what the brief writer is told.

export type Waiver = { label: string; how: "waived" | "unavailable" };

const STOP = new Set(["a", "an", "the", "for", "of", "to", "from", "and", "or", "with", "on", "in", "our", "their", "client", "clients", "new", "some", "any", "more", "need", "needs", "get", "send", "shoot", "have", "this", "that", "it", "drive", "link", "file", "files", "folder", "missing", "tbd"]);

/** The words that say what an asset is: lowercased, no filler, singular */
export function assetWords(label: string): string[] {
  return [
    ...new Set(
      label
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/[\s-]+/)
        .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
        .filter((w) => w.length > 1 && !STOP.has(w)),
    ),
  ];
}

/** A waiver's stored key: its words, sorted */
export const normAsset = (label: string) => [...assetWords(label)].sort().join(" ") || label.trim().toLowerCase().slice(0, 120);

/**
 * Whether an asked-for asset is one the client waived: every word of the waiver is in it (a waiver of "drone footage"
 * covers "Drone footage of the venue"), or they share most of their words.
 */
export function waiverFor(label: string, waivers: readonly Waiver[]): Waiver | null {
  const a = new Set(assetWords(label));
  if (!a.size) return null;
  for (const w of waivers) {
    const b = assetWords(w.label);
    if (!b.length) continue;
    const shared = b.filter((x) => a.has(x)).length;
    if (shared === b.length || shared / Math.max(a.size, b.length) >= 0.6) return w;
  }
  return null;
}

export const WAIVER_NOTE: Record<Waiver["how"], string> = { waived: "Waived for this client: not asked for again.", unavailable: "The client confirmed they don't have it: not asked for again." };

/** What the brief writer is told: never ask for these, work from what the client does have */
export function waiversBlock(waivers: readonly Waiver[]): string {
  if (!waivers.length) return "";
  return [
    "<assets_not_to_ask_for>",
    "This client waived these assets or confirmed they don't have them. Never list them under Assets as Need, Client to shoot or Missing, and never build the concept on them: work from what's on their Drive and what they have.",
    ...waivers.map((w) => `- ${w.label} (${w.how === "waived" ? "waived" : "not available"})`),
    "</assets_not_to_ask_for>",
  ].join("\n");
}
