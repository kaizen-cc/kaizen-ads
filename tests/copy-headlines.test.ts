import { describe, expect, it } from "vitest";
import { copyDocHtml, copyFieldProblems, isSectionLabel, liftSectionLabels, normalizeCopy } from "@/lib/copy-docs/core";

// The Ocean & Acre welcome flow as a call wrote it: the section's role where the headline goes, the headline in the body
const labelled = normalizeCopy({
  kind: "flow",
  title: "Welcome Flow",
  short_name: "Welcome",
  emails: [
    {
      name: "Email 1: Welcome",
      subject: "Welcome to Ocean & Acre",
      preview: "Raw bar, wood grill, garden",
      sections: [
        { heading: "Hero", body: "Where the Land Meets the Sea" },
        { heading: "Intro", body: "Thanks for joining us. Ocean & Acre is a coastal-inspired restaurant and bar at Halcyon." },
        { heading: "The idea", body: "One menu, two sides. Raw bar favorites and wood-grilled steaks." },
        { heading: "From the sea", body: "The Hot Buttered Lobster Roll." },
      ],
      cta: { label: "See the menu", url: "https://example.com" },
      design_notes: [],
    },
  ],
  brief: {},
});

describe("headlines, never section labels", () => {
  it("knows a label from a headline", () => {
    for (const l of ["Hero", "Intro", "The idea", "The feel", "Next", "Close", "CTA", "Block 2", "Header", "body"]) expect(isSectionLabel(l)).toBe(true);
    for (const h of ["Where the Land Meets the Sea", "From the sea", "Surf and soil, one table", "Date night"]) expect(isSectionLabel(h)).toBe(false);
  });

  it("lifts the headline out of a labelled hero and takes the intro as the sub-headline", () => {
    const c = liftSectionLabels(labelled);
    const e = c.emails[0];
    expect(e.sections[0]).toEqual({ heading: "Where the Land Meets the Sea", body: "Thanks for joining us. Ocean & Acre is a coastal-inspired restaurant and bar at Halcyon." });
    // "The idea" can't be lifted: its label is cleared (kept as a design note) and the email is flagged for a rewrite
    expect(e.sections[1].heading).toBe("");
    expect(e.designNotes).toContain('Block "The idea"');
    expect(copyFieldProblems(c)).toEqual([{ email: 0, problems: ["block 1 has no real headline"] }]);
  });

  it("never prints a label as the Headline in the designer's doc", () => {
    const html = copyDocHtml(liftSectionLabels(labelled), { client: "Ocean & Acre" });
    expect(html).toContain("<b>Headline:</b> Where the Land Meets the Sea");
    expect(html).not.toMatch(/Headline:<\/b> (?:Hero|Intro|The idea)/);
  });

  it("passes copy that already has real headlines", () => {
    const good = normalizeCopy({ kind: "campaign", title: "x", emails: [{ name: "Email 1", subject: "s", preview: "p", sections: [{ heading: "Surf and soil, one table", body: "Here's where to start." }, { heading: "From the sea", body: "Oysters." }], cta: null, design_notes: [] }], brief: {} });
    expect(copyFieldProblems(liftSectionLabels(good))).toEqual([]);
  });
});
