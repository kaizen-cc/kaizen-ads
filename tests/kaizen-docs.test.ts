import { describe, expect, it } from "vitest";
import { kdocHtml, footerText } from "@/lib/kaizen-docs/html";
import { deckRequests, blockHeight } from "@/lib/kaizen-docs/slides";
import { cleanBlock, cleanKDoc, guardPrices, mayMake, pickTemplate, PRICE_TBD, subsetSums, TEMPLATES, type KDoc } from "@/lib/kaizen-docs/templates";
import { emailSowToKDoc } from "@/lib/kaizen-docs/email-sow";
import { cleanSow, type SowPackage } from "@/lib/email-sow/core";

const ctx = { client: "Aesthetic Edge", preparedBy: "Kaizen Marketing Agency", dated: "November 2026", figures: [] as number[] };

describe("Kaizen document system: templates", () => {
  it("picks the template from what was asked, null when unclear", () => {
    expect(pickTemplate("Put together a relaunch proposal to pitch Aesthetic Edge")).toBe("proposal");
    expect(pickTemplate("quote for Michelle's new website")).toBe("quote");
    expect(pickTemplate("SOW for the Klaviyo sprint with tier options")).toBe("sow");
    expect(pickTemplate("an onboarding plan for the client")).toBe("doc");
    expect(pickTemplate("make me something for them")).toBeNull();
  });

  it("keeps proposals, quotes and SOWs to the executives and line heads", () => {
    const strategist = { isExec: false, isLead: false, role: "email_strategist" };
    expect(mayMake("proposal", strategist)).toBe(false);
    expect(mayMake("doc", strategist)).toBe(true);
    expect(mayMake("sow", { isExec: false, isLead: false, role: "head_of_email" })).toBe(true);
    expect(TEMPLATES.proposal.output).toBe("slides");
    expect(TEMPLATES.quote.sections).toHaveLength(14);
  });

  it("only quotes stored or confirmed prices; totals may add them up", () => {
    const allowed = subsetSums([6000, 1000, 2000]);
    expect(guardPrices("Website $6,000, setup $1,000, total $7,000; media $3,500", allowed)).toBe(`Website $6,000, setup $1,000, total $7,000; media ${PRICE_TBD}`);
    expect(allowed).toContain(9000);
  });

  it("cleans the AI's document into the template's order, required sections kept", () => {
    const doc = cleanKDoc(
      {
        title: "Aesthetic Edge Relaunch — Growth Proposal",
        subtitle: "",
        kicker: "",
        prepared_for: "",
        sections: [
          { key: "investment", heading: "Investment", lede: "Relationship pricing, as discussed.", blocks: [{ type: "table", text: "", items: [], head: ["Scope", "Investment"], rows: [["Website build", "$6,000"], ["Meta management", "$1,200/mo"]], total: ["Total", "$7,200"], columns: [], weeks: 0 }] },
          { key: "executive_summary", heading: "Executive Summary", lede: "A true relaunch.", blocks: [{ type: "stats", text: "", items: [{ lead: "Day 10", text: "First campaigns live" }], head: [], rows: [], total: null, columns: [], weeks: 0 }] },
        ],
      },
      { ...ctx, template: "proposal", prices: [{ label: "Website", amount: 6000, cadence: "one_time", source: "confirmed" }] },
    );
    expect(doc.title).toBe("Aesthetic Edge Relaunch, Growth Proposal");
    expect(doc.sections[0].key).toBe("executive_summary");
    expect(doc.sections.map((s) => s.key)).not.toContain("mission");
    expect(doc.sections.find((s) => s.key === "methodology")?.blocks[0]).toEqual({ type: "paragraph", text: "[To be written]" });
    const inv = doc.sections.find((s) => s.key === "investment")!.blocks[0];
    expect(inv.type === "table" && inv.rows[1][1]).toBe(`${PRICE_TBD}/mo`);
    expect(inv.type === "table" && inv.total?.[1]).toBe(PRICE_TBD);
    expect(doc.preparedFor).toBe("[Client Contact], Aesthetic Edge");
    expect(doc.relationshipPricing).toBe(true);
    expect(doc.placeholders).toContain(PRICE_TBD);
  });

  it("reads gantt rows from week ranges", () => {
    expect(cleanBlock({ type: "gantt", weeks: 6, items: [{ lead: "Design", text: "2-3" }, { lead: "Launch", text: "6" }] })).toEqual({ type: "gantt", weeks: 6, rows: [{ task: "Design", start: 2, end: 3 }, { task: "Launch", start: 6, end: 6 }] });
  });
});

