import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BriefText } from "@/components/brief-sheet";
import type { ClientDrive } from "@/lib/brief-cards";
import { composeBrief, emptySpec, exportLineFor, type BriefSpec } from "@/lib/brief-spec";
import { STATIC_BEST_TICKETS } from "./fixtures/brief-static-best-tickets";

// The brief on screen (Ready to send and the ticket) shows the same sections as the PDF, for every format, and an
// older or free-text brief still reads.

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), ...p });
const html = (text: string, exportLine?: string, drive?: ClientDrive) => renderToStaticMarkup(createElement(BriefText, { text, exportLine, drive }));

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
    const drive = { headquarters: "https://drive.google.com/drive/folders/hq123", adCreatives: "https://drive.google.com/drive/folders/ads456" };
    const out = html(text, exportLineFor(["video"], ["9x16"], "Best Tickets", "The Detail"), drive);
    // His order: the idea, the beats as cards and the pacing bar, the versions, Do and Don't, Your call, the copy, the
    // assets (the client's Drive first) and export, what to confirm
    const order = ["Evergreen TOF", "The owner’s answer is the detail.", "Why it works", "Who it&#x27;s for", "The video in 2 beats", "On-screen text", "“The detail most people miss”", "Pacing", "The versions (2)", "Do and don&#x27;t", "Your call", "Copy", "Assets and export", "Client Drive (headquarters)", "Ad Creatives folder", "Owner interview", "Open in Drive", "Export", "Confirm with client"];
    let at = -1;
    for (const s of order) {
      const i = out.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(out).toContain("Interview · Source 0:12");
    expect(out).toContain('href="https://drive.google.com/drive/folders/hq123"');
    expect(out).toContain('href="https://drive.google.com/drive/folders/ads456"');
    expect(out).not.toContain("…");
    // A client with no Drive folders on file gets no Drive rows
    expect(html(text)).not.toContain("Client Drive (headquarters)");
  });

  it("shows a carousel's slides and a single image's frame", () => {
    const c = html(composeBrief("Section 112 is the payoff.", spec({ insight: "Behind the bench.", slides: ["Hook | Headline: The seat most fans skip | Shows: The arena", "CTA | Headline: Find your seat"], versions: ["The seat most fans skip"] })));
    expect(c).toContain("The carousel in 2 slides");
    expect(c).toContain("Slide order");
    expect(c).toContain("The seat most fans skip");
    const i = html(composeBrief("Golden hour sells Friday.", spec({ insight: "Patio ads win.", frame: ["Headline: Fridays on the patio", "Reads first: Headline, then the button"], versions: ["Fridays on the patio"] })));
    expect(i).toContain("The frame");
    expect(i).toContain("Reads first");
  });

  it("shows the real static brief like the PDF: one sentence, the versions as the build, nothing that holds the work", () => {
    const out = html(STATIC_BEST_TICKETS);
    // The idea is one sentence; the copy direction moved to the Copy section
    expect(out).toContain("A real phone photo from a real seat, with one big line naming the seat most people skip and a small line saying why.</p>");
    expect(out).not.toContain("Copy direction");
    expect(out).not.toContain("The viewer learns");
    expect(out).toContain("Not every seat in a section sees the same game.");
    // The four versions are the build, cards with the layout they share; no separate versions list
    expect(out).toContain("The images in 4 versions");
    expect(out).toContain("Variation of V1");
    expect(out).toContain("The layout");
    expect(out).not.toContain("The versions (4)");
    expect(out).not.toContain(">The frame<");
    // The short fallback up top, the rest under Confirm with client; never "hold this ticket"
    expect(out).toContain("If not:</b> V3 and V4 test the approved line");
    expect(out).not.toMatch(/hold this ticket|until the client says yes|it waits for December/i);
    expect(out).toContain("Check before making it.");
  });

  it("still reads an older brief and free text", () => {
    const old = html("Reveal the seat.\n\nInsight: Section 112 (Source: Brand Bible)\n\nHook: The seat most fans miss\n\nDo:\n- Show the view\n\nKPI: Cost per purchase\n\nYour call: Yours.");
    expect(old).toContain("Why it works");
    expect(old).toContain("The seat most fans miss");
    expect(old).toContain("KPI");
    expect(html("Show the patio at sunset.\n\nHooks to try:\n- One")).toContain("Hooks to try");
  });
});
