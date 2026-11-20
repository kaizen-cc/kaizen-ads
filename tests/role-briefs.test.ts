import { describe, expect, it } from "vitest";
import { ROLE_BRIEFS, roleBriefBlock, toolFitsRole } from "@/lib/assistant/role-briefs";
import { ROLES } from "@/lib/roles";

describe("role briefs", () => {
  it("covers every role on the team", () => {
    expect(ROLES.map((r) => r.value).filter((r) => !ROLE_BRIEFS[r])).toEqual([]);
  });
  it("keeps the tracking specialist on tracking", () => {
    const b = roleBriefBlock("tracking_specialist");
    expect(b).toContain("conversions");
    expect(b).toMatch(/Leave alone[^\n]*creative/);
  });
  it("gives the support positions no creative tools", () => {
    expect(toolFitsRole("tracking_specialist", "create_brief")).toBe(false);
    expect(toolFitsRole("onboarding_specialist", "suggest_bible_change")).toBe(false);
    expect(toolFitsRole("customer_success", "support_board")).toBe(true);
    expect(toolFitsRole("graphic_designer", "create_brief")).toBe(true);
  });
  it("never names a person", () => {
    // Product and role words aside, nothing reads like a person's first and last name
    const terms = /\b(Google Ads|Google|Meta|Brand Bibles?|Client Success Coordinator|Onboarding Specialist|Tracking Specialist|My team|Email Board|TikTok)\b/g;
    for (const b of Object.values(ROLE_BRIEFS)) expect(`${b.duties} ${b.matters} ${b.ignore}`.replace(terms, "x")).not.toMatch(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
  });
});
