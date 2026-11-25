import { describe, expect, it } from "vitest";
import { BASIC_CREATIVE, cleanGtm, cleanNotes, feeMentions, GTM_FILE, kaizenMentions, notesText, pickCaseStudies, scrubKaizen, shortName, tierPlan, verticalOf, type CaseStudy } from "@/lib/sales-gtm-core";
import { brandFor, KAIZEN_BRAND, renderGtmPdf } from "@/lib/sales-gtm-pdf";
import { SAMPLE_GTM } from "./fixtures/gtm-sample";

const studies: CaseStudy[] = [
  { key: "gumbys", name: "Gumby's Pizza", vertical: "Restaurant", fits: ["restaurant", "pizza", "local"], services: "", results: "4.2x ROAS", connection: "" },
  { key: "aldecoa", name: "Aldecoa Coffee", vertical: "Ecom", fits: ["ecommerce", "dtc", "coffee"], services: "", results: "$135,000+", connection: "" },
  { key: "allamerican", name: "All American Fence And Gate", vertical: "Home services", fits: ["fence", "contractor", "home services"], services: "", results: "10.8x", connection: "" },
  { key: "marquee", name: "Marquee Dental", vertical: "Professional", fits: ["dental", "accounting", "cpa", "law"], services: "", results: "21.1x ROAS", connection: "" },
];

describe("go-to-market engine: rules", () => {
  it("the basic creative package is the 310", () => {
    expect(BASIC_CREATIVE).toMatchObject({ images: 3, videos: 10 });
  });
  it("always three tiers, weighted by the kind of business", () => {
    expect(verticalOf("CPA firm")).toBe("professional");
    expect(verticalOf("DTC skincare", "products shipped online")).toBe("ecommerce");
    expect(verticalOf("pizza restaurant")).toBe("local");
    expect(verticalOf("roofing contractor")).toBe("lead_gen");
    const lead = tierPlan("lead_gen");
    expect(lead.map((t) => t.name)).toEqual(["Tier 1 · Minimal", "Tier 2 · MVP", "Tier 3 · Elite"]);
    expect(lead[0].services).toEqual(["Google advertising"]);
    expect(lead[1].services.join(" ")).toMatch(/Google.*Meta.*310.*attached to Meta/);
    expect(lead[2].services.join(" ")).toMatch(/On-site photo and video.*Email.*CRM/);
    expect(tierPlan("ecommerce")[1].services.join(" ")).toMatch(/Meta.*Creative.*Email.*CRO/);
  });
  it("picks the case study that fits", () => {
    expect(pickCaseStudies("CPA accounting firm", studies)[0].key).toBe("marquee");
    expect(pickCaseStudies("fence contractor", studies)[0].key).toBe("allamerican");
    expect(pickCaseStudies("pizza", studies)[0].key).toBe("gumbys");
    expect(pickCaseStudies("something new", studies, "ecommerce")[0].key).toBe("aldecoa");
  });
});

