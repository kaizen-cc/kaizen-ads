import { describe, expect, it } from "vitest";
import { briefText, clampScore, cleanBrief, cleanPitch, cleanReview, cleanSite, fitBand, forwardStatus, isProspectStatus, nameKey, prospectFolderName, sameBusiness, siteHost, worksSales } from "@/lib/sales-core";
import { ROLE_SKILLS, canTalkToAgent, canTrainAgent, roleOfAgent } from "@/lib/agent-access";
import { lineOfRole } from "@/lib/agent-lines";
import { SCREEN_PLACES, SPECIALISTS, suggestSpecialist } from "@/lib/assistant/core";
import { mayOpen } from "@/lib/ai-access-core";
import { CALL_ROLES } from "@/lib/agent-call/call-context";

const exec = { role: "coo", isExec: true, isLead: false };
const lead = { role: "head_of_meta", isExec: false, isLead: true };
const member = { role: "media_buyer", isExec: false, isLead: false };

describe("sales agent: who sees it", () => {
  it("is a role agent with five skills, in the strategy line, with a call look", () => {
    expect(ROLE_SKILLS.sales).toEqual(["sales_research", "sales_list", "sales_pitch", "sales_call_review", "sales_desk"]);
    expect(roleOfAgent("sales_pitch")).toBe("sales");
    expect(lineOfRole("sales")).toBe("strategy");
    expect(CALL_ROLES.sales.label).toBe("Sales");
  });
  it("execs and leads talk to it; the rest of the team doesn't", () => {
    expect(canTalkToAgent(exec, "sales")).toBe(true);
    expect(canTalkToAgent(lead, "sales")).toBe(true);
    expect(canTalkToAgent(member, "sales")).toBe(false);
    // Other agents stay open to everyone
    expect(canTalkToAgent(member, "media_buyer")).toBe(true);
  });
  it("only the execs train it", () => {
    expect(canTrainAgent(exec, "sales")).toBe(true);
    expect(canTrainAgent(lead, "sales")).toBe(false);
    expect(canTrainAgent(lead, "sales_research")).toBe(false);
  });
  it("worksSales and the /sales page follow the same rule", () => {
    expect(worksSales(exec)).toBe(true);
    expect(worksSales(lead)).toBe(true);
    expect(worksSales(member)).toBe(false);
    expect(worksSales(null)).toBe(false);
    expect(mayOpen("/sales", exec).ok).toBe(true);
    expect(mayOpen("/sales/abc", lead).ok).toBe(true);
    expect(mayOpen("/sales", member).ok).toBe(false);
  });
  it("the assistant suggests the Sales agent only to execs and leads, and can open its screens", () => {
    expect(SPECIALISTS.some((s) => s.key === "sales")).toBe(true);
    expect(suggestSpecialist("build me a prospect list and a pitch", null, exec)?.key).toBe("sales");
    expect(suggestSpecialist("build me a prospect list and a pitch", null, member)?.key).not.toBe("sales");
    expect(suggestSpecialist("build me a prospect list and a pitch")?.key).not.toBe("sales");
    expect(SCREEN_PLACES.prospects).toBe("/sales");
    expect(SCREEN_PLACES["sales agent"]).toBe("/settings?tab=agents&role=sales#talk");
  });
});

