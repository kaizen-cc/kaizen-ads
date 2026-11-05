import { describe, expect, it } from "vitest";
import { ROLES, SLOTS, baseRole, canHold, isLeadMaker, roleLabel, tierOf, worksAs } from "@/lib/roles";
import { agentForRole, groupsFor } from "@/lib/kaizen-ai/agents";
import { canGenerateMedia } from "@/lib/media-models";

// The owner's rule: a lead graphic designer and a lead video editor work exactly like their base role (same tier,
// formats, permissions); the only difference is that any client is an option for them (in the database, can_see_client).

describe("lead makers", () => {
  it("are named and sit in the team tier, like their base role", () => {
    expect(roleLabel("lead_graphic_designer")).toBe("Lead graphic designer");
    expect(roleLabel("lead_video_editor")).toBe("Lead video editor");
    expect(tierOf("lead_graphic_designer")).toBe("member");
    expect(tierOf("lead_video_editor")).toBe(tierOf("video_editor"));
    expect(ROLES.filter((r) => r.value.startsWith("lead_")).map((r) => r.value)).toEqual(["lead_graphic_designer", "lead_video_editor"]);
  });
  it("are told apart from everyone else", () => {
    expect(isLeadMaker("lead_graphic_designer")).toBe(true);
    expect(isLeadMaker("lead_video_editor")).toBe(true);
    for (const r of ["graphic_designer", "video_editor", "head_of_creative", "executive", "", null, undefined]) expect(isLeadMaker(r)).toBe(false);
  });
  it("work as their base role", () => {
    expect(baseRole("lead_graphic_designer")).toBe("graphic_designer");
    expect(baseRole("lead_video_editor")).toBe("video_editor");
    expect(baseRole("media_buyer")).toBe("media_buyer");
    expect(baseRole(null)).toBeNull();
    expect(worksAs("lead_graphic_designer", "graphic_designer")).toBe(true);
    expect(worksAs("lead_video_editor", "graphic_designer")).toBe(false);
    expect(worksAs("lead_video_editor", "graphic_designer", "video_editor")).toBe(true);
  });
  it("can hold the same seat as their base role, and only that one", () => {
    const seat = (v: string) => SLOTS.find((s) => s.value === v)!;
    expect(canHold(seat("graphic_designer"), { role: "lead_graphic_designer" })).toBe(true);
    expect(canHold(seat("video_editor"), { role: "lead_graphic_designer" })).toBe(false);
    expect(canHold(seat("video_editor"), { role: "lead_video_editor" })).toBe(true);
    expect(canHold(seat("graphic_designer"), { role: "lead_video_editor" })).toBe(false);
  });
  it("get their base role's Kaizen AI agent and quick actions", () => {
    expect(agentForRole("lead_graphic_designer")).toBe(agentForRole("graphic_designer"));
    expect(agentForRole("lead_video_editor")).toBe(agentForRole("video_editor"));
    expect(groupsFor("lead_graphic_designer")).toEqual(groupsFor("graphic_designer"));
    expect(groupsFor("lead_video_editor")).toEqual(groupsFor("video_editor"));
  });
  it("can generate media like their base role", () => {
    const s = { isExec: false, isLead: false, isCreative: false, isCopywriter: false };
    expect(canGenerateMedia({ ...s, role: "lead_graphic_designer" })).toBe(true);
    expect(canGenerateMedia({ ...s, role: "lead_video_editor" })).toBe(true);
  });
});
