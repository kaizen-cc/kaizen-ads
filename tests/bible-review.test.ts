import { describe, expect, it } from "vitest";
import { digestTitle, intakeTag, materialHash, readyTitle, shouldAnnounce } from "@/lib/bible-review";

describe("a Brand Bible ready for the creative team's review", () => {
  it("is titled with the client and version, and tagged by the intake form", () => {
    expect(readyTitle("Acme Bedding", "v1.2")).toBe("Brand Bible ready for your review: Acme Bedding · v1.2");
    expect(readyTitle("Acme Bedding", "1.0")).toBe("Brand Bible ready for your review: Acme Bedding · v1.0");
    expect(intakeTag(true)).toBe("Built from the intake form");
    expect(intakeTag(false)).toBe("Built without the intake form: from calls, emails and research");
    expect(digestTitle(6)).toBe("6 Brand Bibles ready for your review");
  });

  it("hashes what the team reads, not how it's spaced or punctuated", () => {
    const a = materialHash({ readThisFirst: "Tone: warm, direct.", overview: { statement: "We fix bedding." }, openQuestions: [{ question: "Which offer?" }, { question: "Free shipping?" }] });
    const b = materialHash({ readThisFirst: "tone  warm direct", overview: { statement: "we fix bedding" }, openQuestions: [{ question: "free shipping" }, { question: "which offer" }] });
    const c = materialHash({ readThisFirst: "Tone: playful.", overview: { statement: "We fix bedding." }, openQuestions: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("announces new Bibles and material changes, never an unchanged rewrite or an unsure monthly refresh", () => {
    expect(shouldAnnounce({ isNew: true, reason: "new", prevHash: null, hash: "x" })).toBe(true);
    expect(shouldAnnounce({ isNew: true, reason: "backfill", prevHash: null, hash: "x" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: null, prevHash: null, hash: "x" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: "manual", prevHash: "x", hash: "x" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: "monthly", prevHash: "x", hash: "x" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: "monthly", prevHash: null, hash: "x" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: "monthly", prevHash: "x", hash: "y" })).toBe(false);
    expect(shouldAnnounce({ isNew: false, reason: "intake", prevHash: null, hash: "y" })).toBe(true);
    expect(shouldAnnounce({ isNew: false, reason: "manual", prevHash: "x", hash: "y" })).toBe(true);
  });
});
