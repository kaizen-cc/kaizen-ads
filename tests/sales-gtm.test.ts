import { describe, expect, it } from "vitest";
import { BASIC_CREATIVE, cleanGtm, cleanNotes, feeMentions, GTM_FILE, kaizenMentions, notesText, pickCaseStudies, scrubKaizen, shortName, tierPlan, verticalOf, type CaseStudy } from "@/lib/sales-gtm-core";
import { brandFor, KAIZEN_BRAND, renderGtmPdf } from "@/lib/sales-gtm-pdf";

const studies: CaseStudy[] = [
  { key: "gumbys", name: "Gumby's Pizza", vertical: "Restaurant", fits: ["restaurant", "pizza", "local"], services: "", results: "4.2x ROAS", connection: "" },
  { key: "aldecoa", name: "Aldecoa Coffee", vertical: "Ecom", fits: ["ecommerce", "dtc", "coffee"], services: "", results: "$135,000+", connection: "" },
  { key: "allamerican", name: "All American Fence And Gate", vertical: "Home services", fits: ["fence", "contractor", "home services"], services: "", results: "10.8x", connection: "" },
  { key: "marquee", name: "Marquee Dental", vertical: "Professional", fits: ["dental", "accounting", "cpa", "law"], services: "", results: "21.1x ROAS", connection: "" },
];

export const SAMPLE_GTM = {
  cover: { short: "DPB", eyebrow: "GO-TO-MARKET STRATEGY · PAID MEDIA OVERVIEW", headline: "Turning 30 years of big-firm expertise into", highlight: "a predictable client pipeline.", subtitle: "Meta + Google Ads strategy, positioning, and 90-day launch plan", location: "Coral Gables, Florida", site: "dpbcpa.com", date: "November 2026" },
  exec: { lede: "DPB already has what most firms are trying to buy.", stats: [{ value: "0", label: "Meta ads found (Nov 2026)" }, { value: "13", label: "Google reviews" }, { value: "#1", label: "Miami-Dade rank" }], opportunity: "South Florida is producing new businesses.", recommend: [{ lead: "One front door", text: "A Tax Strategy Review." }], why_now: "Click prices rise Jan-Apr." },
  who: { title: "A mid-market firm with a big-firm bench", lede: "", table: { head: ["What we found", "Why it matters"], rows: [["11 partners", "The headline"]], note: "" }, sources: "dpbcpa.com" },
  footprint: { title: "Where the pipeline is leaking today", lede: "", table: { head: ["Area", "Current state", "Fix"], rows: [["Paid social", "No ads", "Launch Meta"]], note: "" }, bottom_line: "Ads amplify whatever they point to." },
  market: { title: "South Florida is creating clients", lede: "", stats: [{ value: "665,668", label: "New FL businesses 2025" }], avatar: "Owner-operators 35-60.", tam: "About 40,000 owner-run firms (estimate).", implications: [{ lead: "New businesses", text: "need a planner." }], competitors: { head: ["Competitor type", "How they win", "Where DPB wins"], rows: [["National firms", "Brand", "Partner access"]], note: "" }, trends: { head: ["Search theme", "Typical CPC", "Monthly volume", "Note"], rows: [["business cpa miami", "$18-48", "1,300", "peaks Mar"]], note: "" }, sources: "Wolters Kluwer" },
  positioning: { title: "Lead with the partners", lede: "", services: { head: ["Service line", "CPC", "Value", "Competition", "Role"], rows: [["Business tax", "$18-48", "High", "High", "Front door"]], note: "*Directional" }, core: "Big-firm minds. A partner on your file.", offer: { name: "The DPB Tax Strategy Review", text: "A 30-minute call.", why: "Easy yes." }, pillars: [{ lead: "Pedigree", text: "Big Four training." }] },
  channels: { title: "How Meta and Google work together", lede: "", google: { head: ["Campaign", "Themes", "Landing page"], rows: [["Business tax", "business CPA Miami", "Review"]], note: "" }, google_note: "Negatives.", meta: { head: ["Lane", "Who", "Angle"], rows: [["Owners", "Tri-county", "Pedigree"]], note: "" }, creative: { title: "Creative package (basic)", text: "The 310: 3 images + 10 videos a month." } },
  investment: { title: "Recommended ad spend", lede: "Ad spend only.", tiers: { head: ["", "Launch", "Recommended", "Accelerate"], rows: [["Total", "$5,000", "$8,000", "$12,000"]], note: "" }, assumptions: "CPC $12-20.", benchmarks: { head: ["Metric", "Finance", "Business services"], rows: [["CTR", "9.83%", "6.10%"]], note: "" }, benchmarks_note: "WordStream/LocaliQ 2026.", math: "One client a month covers media." },
  plan: { title: "What happens after DPB says yes", ninety: { head: ["Phase", "What we do", "What DPB sees"], rows: [["Days 1-14", "Tracking", "Measurable"]], note: "" }, calendar: { head: ["Window", "Market", "Focus"], rows: [["Dec", "Year-end", "Act before Dec 31"]], note: "" } },
  measure: { title: "How we'll judge success", table: { head: ["Checkpoint", "Measure", "On track"], rows: [["Day 30", "Leads", "In range"]], note: "" }, note: "Cycles run 30-90 days.", needs: ["Headshots"], next: [{ lead: "Align", text: "on a tier" }], one_line: "DPB has the credentials." },
  sources: ["WordStream/LocaliQ 2026 Search Advertising Benchmarks"],
};

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
