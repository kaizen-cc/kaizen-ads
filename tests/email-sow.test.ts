import { describe, expect, it } from "vitest";
import { cleanSow, guardMoney, isEmailSow, ongoingTiers, pricingTable, sameFigure, sowText, tableOf, tierBullets, tierTable, totalEmails, type SowPackage } from "@/lib/email-sow/core";

const PKGS: SowPackage[] = [
  { key: "setup", label: "3-Month Initial Setup", kind: "setup", price_monthly: 1000, campaigns_min: 0, campaigns: 0, flow_emails_min: 0, flow_emails: 0, sms_min: 0, sms: 0, design_hours: null, note: null },
  { key: "basic", label: "Basic", kind: "ongoing", price_monthly: 1000, campaigns_min: 3, campaigns: 5, flow_emails_min: 3, flow_emails: 5, sms_min: 2, sms: 2, design_hours: 15, note: "6 to 10 emails a month." },
  { key: "silver", label: "Silver", kind: "ongoing", price_monthly: 1750, campaigns_min: 7, campaigns: 10, flow_emails_min: 5, flow_emails: 7, sms_min: 4, sms: 6, design_hours: 30, note: "10 to 15 emails a month." },
  { key: "gold", label: "Gold", kind: "ongoing", price_monthly: 2250, campaigns_min: 15, campaigns: 20, flow_emails_min: 5, flow_emails: 10, sms_min: 6, sms: 8, design_hours: 55, note: "20 to 30 emails a month." },
];

describe("Email SOW Generator", () => {
  it("prices the tier table from the package records, a confirmed price winning", () => {
    const t = tierTable(ongoingTiers(PKGS));
    expect(t.head).toEqual(["Included", "Basic", "Silver", "Gold"]);
    expect(t.rows[0]).toEqual(["Monthly price", "$1,000", "$1,750", "$2,250"]);
    expect(t.rows.find((r) => r[0] === "SMS campaign messages")).toEqual(["SMS campaign messages", "2", "4 to 6", "6 to 8"]);
    expect(t.rows.find((r) => r[0] === "Total emails per month")).toEqual(["Total emails per month", "6 to 10", "10 to 15", "20 to 30"]);
    expect(t.rows.find((r) => r[0] === "Design hours included")?.[1]).toBe("Up to 15");
    const confirmed = tierTable(ongoingTiers(PKGS, [{ label: "Silver", amount: 1500, cadence: "month" }]));
    expect(confirmed.rows[0][2]).toBe("$1,500");
  });

  it("never invents an add-on price: placeholder until one is confirmed", () => {
    const basic = ongoingTiers(PKGS)[0];
    const open = pricingTable(basic, ["Full SMS Program (custom scope)"], []);
    expect(open.rows).toEqual([
      ["Basic Package (email management)", "$1,000/month"],
      ["Full SMS Program (custom scope)", "[$XXX]/month"],
    ]);
    expect(open.total).toEqual(["Total monthly investment", "[$X,XXX]/month"]);
    const priced = pricingTable(basic, ["Full SMS Program (custom scope)"], [{ label: "SMS program", amount: 500, cadence: "month" }]);
    expect(priced.rows[1][1]).toBe("$500/month");
    expect(priced.total?.[1]).toBe("$1,500/month");
  });

  it("writes the starting tier's bullets from its record (SMS left out when an add-on replaces it)", () => {
    const basic = ongoingTiers(PKGS)[0];
    const b = tierBullets(basic, "planned around the event calendar", true);
    expect(b[0]).toBe("3 to 5 campaign emails per month, planned around the event calendar");
    expect(b.some((x) => /SMS/.test(x))).toBe(false);
    expect(b.at(-1)).toBe("Total: 6 to 10 emails per month");
    expect(totalEmails(PKGS[2])).toBe("10 to 15");
  });

  it("scrubs made-up prices from the text, keeps the client's own revenue and tier multiples", () => {
    expect(guardMoney("Revenue hit $33,180.31, over $33,000. Silver is $1,999 a month.", [33180.31, 1000, 3000])).toBe("Revenue hit $33,180.31, over $33,000. Silver is [$X,XXX] a month.");
    expect(sameFigure(19876.4, 20000)).toBe(true);
    expect(sameFigure(19876.4, 25000)).toBe(false);
    expect(sameFigure(19876.4, 19900)).toBe(true);
  });

  it("makes tables strict and routes only email SOWs and pitches here", () => {
    const t = tableOf({ head: ["Metric", "Current"], rows: [["Bounce rate", "2.64%", "extra"], [""]], total: null });
    expect(t).toEqual({ head: ["Metric", "Current"], rows: [["Bounce rate", "2.64%"]], total: null });
    expect(tableOf({ head: ["Only"], rows: [["x"]] })).toBeNull();
    expect(isEmailSow("sow", "email")).toBe(true);
    expect(isEmailSow("proposal", undefined)).toBe(true);
    expect(isEmailSow("sow", "meta")).toBe(false);
    expect(isEmailSow("handoff", "email")).toBe(false);
  });

  it("cleans a generator answer into the reference structure", () => {
    const sow = cleanSow(
      {
        contact: "",
        subtitle: "",
        recap: { heading: "x", paragraphs: ["The sprint is done — and live."], stats: [{ value: "$33,180", label: "Klaviyo attributed revenue" }], built: [{ lead: "Unified list", text: "One list." }] },
        numbers: null,
        deliverability: { paragraphs: ["Score: [XX]."], metrics: null, levers: [] },
        scope: { intro: "Now the revenue comes from what we send.", start_tier: "basic", add_ons: [{ item: "Full SMS Program (custom scope)", replaces_tier_sms: true }], start_text: "", tier_bullet_context: "", included: [{ heading: "What's Included: Full SMS Program (Custom Scope)", intro: "Kaizen takes over all SMS.", bullets: ["Up to 8 SMS campaigns per month"] }], tiers_note: "", path_text: "Basic builds trust.", triggers: { head: ["Milestone", "Target", "Why It Matters"], rows: [["Revenue", "At least $3,000/month", "Pays for itself"]], total: null }, triggers_callout: "", ninety_days: null, needs: [], out_of_scope: [], roadmap_intro: "", roadmap: [] },
        closing: { paragraph: "Let's grow 1% every single day.", next_steps: [] },
      },
      { client: "The Yost", contact: null, dated: "November 2026", packages: PKGS, confirmed: [], dataFigures: [33180.31], platform: "Email & SMS Marketing | Klaviyo" },
    );
    expect(sow.contact).toBe("[Client Contact]");
    expect(sow.recap?.paragraphs[0]).toBe("The sprint is done, and live.");
    expect(sow.recap?.built[0].lead).toBe("Unified list.");
    expect(sow.scope.startHeading).toBe("Recommended Starting Point: Basic Package + Full SMS Program");
    expect(sow.scope.included[0].heading).toBe("What's Included: Basic Package (Email)");
    expect(sow.scope.included).toHaveLength(2);
    expect(sow.scope.nextTier).toBe("Silver");
    expect(sow.scope.triggers?.rows[0][1]).toBe("At least $3,000/month");
    expect(sow.placeholders).toEqual(expect.arrayContaining(["[Client Contact]", "[XX]", "[$XXX]", "[$X,XXX]", "[Start Date]"]));
    expect(sowText(sow)).toContain("The Path to Silver");
  });
});
