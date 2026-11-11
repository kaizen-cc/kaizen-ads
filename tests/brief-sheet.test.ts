import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BriefText } from "@/components/brief-sheet";
import { composeBrief, emptySpec, exportLineFor, type BriefSpec } from "@/lib/brief-spec";

// The brief on screen (Ready to send and the ticket) shows the same sections as the PDF, for every format, and an
// older or free-text brief still reads.

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), ...p });
const html = (text: string, exportLine?: string) => renderToStaticMarkup(createElement(BriefText, { text, exportLine }));

describe("the brief on screen", () => {
  it("shows a video brief's sections in order, with the beats, the pacing and the export line", () => {
    const text = composeBrief(
      "The owner's answer is the detail.",
      spec({
        stage: "Evergreen TOF",
        insight: "Asked why, the owner says one word: convenience.",
        insightSource: "Owner interview",
        who: "Fans who want good seats",
        length: "~30s",
        beats: ['0:00-0:05 | Hook | On screen: The owner on camera | Text: "The detail most people miss"', '0:05-0:30 | End card | On screen: Logo | Says: "Come see us." (Source: Interview 0:12)'],
        audio: "Music only.",
        versions: ["The detail most people miss", "One word: convenience"],
        dos: ["Logo in the first 3 seconds"],
        donts: ["No prices"],
        yourCall: "Cuts and transitions are yours.",
        assets: [{ item: "Owner interview https://drive.google.com/file/d/a/view", status: "have" }],
        copy: ["Primary: Real seats.", "CTA: Shop Now"],
        confirm: [{ question: "Is checkout working?", answer: "", source: "" }],
      }),
    );
    const out = html(text, exportLineFor(["video"], ["9x16"], "Best Tickets", "The Detail"));
    const order = ["Evergreen TOF", "The owner&#x27;s answer is the detail.", "Why it works", "Who it&#x27;s for", "The video in 2 beats", "Pacing", "The versions (2)", "Must", "Never", "Your call", "Assets", "Open in Drive", "Copy", "Confirm with client", "Export"];
    let at = -1;
    for (const s of order) {
      const i = out.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(out).toContain("Says · source Interview 0:12");
  });

  it("shows a carousel's slides and a single image's frame", () => {
    const c = html(composeBrief("Section 112 is the payoff.", spec({ insight: "Behind the bench.", slides: ["Hook | Headline: The seat most fans skip | Shows: The arena", "CTA | Headline: Find your seat"], versions: ["The seat most fans skip"] })));
    expect(c).toContain("The carousel, slide by slide");
    expect(c).toContain("The seat most fans skip");
    const i = html(composeBrief("Golden hour sells Friday.", spec({ insight: "Patio ads win.", frame: ["Headline: Fridays on the patio", "Reads first: Headline, then the button"], versions: ["Fridays on the patio"] })));
    expect(i).toContain("The frame");
    expect(i).toContain("Reads first");
  });

  it("still reads an older brief and free text", () => {
    const old = html("Reveal the seat.\n\nInsight: Section 112 (Source: Brand Bible)\n\nHook: The seat most fans miss\n\nDo:\n- Show the view\n\nKPI: Cost per purchase\n\nYour call: Yours.");
    expect(old).toContain("Why it works");
    expect(old).toContain("The seat most fans miss");
    expect(old).toContain("KPI");
    expect(html("Show the patio at sunset.\n\nHooks to try:\n- One")).toContain("Hooks to try");
  });
});
