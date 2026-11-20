import { describe, expect, it } from "vitest";
import { hasClimbed, ladderFor, leadFor, nudgeDraft, nudgeKey } from "@/lib/escalation-ladder-core";

const team = [
  { id: "hoc", role: "head_of_creative" },
  { id: "lve", role: "lead_video_editor" },
  { id: "hoe", role: "head_of_email" },
  { id: "hom", role: "head_of_meta" },
  { id: "hos", role: "head_of_social" },
];

describe("the escalation ladder", () => {
  it("climbs only after 48 hours", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    expect(hasClimbed("2026-11-20T13:00:00Z", now)).toBe(false);
    expect(hasClimbed("2026-11-20T12:00:00Z", now)).toBe(true);
    expect(hasClimbed("not a date", now)).toBe(false);
  });
  it("reaches the nearest lead on every line", () => {
    expect(leadFor("video_editor", team)?.id).toBe("lve");
    expect(leadFor("graphic_designer", team)?.id).toBe("hoc"); // no lead graphic designer active: the head
    expect(leadFor("email_designer", team)?.id).toBe("hoe");
    expect(leadFor("media_buyer", team)?.id).toBe("hom");
    expect(leadFor("social_media_manager", team)?.id).toBe("hos");
    expect(leadFor("google_buyer", team)).toBeNull();
    expect(ladderFor("executive")).toEqual([]);
  });
  it("never sends a lead's own item to themselves", () => {
    expect(leadFor("lead_video_editor", [{ id: "x", role: "head_of_creative" }], "x")).toBeNull();
  });
  it("drafts a short, friendly check-in, not the work", () => {
    const d = nudgeDraft({ teammate: "Ana Maria Lopez", what: "#12 BFCM statics", client: "Acme", hours: 60 });
    expect(d.startsWith("Hey Ana,")).toBe(true);
    expect(d).toContain("Acme: #12 BFCM statics");
    expect(d).toContain("about 3 days");
    expect(d).not.toMatch(/—/);
  });
  it("keeps one nudge per item", () => {
    expect(nudgeKey("owed:1")).toBe("nudge:owed:1");
  });
});