describe("go-to-market engine: the documents", () => {
  it("cleans the strategy into its sections", () => {
    const c = cleanGtm(SAMPLE_GTM);
    expect(c.cover.short).toBe("DPB");
    expect(c.exec.stats).toHaveLength(3);
    expect(c.market.competitors.rows[0][0]).toBe("National firms");
    expect(c.investment.tiers.head).toEqual(["", "Launch", "Recommended", "Accelerate"]);
  });
  it("white-label: finds and removes every Kaizen mention, and catches fees", () => {
    const withKaizen = cleanGtm({ ...SAMPLE_GTM, exec: { ...SAMPLE_GTM.exec, lede: "Kaizen Marketing will run this. Kaizen's team." } });
    expect(kaizenMentions(withKaizen)).toEqual(["exec.lede"]);
    const scrubbed = scrubKaizen(withKaizen, "ZenChange Marketing");
    expect(kaizenMentions(scrubbed)).toEqual([]);
    expect(scrubbed.exec.lede).toBe("ZenChange Marketing will run this. ZenChange Marketing's team.");
    expect(feeMentions(cleanGtm({ ...SAMPLE_GTM, investment: { ...SAMPLE_GTM.investment, lede: "Plus a $1,000/mo management fee." } }))).toContain("management fee");
    expect(feeMentions(cleanGtm(SAMPLE_GTM))).toEqual([]);
    expect(GTM_FILE("DPB, PLLC", "ZenChange")).not.toMatch(/kaizen/i);
  });
  it("talking notes: every claim tagged, marked for the partner when white-label", () => {
    const n = cleanNotes({ headline: "Lead with the review.", flags: [{ text: "0 Meta ads under one page name", tag: "likely" }], decisions: [{ text: "Google only for audits", tag: "certain" }], caveats: [{ text: "Tiers are estimates", tag: "guessing" }], risks: [], facts: [{ text: "11 partners", tag: "nonsense" }] }, "ZenChange");
    expect(n.facts[0].tag).toBe("guessing");
    const t = notesText("DPB", n);
    expect(t).toMatch(/^Internal · for ZenChange only · do not share with DPB/);
    expect(t).toMatch(/\[likely\]/);
    expect(t).toMatch(/\[guessing, informed\]/);
  });
  it("draws the PDF in Kaizen's look and in a partner's", async () => {
    const c = cleanGtm(SAMPLE_GTM);
    const kaizen = await renderGtmPdf(c, KAIZEN_BRAND, { name: "De La Hoz, Perez & Barbeito, PLLC", short: "DPB" });
    expect(kaizen.subarray(0, 5).toString()).toBe("%PDF-");
    expect(kaizen.length).toBeGreaterThan(8000);
    const zen = brandFor({ prepared_by: "ZenChange Marketing", brand: { dark: "#0F1F2E", accent: "#178F92" } });
    expect(zen.preparedBy).toBe("ZenChange Marketing");
    const partner = await renderGtmPdf(c, zen, { name: "De La Hoz, Perez & Barbeito, PLLC", short: "DPB" });
    expect(partner.toString("latin1")).not.toMatch(/Kaizen/);
  }, 60_000);
  it("guesses a short name; the writer's own wins", () => {
    expect(shortName("De La Hoz, Perez & Barbeito, PLLC")).toBe("HPB");
    expect(shortName("Glow Med Spa")).toBe("Glow Med Spa");
  });
});

describe("GTM text: encoding", () => {
  it("puts back text that went through a Latin-1 round trip, and leaves clean text alone", async () => {
    const { demojibake } = await import("@/lib/sales-gtm-core");
    expect(demojibake("Days 1-14 Â· Foundation")).toBe("Days 1-14 · Foundation");
    expect(demojibake("Days 1â€“14 Â· Launch â€” test")).toBe("Days 1–14 · Launch — test");
    expect(demojibake("Days 1–14 · Foundation")).toBe("Days 1–14 · Foundation");
  });
});

describe("GTM text: lengths", () => {
  it("never cuts a field mid-sentence", async () => {
    const { fit } = await import("@/lib/sales-gtm-core");
    expect(fit("Short.", 100)).toBe("Short.");
    expect(fit("First sentence is here. Second sentence runs on and on past the limit", 40)).toBe("First sentence is here.");
    expect(fit("one long run of words without any stop at all here", 30)).toBe("one long run of words without…");
  });
});

describe("GTM text: bids and the partner cover", () => {
  it("never shows a $0.00 bid range", () => {
    const c = cleanGtm({ market: { trends: { head: ["Search theme", "Typical CPC", "Monthly volume", "Note"], rows: [["cpa firm", "$0.00-$0.00", "90", ""], ["cpas", "$6.96–$18.45", "210", ""]] } } });
    expect(c.market.trends.rows[0][1]).toBe("No bid data");
    expect(c.market.trends.rows[1][1]).toBe("$6.96–$18.45");
  });
  it("puts the partner's pitcher on the cover, the agency under it", () => {
    const b = brandFor({ prepared_by: "ZenChange Marketing", brand: {}, contact: { name: "Diane", role: "Partner contact" }, pitcher: "Leann" });
    expect(b.preparedLine).toBe("Leann");
    expect(b.preparedBy).toBe("ZenChange Marketing");
  });
});