const sample = (template: KDoc["template"]): KDoc => ({
  template,
  title: "Your New Website",
  subtitle: "A site built to book more clients",
  client: "Michelle Behre Photography",
  preparedFor: "Michelle Behre",
  preparedBy: "Kaizen Marketing Agency",
  dated: "November 2026",
  kicker: "Web Development Proposal",
  sections: [
    { key: "description", heading: "Description", lede: "", blocks: [{ type: "paragraph", text: "This project covers <the> build." }] },
    { key: "cost_summary", heading: "Cost Summary", lede: "", blocks: [{ type: "table", head: ["Item", "Cost"], rows: Array.from({ length: 20 }, (_, i) => [`Item ${i}`, "$100"]), total: ["Total", "$2,000"] }, { type: "total", label: "TOTAL INVESTMENT", value: "$2,000" }] },
  ],
  placeholders: [],
  relationshipPricing: false,
});

describe("Kaizen document system: drawing", () => {
  it("draws a quote with numbered sections, the total bar and the approval page; text escaped", () => {
    const html = kdocHtml(sample("quote"), { logo: "https://x/logo.png", markWhite: "https://x/mark.png" });
    expect(html).toContain("KAIZEN MARKETING x MICHELLE BEHRE PHOTOGRAPHY");
    expect(html).toContain(">01</td>");
    expect(html).toContain("TOTAL INVESTMENT");
    expect(html).toContain("Approval of Proposal");
    expect(html).toContain("&lt;the&gt;");
    expect(footerText(sample("quote"))).toContain("valid for 30 days");
  });

  it("draws a SOW with the red cover and the house line", () => {
    const html = kdocHtml(sample("sow"), { logo: "https://x/logo.png", markWhite: "https://x/mark.png" });
    expect(html).toContain("Kaizen x Michelle Behre Photography");
    expect(html).toContain("Get 1% better every day.");
    expect(html).toContain("background-color:#B21E2C");
    expect(footerText(sample("sow"))).toBe("Kaizen x Michelle Behre Photography | Scope of Work  ");
  });

  it("builds a deck: a black cover, a slide per section, a long table carried to the next slide", () => {
    const { requests, slides } = deckRequests(sample("proposal"), "t");
    expect(slides).toBeGreaterThanOrEqual(4);
    const created = requests.filter((r) => "createSlide" in r).length;
    expect(created).toBe(slides);
    expect(JSON.stringify(requests)).toContain("Cost Summary (continued)");
    expect(blockHeight({ type: "stats", items: [] })).toBe(74);
    const ids = requests.flatMap((r) => Object.values(r).map((v) => (v as { objectId?: string }).objectId).filter(Boolean));
    const made = requests.filter((r) => "createShape" in r || "createSlide" in r || "createTable" in r).map((r) => (Object.values(r)[0] as { objectId: string }).objectId);
    expect(new Set(made).size).toBe(made.length);
    expect(ids.length).toBeGreaterThan(made.length);
  });

  it("folds an email SOW into the Scope of Work look", () => {
    const pkgs: SowPackage[] = [{ key: "basic", label: "Basic", kind: "ongoing", price_monthly: 1000, campaigns_min: 3, campaigns: 5, flow_emails_min: 3, flow_emails: 5, sms_min: 2, sms: 2, design_hours: 15, note: "6 to 10 emails a month." }];
    const sow = cleanSow({ scope: { start_tier: "basic", add_ons: [] }, closing: {} }, { client: "The Yost", contact: null, dated: "November 2026", packages: pkgs, confirmed: [], dataFigures: [], platform: "Email & SMS Marketing | Klaviyo" });
    const doc = emailSowToKDoc(sow, "Kaizen Marketing Agency");
    expect(doc.template).toBe("sow");
    expect(doc.kicker).toBe("Scope of Work | Email & SMS Marketing | Klaviyo");
    expect(doc.sections.map((s) => s.heading)).toEqual(["Building on the Momentum", "Let's Keep It Rolling"]);
    expect(JSON.stringify(doc)).toContain("$1,000/month");
  });
});
