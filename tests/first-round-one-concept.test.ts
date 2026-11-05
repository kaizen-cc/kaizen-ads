import { describe, expect, it } from "vitest";
import { firstRoundRows, type SuggestionDraft } from "@/lib/suggestions";

const base = (title: string, concepts: SuggestionDraft["concepts"], formats: SuggestionDraft["formats"]): SuggestionDraft => ({
  title,
  angle: "angle",
  audience: "audience",
  brief: "The brief.",
  hooks: ["hook"],
  concepts,
  formats,
  sizes: ["4x5", "9x16"],
  landing: "https://example.com",
  refs: [],
});

const concept = (name: string, format: "image" | "video" | "carousel", n: number, v: number, cards = 0) => ({ name, hook: `${name} hook`, visual: "visual", copy: "copy", format, new: n, variations: v, cards });

describe("a new client's first round", () => {
  const out = {
    signal: "What this round learns",
    evidence: ["one", "two"],
    why: "Why.",
    drafts: [
      base("Smile first", [concept("Smile first", "image", 1, 2)], [{ format: "image", new: 1, variations: 2 }]),
      // A brief that came back holding two concepts anyway is still split, one suggestion each
      base("Two in one", [concept("The consult", "image", 1, 1), concept("Proof carousel", "carousel", 1, 0, 5)], [{ format: "image", new: 1, variations: 1 }, { format: "carousel", new: 1, variations: 0, cards: 5 }]),
      base("Video", [concept("Patient story", "video", 1, 0)], [{ format: "video", new: 1, variations: 0 }]),
    ],
  };
  const rows = firstRoundRows("client-1", out, { batchId: "batch-1", refs: ["https://example.com/liked.jpg"] });

  it("is one suggestion per concept", () => {
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.draft.concepts).toHaveLength(1);
    expect(rows.map((r) => r.draft.concepts[0].name)).toEqual(["Smile first", "The consult", "Proof carousel", "Patient story"]);
  });

  it("gives each its own format and counts (its own allotment draw)", () => {
    for (const r of rows) {
      expect(r.draft.formats).toHaveLength(1);
      expect(r.draft.formats[0].format).toBe(r.draft.concepts[0].format);
    }
    expect(rows[1].draft.formats[0]).toMatchObject({ format: "image", new: 1, variations: 1 });
    expect(rows[2].draft.formats[0]).toMatchObject({ format: "carousel", new: 1, variations: 0, cards: 5 });
  });

  it("keeps them together in one batch, as first-round suggestions with the client's liked ads as refs", () => {
    for (const r of rows) {
      expect(r).toMatchObject({ client_id: "client-1", kind: "onboarding", batch_id: "batch-1", batch_label: "First round", signal: "What this round learns" });
      expect(r.draft.refs).toContain("https://example.com/liked.jpg");
      expect(r.original).toEqual(r.draft);
    }
  });
});