describe("sales agent: prospects", () => {
  it("keeps websites in one form", () => {
    expect(cleanSite("www.GlowMedSpa.com/about")).toBe("https://glowmedspa.com");
    expect(cleanSite("http://example.co.uk")).toBe("https://example.co.uk");
    expect(cleanSite("not a site")).toBeNull();
    expect(cleanSite("")).toBeNull();
    expect(siteHost("https://www.example.com/x")).toBe("example.com");
  });
  it("matches a won prospect to its client by site, else by name", () => {
    expect(sameBusiness({ name: "Glow", website: "glow.com" }, { name: "Something else", website: "https://www.glow.com" })).toBe(true);
    expect(sameBusiness({ name: "Glow", website: "glow.com" }, { name: "Glow", website: "glowspa.com" })).toBe(false);
    expect(sameBusiness({ name: "Glow Med Spa LLC" }, { name: "Glow Med Spa" })).toBe(true);
    expect(sameBusiness({ name: "Glow Med Spa" }, { name: "Glow Med Spa Tampa" })).toBe(true);
    expect(sameBusiness({ name: "Bob" }, { name: "Bobs Burgers" })).toBe(false);
    expect(nameKey("The Smith & Co.")).toBe("smithand");
  });
  it("scores in 0..100 with bands", () => {
    expect(clampScore(140)).toBe(100);
    expect(clampScore("62.4")).toBe(62);
    expect(clampScore("x")).toBeNull();
    expect(fitBand(80)).toBe("strong");
    expect(fitBand(55)).toBe("possible");
    expect(fitBand(10)).toBe("weak");
    expect(fitBand(null)).toBe("unscored");
  });
  it("stages only move forward on their own; won and lost stick", () => {
    expect(forwardStatus("talking", "researched")).toBe("talking");
    expect(forwardStatus("new", "researched")).toBe("researched");
    expect(forwardStatus("contacted", "proposal")).toBe("proposal");
    expect(forwardStatus("won", "talking")).toBe("won");
    expect(forwardStatus("talking", "lost")).toBe("lost");
    expect(isProspectStatus("proposal")).toBe(true);
    expect(isProspectStatus("closed")).toBe(false);
  });
  it("cleans a brief and reads it back as text", () => {
    const b = cleanBrief({
      summary: "A two-location med spa with no paid ads.",
      sells: "Botox, fillers, facials",
      locations: ["Tampa", "Clearwater"],
      marketing: { site: "Good mobile site", meta_ads: "None in the Meta Ad Library", google_ads: "", email_capture: "No popup" },
      gaps: ["No paid ads running", ""],
      fit_score: 120,
      fit_reason: "High ticket, strong reviews",
      strategy: { services: [{ service: "Meta advertising package", why: "No ads running", price: "$1,000/month" }, { why: "no name" }], angle: "You're invisible on Instagram", proof: ["A med spa on Meta: leads under target"], talking_points: ["4.9 stars from 300 reviews"] },
      contacts: [{ name: "Dr. Ana Ruiz", role: "Owner", where: "About page" }, { role: "nameless" }],
    });
    expect(b.fit_score).toBe(100);
    expect(b.gaps).toEqual(["No paid ads running"]);
    expect(b.strategy.services).toHaveLength(1);
    expect(b.contacts).toHaveLength(1);
    expect(b.marketing.offers).toBe("");
    const t = briefText("Glow", b);
    expect(t).toMatch(/Glow: A two-location med spa/);
    expect(t).toMatch(/Meta advertising package \(\$1,000\/month\)/);
    expect(t).toMatch(/Proof \(internal\)/);
    expect(t).not.toMatch(/Offers:/);
  });
  it("keeps the LinkedIn connection note within LinkedIn's 300 characters", () => {
    const p = cleanPitch({ linkedin: { connection_note: "x".repeat(400), message: "hi" }, email: { subject: "s", body: "b" }, call_script: { opener: "o", questions: ["q"], objections: [{ objection: "too pricey", answer: "a" }, { answer: "no objection" }] } });
    expect(p.linkedin.connection_note.length).toBe(300);
    expect(p.call_script.objections).toHaveLength(1);
  });
  it("cleans a call review and ignores an unknown stage", () => {
    const r = cleanReview({ summary: "Warm", next_steps: [{ step: "Send proposal", who: "Kaizen", when: "Friday" }, { who: "x" }], proposal: { send: true, services: ["Meta"] }, stage: "maybe" });
    expect(r.next_steps).toHaveLength(1);
    expect(r.proposal.send).toBe(true);
    expect(r.stage).toBeNull();
  });
  it("makes a safe Drive folder name", () => {
    expect(prospectFolderName('Glow / Med: "Spa"')).toBe("Glow Med Spa");
  });
});
