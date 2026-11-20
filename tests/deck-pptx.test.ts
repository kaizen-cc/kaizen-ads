import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { cleanSlide, cleanSlides } from "@/lib/kaizen-ai/deck-core";
import { deckPptx, xml } from "@/lib/kaizen-ai/deck-pptx";

const look = { hero: "#151B26", primary: "#E0262F", bars: "#1F6FEB", heroSoft: "#F6B3B6" };

describe("table and bars slides", () => {
  it("keeps a table to 6 columns and 8 rows, padding short rows", () => {
    const s = cleanSlide({ kind: "table", title: "Offers", columns: ["Offer", "Spend", "Purchases", "CPP"], cells: [["$99", "$1,200", "12", "$100"], ["$7", "$300"]], note: "Jul 1 to Oct 31" });
    expect(s).toEqual({ kind: "table", title: "Offers", columns: ["Offer", "Spend", "Purchases", "CPP"], cells: [["$99", "$1,200", "12", "$100"], ["$7", "$300", "", ""]], note: "Jul 1 to Oct 31" });
    const big = cleanSlide({ kind: "table", columns: Array.from({ length: 9 }, (_, i) => `C${i}`), cells: Array.from({ length: 12 }, () => Array.from({ length: 9 }, () => "x")) });
    expect(big && big.kind === "table" && [big.columns.length, big.cells.length]).toEqual([6, 8]);
    expect(cleanSlide({ kind: "table", columns: ["A"], cells: [] })).toBeNull();
  });
  it("reads bar values as numbers, keeping how they're shown", () => {
    const s = cleanSlide({ kind: "bars", title: "Cost per purchase by offer", bars: [{ label: "$99", value: "$100.50", display: "$100.50" }, { label: "$7", value: 12, tone: "good" }, { label: "" , value: 1 }] });
    expect(s).toEqual({ kind: "bars", title: "Cost per purchase by offer", bars: [{ label: "$99", value: 100.5, display: "$100.50", tone: null }, { label: "$7", value: 12, display: "12", tone: "good" }], note: "" });
  });
});

describe("deckPptx", () => {
  const slides = cleanSlides(
    [
      { kind: "cover", title: "Offer comparison", text: "Jul to Oct" },
      { kind: "stats", title: "Headline", stats: [{ value: "$64", label: "Cost per purchase" }] },
      { kind: "bars", title: "Cost per purchase by offer", bars: [{ label: "$99", value: 100, display: "$100" }, { label: "$7 & up", value: 12, display: "$12" }] },
      { kind: "table", title: "The numbers", columns: ["Offer", "Spend"], cells: [["$99 <best>", "$1,200"]] },
      { kind: "image_notes", title: "Top creative", image: "ad:123456", bullets: ["Hook in the first second"] },
      { kind: "scorecard", title: "Scorecard", rows: [{ label: "CVR", tone: "good", note: "Up after the new checkout" }] },
    ],
    "Offer comparison",
    "",
  );
  const pic = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 600, height: 600 };
  const files = unzipSync(deckPptx({ title: "Offer comparison", client: "A Client", look, slides, pictures: new Map([["ad:123456", pic]]) }));
  it("has every part PowerPoint needs, the content types first", () => {
    const names = Object.keys(files);
    expect(names[0]).toBe("[Content_Types].xml");
    for (const n of ["_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/theme/theme1.xml", "ppt/media/image1.jpeg", "docProps/core.xml"]) expect(names).toContain(n);
    expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(6);
    const types = strFromU8(files["[Content_Types].xml"]);
    expect(types.match(/slide\+xml/g)).toHaveLength(6);
  });
  it("writes text as editable shapes, escaped, and a real table", () => {
    const bars = strFromU8(files["ppt/slides/slide3.xml"]);
    expect(bars).toContain("<a:t>$7 &amp; up</a:t>");
    expect(bars).toContain('name="Bar $99"');
    const table = strFromU8(files["ppt/slides/slide4.xml"]);
    expect(table).toContain("<a:tbl>");
    expect(table).toContain("<a:t>$99 &lt;best&gt;</a:t>");
  });
  it("links the picture to its slide", () => {
    expect(strFromU8(files["ppt/slides/_rels/slide5.xml.rels"])).toContain('Target="../media/image1.jpeg"');
    expect(strFromU8(files["ppt/slides/slide5.xml"])).toContain('r:embed="rId2"');
  });
  it("numbers the slides in the presentation", () => {
    const pres = strFromU8(files["ppt/presentation.xml"]);
    expect(pres).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(pres).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
  });
  it("escapes XML and drops control characters", () => {
    expect(xml(`a<b>&"c'\u0001`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});
