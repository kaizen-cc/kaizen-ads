import { describe, expect, it } from "vitest";
import { hasMyTeam, TEAM_OF } from "@/lib/my-team";

describe("My team", () => {
  it("gives each creative lead their own makers", () => {
    expect(TEAM_OF.lead_video_editor).toEqual(["video_editor"]);
    expect(TEAM_OF.lead_graphic_designer).toEqual(["graphic_designer"]);
    expect(TEAM_OF.head_of_creative).toContain("video_editor");
    expect(TEAM_OF.head_of_creative).toContain("graphic_designer");
  });
  it("isn't there for anyone else", () => {
    expect(hasMyTeam("video_editor")).toBe(false);
    expect(hasMyTeam("head_of_meta")).toBe(false);
    expect(hasMyTeam("lead_video_editor")).toBe(true);
  });
});
