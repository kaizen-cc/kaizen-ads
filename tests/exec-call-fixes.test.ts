import { describe, expect, it } from "vitest";
import { driveQuote, multipartBody, parseFolderRef } from "@/lib/drive-push-core";
import { caseStudyReady, cleanCaseStudy, KAIZEN_ACCENT, paletteFor } from "@/lib/documents/case-study-core";
import { monthlySeries } from "@/lib/case-study-data";
import { supersededLines } from "@/lib/agent-call/transcript";

describe("one line per utterance in a call's transcript", () => {
  const said = Date.parse("2026-11-21T06:34:36Z");
  const first = "I want these PDFs to be client-ready so that we're able to actually send them directly to clients.";
  it("a cut-off turn sent again in full replaces its earlier, shorter saves", () => {
    const rows = [
      { id: "a", content: first, at: said - 29_000 },
      { id: "b", content: `${first} So please remove the next steps.`, at: said - 20_000 },
      { id: "c", content: `${first} So please remove the next steps and lead with profit.`, at: said - 11_000 },
    ];
    expect(supersededLines(rows, `${first} So please remove the next steps and lead with profit, with charts.`, said)).toEqual(["a", "b", "c"]);
  });
  it("leaves short replies and unrelated lines alone", () => {
    expect(supersededLines([{ id: "y", content: "Yes", at: said - 5000 }], "Yes, do that one first and then the next", said)).toEqual([]);
    expect(supersededLines([{ id: "z", content: "Something else entirely that was said earlier on", at: said - 5000 }], first, said)).toEqual([]);
    expect(supersededLines([{ id: "old", content: first, at: said - 10 * 60_000 }], `${first} More.`, said)).toEqual([]);
  });
});

describe("pushing documents to a Drive folder", () => {
  it("reads a folder link, a bare id or a path as said", () => {
    expect(parseFolderRef("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toEqual({ id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" });
    expect(parseFolderRef("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStU?usp=sharing")).toEqual({ id: "1AbCdEfGhIjKlMnOpQrStU" });
    expect(parseFolderRef("00-Business Manifesto/08-Kaizen Content")).toEqual({ path: ["00-Business Manifesto", "08-Kaizen Content"] });
    expect(parseFolderRef("Shared drives > Kaizen > Case Studies")).toEqual({ path: ["Kaizen", "Case Studies"] });
    expect(parseFolderRef("  ")).toBeNull();
  });
  it("quotes names safely inside a Drive query, and builds the upload body", () => {
    expect(driveQuote("Kaizen's Content")).toBe("'Kaizen\\'s Content'");
    const body = new TextDecoder().decode(multipartBody({ name: "a.pdf" }, new Uint8Array([37, 80, 68, 70]), "application/pdf", "B"));
    expect(body).toContain('{"name":"a.pdf"}');
    expect(body).toContain("Content-Type: application/pdf\r\n\r\n%PDF");
    expect(body.endsWith("--B--")).toBe(true);
  });
});

describe("case studies: client-ready, in their own look", () => {
  it("never carries prices, placeholders or next steps", () => {
    const cs = cleanCaseStudy(
      {
        title: "Aldecoa Coffee: purchases up 64% at a lower cost",
        summary: "A Houston roaster.",
        approach: ["Rebuilt the prospecting structure", "Next steps: raise budget", "Pricing: $1,000/mo retainer"],
        results: [{ value: "+64%", label: "Purchases", note: "Jun to Nov" }, { value: "Price to confirm", label: "Retainer", note: "" }],
        highlights: ["What's next: a new offer", "Cost per purchase down to $31"],
        charts: [{ title: "Purchases by month", kind: "bar", unit: "", points: [{ label: "Jun", value: 410 }, { label: "Jul", value: 520 }] }, { title: "One point", kind: "line", unit: "$", points: [{ label: "Jun", value: 1 }] }],
      },
      { client: "Aldecoa Coffee" },
    );
    expect(cs.approach).toEqual(["Rebuilt the prospecting structure"]);
    expect(cs.results.map((r) => r.label)).toEqual(["Purchases"]);
    expect(cs.highlights).toEqual(["Cost per purchase down to $31"]);
    expect(cs.charts.map((c) => c.title)).toEqual(["Purchases by month"]);
    expect(caseStudyReady(cs)).toBe(true);
  });
  it("the palette is code: Kaizen red unless another accent is asked for", () => {
    expect(paletteFor(null).accent).toBe(KAIZEN_ACCENT);
    expect(paletteFor("#1E90FF").accent).toBe("#1e90ff");
    expect(paletteFor("blue").accent).toBe(KAIZEN_ACCENT);
  });
  it("months come from the synced daily rows, a purchase counted once", () => {
    const rows = [
      { date: "2026-10-01", spend: 100, actions: { omni_purchase: 3, purchase: 3 }, action_values: { omni_purchase: 300, purchase: 300 } },
      { date: "2026-10-02", spend: 50, actions: { purchase: 2 }, action_values: { purchase: 150 } },
      { date: "2026-11-01", spend: 80, actions: {}, action_values: {} },
    ];
    expect(monthlySeries(rows as { date: string; spend: number; actions: Record<string, number>; action_values: Record<string, number> }[], ["omni_purchase", "purchase"])).toEqual([
      { month: "2026-10", spend: 150, results: 5, value: 450 },
      { month: "2026-11", spend: 80, results: 0, value: 0 },
    ]);
  });
});
