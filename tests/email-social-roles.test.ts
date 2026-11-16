import { describe, expect, it } from "vitest";
import { CHANNEL_NAV, ROLES, SLOTS, canAlsoDesignEmail, canAlsoSocial, canHold, canSeeReports, channelNavOk, isChannelOnly, isEmailRole, isSocialRole, lineOfTeam, roleLabel, seatOffered, slotService, tierOf } from "@/lib/roles";

const seat = (v: string) => SLOTS.find((s) => s.value === v)!;

describe("the email and organic social positions", () => {
  it("are listed with their labels and tiers", () => {
    expect(roleLabel("head_of_social")).toBe("Head of Organic Social");
    expect(roleLabel("social_media_manager")).toBe("Social media manager");
    expect(roleLabel("head_of_email")).toBe("Head of Email");
    expect(roleLabel("email_strategist")).toBe("Email strategist");
    expect(roleLabel("email_designer")).toBe("Email designer");
    expect(roleLabel("email_builder")).toBe("Email builder");
    expect(tierOf("head_of_social")).toBe("leader");
    expect(tierOf("head_of_email")).toBe("leader");
    for (const r of ["social_media_manager", "email_strategist", "email_designer", "email_builder"] as const) expect(tierOf(r)).toBe("member");
    expect(new Set(ROLES.map((r) => r.value)).size).toBe(ROLES.length);
  });

  it("know their line of work", () => {
    expect(lineOfTeam("head_of_email")).toBe("email");
    expect(lineOfTeam("email_builder")).toBe("email");
    expect(lineOfTeam("head_of_social")).toBe("social");
    expect(lineOfTeam("social_media_manager")).toBe("social");
    for (const r of ["executive", "media_buyer", "graphic_designer", "head_of_creative", "copywriter", null, undefined]) expect(lineOfTeam(r)).toBeNull();
    expect(isEmailRole("email_designer")).toBe(true);
    expect(isEmailRole("head_of_social")).toBe(false);
    expect(isSocialRole("head_of_social")).toBe(true);
    expect(isChannelOnly("email_strategist")).toBe(true);
    expect(isChannelOnly("head_of_meta")).toBe(false);
  });

  it("get reports (their own clients), alongside the existing report roles", () => {
    expect(canSeeReports({ role: "head_of_email" })).toBe(true);
    expect(canSeeReports({ role: "social_media_manager" })).toBe(true);
    expect(canSeeReports({ role: "media_buyer" })).toBe(true);
    expect(canSeeReports({ role: "graphic_designer" })).toBe(false);
    expect(canSeeReports({ role: "copywriter" })).toBe(false);
  });

  it("see only Overview, Clients, KPIs, Reports and Kaizen AI in the menu", () => {
    for (const h of CHANNEL_NAV) expect(channelNavOk(h)).toBe(true);
    for (const h of ["/board", "/board?view=kpis", "/ideas", "/lab", "/settings"]) expect(channelNavOk(h)).toBe(false);
    expect([...CHANNEL_NAV].sort()).toEqual(["/ai", "/clients", "/kpis", "/pipeline", "/reports"]);
  });
});

describe("the email and social seats", () => {
  it("belong to a service and are offered only on clients that buy it", () => {
    expect(slotService("social_manager")).toBe("social-media");
    expect(slotService("social_creative")).toBe("social-media");
    for (const s of ["email_strategist", "email_designer", "email_builder"]) expect(slotService(s)).toBe("email-marketing");
    expect(slotService("meta_buyer")).toBeNull();
    expect(seatOffered("social_manager", ["social-media"])).toBe(true);
    expect(seatOffered("social_manager", ["email-marketing"])).toBe(false);
    expect(seatOffered("email_builder", ["email-marketing", "creative"])).toBe(true);
    expect(seatOffered("email_builder", ["facebook-ads"])).toBe(false);
    // the existing seats have no service of their own here
    expect(seatOffered("meta_buyer", [])).toBe(true);
  });

  it("are held by the right positions", () => {
    expect(canHold(seat("social_manager"), { role: "social_media_manager" })).toBe(true);
    expect(canHold(seat("social_manager"), { role: "head_of_social" })).toBe(true);
    expect(canHold(seat("social_manager"), { role: "head_of_email" })).toBe(false);
    expect(canHold(seat("email_strategist"), { role: "email_strategist" })).toBe(true);
    expect(canHold(seat("email_strategist"), { role: "head_of_email" })).toBe(true);
    expect(canHold(seat("email_strategist"), { role: "email_builder" })).toBe(false);
    expect(canHold(seat("email_builder"), { role: "email_builder" })).toBe(true);
    expect(canHold(seat("email_builder"), { role: "email_designer" })).toBe(false);
    expect(canHold(seat("email_designer"), { role: "email_designer" })).toBe(true);
    expect(canHold(seat("email_designer"), { role: "head_of_email" })).toBe(true);
  });

  it("give the social creative seat only to creatives with also_social on", () => {
    for (const role of ["graphic_designer", "lead_graphic_designer", "video_editor", "lead_video_editor", "head_of_creative"]) {
      expect(canHold(seat("social_creative"), { role })).toBe(false);
      expect(canHold(seat("social_creative"), { role, also_social: false })).toBe(false);
      expect(canHold(seat("social_creative"), { role, also_social: true })).toBe(true);
    }
    // the switch means nothing for someone outside the creative roles
    expect(canHold(seat("social_creative"), { role: "media_buyer", also_social: true })).toBe(false);
    expect(canHold(seat("social_creative"), { role: "social_media_manager", also_social: true })).toBe(false);
  });

  it("give the email designer seat to an email builder only with also_designs_email on", () => {
    expect(canHold(seat("email_designer"), { role: "email_builder" })).toBe(false);
    expect(canHold(seat("email_designer"), { role: "email_builder", also_designs_email: true })).toBe(true);
    expect(canHold(seat("email_designer"), { role: "graphic_designer", also_designs_email: true })).toBe(false);
  });

  it("leave the existing seats as they were", () => {
    expect(canHold(seat("meta_buyer"), { role: "executive", also_buys: true })).toBe(true);
    expect(canHold(seat("meta_buyer"), { role: "executive" })).toBe(false);
    expect(canHold(seat("graphic_designer"), { role: "graphic_designer", also_social: true })).toBe(true);
    expect(canHold(seat("meta_buyer"), { role: "email_builder", also_social: true, also_designs_email: true })).toBe(false);
  });
});

describe("the per-person switches", () => {
  it("apply only to their positions", () => {
    for (const r of ["graphic_designer", "lead_graphic_designer", "video_editor", "lead_video_editor", "head_of_creative"]) expect(canAlsoSocial(r)).toBe(true);
    for (const r of ["media_buyer", "executive", "social_media_manager", "email_builder"]) expect(canAlsoSocial(r)).toBe(false);
    expect(canAlsoDesignEmail("email_builder")).toBe(true);
    for (const r of ["email_designer", "head_of_email", "graphic_designer"]) expect(canAlsoDesignEmail(r)).toBe(false);
  });
});
