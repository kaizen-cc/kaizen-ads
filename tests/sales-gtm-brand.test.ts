import { describe, expect, it } from "vitest";
import { cleanGtm, modeLabel, partnerCredited, RELATIONSHIP_QUESTION } from "@/lib/sales-gtm-core";
import { brandFor, kaizenBrand, renderGtmPdf } from "@/lib/sales-gtm-pdf";
import { SAMPLE_GTM } from "./fixtures/gtm-sample";

const zen = { key: "zenchange", name: "ZenChange", website: "https://zenchange.com" };

describe("GTM branding: direct or white label", () => {
  it("asks once, in the owner's words, when the record doesn't say", () => {
    expect(RELATIONSHIP_QUESTION).toBe("Is this a direct Kaizen deal or a white-label pitch for a partner agency?");
  });
  it("detects a partner credited on the prospect's site", () => {
    expect(partnerCredited("footer: Powered by ZenChange. Forms run on links.zenchange.com", zen)).toBe(true);
    expect(partnerCredited("website by zenchange", zen)).toBe(true);
    expect(partnerCredited("form action https://links.zenchange.com/widget", zen)).toBe(true);
    expect(partnerCredited("a CPA firm in Coral Gables", zen)).toBe(false);
  });
  it("shows which mode is active", () => {
    expect(modeLabel("direct", null)).toBe("Direct · Kaizen branding");
    expect(modeLabel("white_label", "ZenChange")).toBe("White label · ZenChange");
    expect(modeLabel(null, null)).toBe("Branding not set");
  });
  it("Kaizen's look: its colors, fonts, logo, tagline and the CEO under Prepared by", () => {
    const b = kaizenBrand({ name: "Kyle Barry", title: "CEO & Founder", tagline: "The 1% Agency" });
    expect(b).toMatchObject({ mode: "kaizen", accent: "#B21E2C", dark: "#060606", accentSoft: "#F2F2F2", page: "#FAFAFA", tagline: "The 1% Agency", preparedLine: "Kyle Barry, CEO & Founder" });
    // Headlines in GT Flexa (the Osake file holds only the "ads" wordmark letters), body in Helvetica (GT Flexa has no punctuation)
    expect(b.fonts.display).toBe("GT Flexa");
    expect(b.fonts.body).toBe("Helvetica");
    expect(b.logo).toMatch(/^data:image\/png;base64,/);
  });
  it("a partner's look: its kit, its contact, nothing of Kaizen's", () => {
    const b = brandFor({ prepared_by: "ZenChange Marketing", brand: { accent: "#178F92", dark: "#0F1F2E" }, contact: { name: "Diane", role: "Partner contact" } });
    expect(b).toMatchObject({ mode: "partner", preparedBy: "ZenChange Marketing", preparedLine: "Diane, Partner contact", accent: "#178F92", logo: null, tagline: null });
    expect(JSON.stringify(b)).not.toMatch(/kaizen/i);
  });
  it("draws both, the Kaizen one in its own fonts and logo", async () => {
    const c = cleanGtm(SAMPLE_GTM);
    const k = await renderGtmPdf(c, kaizenBrand({ name: "Kyle Barry", title: "CEO & Founder", tagline: "The 1% Agency" }), { name: "De La Hoz, Perez & Barbeito, PLLC", short: "DPB" });
    expect(k.subarray(0, 5).toString()).toBe("%PDF-");
    expect(k.toString("latin1")).toMatch(/Osake|GTFlexa|GT-Flexa/);
  }, 60_000);
});
