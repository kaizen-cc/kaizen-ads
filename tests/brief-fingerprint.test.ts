import { afterEach, describe, expect, it } from "vitest";
import { aiFingerprint, aiUnedited, canonicalDraft, fingerprintDraft, stampAi } from "@/lib/brief-fingerprint";
import { checkSeal, sealBrief } from "@/lib/brief-seal";
import { emptyDraft, type Draft } from "@/app/(team)/requests/new/draft";

const ALL = ["image", "video", "carousel"] as const;

/** What the strategist wrote (as toPatch gives it) */
const patch: Partial<Draft> = {
  title: "BFCM · Buy More, Save More",
  angle: "Fresh, never frozen",
  audience: "Parents of kids 5-12",
  brief: "Show the box.\n\nHook: Dinner in 10 minutes",
  formats: { image: { new: 2, variations: 1 }, video: { new: 1, variations: 0 } },
  sizes: ["4x5", "9x16"],
  landing: "https://brand.com/offer",
  refs: "https://a.com/1\nhttps://b.com/2",
};

/** The form's draft as it arrives: an empty request with the AI's fields and its stamp */
const loaded = (allowed: readonly ("image" | "video" | "carousel")[] = ALL): Draft => ({
  ...emptyDraft("client-1"),
  ...patch,
  ai: stampAi(patch, { kind: "suggestion", id: "00000000-0000-0000-0000-000000000000" }, allowed),
});

describe("brief fingerprint", () => {
  it("an AI brief loaded as it was is unedited", () => {
    expect(aiUnedited(loaded())).toBe(true);
  });

  it("a brief with no AI stamp (written by hand) is never unedited", () => {
    expect(aiUnedited({ ...emptyDraft("c"), title: "Mine" })).toBe(false);
    expect(aiUnedited({ ...emptyDraft("c"), ai: null })).toBe(false);
  });

  it("whitespace-only changes don't count", () => {
    const d = loaded();
    expect(aiUnedited({ ...d, title: `  ${d.title}  `, brief: d.brief.replace("\n\n", "\n \n\n  "), angle: `${d.angle}\n` })).toBe(true);
  });

  it("pure reordering of sizes, formats and references doesn't count", () => {
    const d = loaded();
    expect(aiUnedited({ ...d, sizes: ["9x16", "4x5"], refs: "https://b.com/2 https://a.com/1", formats: { video: d.formats.video, image: d.formats.image } })).toBe(true);
  });

  it.each([
    ["title", { title: "Something else" }],
    ["angle", { angle: "Price" }],
    ["audience", { audience: "Everyone" }],
    ["brief", { brief: "Show the box. Hook: Lunch in 10 minutes" }],
    ["landing", { landing: "https://brand.com/other" }],
    ["references", { refs: "https://a.com/1" }],
    ["sizes", { sizes: ["4x5"] }],
    ["versions", { formats: { image: { new: 3, variations: 1 }, video: { new: 1, variations: 0 } } }],
    ["formats", { formats: { image: { new: 2, variations: 1 } } }],
    ["carousel cards", { formats: { ...patch.formats, carousel: { new: 1, variations: 0, cards: 6 } } }],
  ] as [string, Partial<Draft>][])("an edit to the %s counts", (_, change) => {
    expect(aiUnedited({ ...loaded(), ...change })).toBe(false);
  });

  it("copy on a migration counts", () => {
    const d = loaded();
    expect(aiUnedited({ ...d, migration: { gid: "1", name: "x", url: "u", stage: "copy", stageLabel: "Copy", needsCreative: false, needsCopy: true, assigneeId: null, creativeLink: "", copy: "New copy here" } })).toBe(false);
  });

  it("edited back to how it was is unedited again", () => {
    const d = loaded();
    const edited = { ...d, title: "Changed" };
    expect(aiUnedited(edited)).toBe(false);
    expect(aiUnedited({ ...edited, title: d.title })).toBe(true);
  });

  it("fields that aren't reviewed (priority, origin) don't count", () => {
    expect(aiUnedited({ ...loaded(), priority: "urgent", origin: { kind: "brief", label: "x" } })).toBe(true);
  });

  it("formats outside the person's are left out the same way on both sides", () => {
    // A designer: the form keeps images only, and the server recomputes the AI's version the same way
    const kept: Draft = { ...loaded(["image", "carousel"]), formats: { image: patch.formats!.image } };
    expect(aiUnedited(kept)).toBe(true);
    expect(fingerprintDraft(kept)).toBe(aiFingerprint(patch, new Set(["image", "carousel"] as const)));
  });

  it("missing fields read as an empty request's", () => {
    expect(aiFingerprint({ title: "T" }, ALL)).toBe(fingerprintDraft({ ...emptyDraft(null), title: "T" }));
  });

  it("the canonical form is stable", () => {
    expect(canonicalDraft({ title: " a  b ", sizes: ["9x16", "4x5", "9x16"] })).toBe(canonicalDraft({ title: "a b", sizes: ["4x5", "9x16"] }));
    expect(fingerprintDraft(patch)).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("talked-through seal", () => {
  const was = process.env.BRIEF_SEAL_SECRET;
  afterEach(() => {
    if (was === undefined) delete process.env.BRIEF_SEAL_SECRET;
    else process.env.BRIEF_SEAL_SECRET = was;
  });

  it("checks only for the same client and fingerprint", () => {
    process.env.BRIEF_SEAL_SECRET = "test-secret";
    const fp = aiFingerprint(patch, ALL);
    const seal = sealBrief("client-1", fp)!;
    expect(checkSeal("client-1", fp, seal)).toBe(true);
    expect(checkSeal("client-2", fp, seal)).toBe(false);
    expect(checkSeal("client-1", fingerprintDraft({ ...patch, title: "x" }), seal)).toBe(false);
    expect(checkSeal("client-1", fp, "forged")).toBe(false);
    expect(checkSeal("client-1", fp, null)).toBe(false);
  });
});
