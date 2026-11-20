import { describe, expect, it } from "vitest";
import { businessHoursBetween, CLIENT_REPLY_WAIT, hasClimbed, ladderFor, leadFor, nudgeDraft, nudgeKey, waitedOut } from "@/lib/escalation-ladder-core";

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

describe("a client waiting on a reply", () => {
  it("counts business hours only (weekdays 8am to 6pm New York)", () => {
    // Fri 4pm ET to Mon 10am ET: 2 hours Friday, 2 hours Monday
    expect(businessHoursBetween(new Date("2026-11-20T21:00:00Z"), new Date("2026-11-23T15:00:00Z"))).toBe(4);
  });
  it("reaches the Client Success Coordinator after 12 business hours", () => {
    // Mon 9am ET; Tue 11am ET is 9 + 3 = 12 business hours
    expect(waitedOut("2026-11-23T14:00:00Z", CLIENT_REPLY_WAIT, new Date("2026-11-24T15:40:00Z"))).toBe(false);
    expect(waitedOut("2026-11-23T14:00:00Z", CLIENT_REPLY_WAIT, new Date("2026-11-24T16:00:00Z"))).toBe(true);
  });
  it("drafts a same-day nudge in hours", () => {
    expect(nudgeDraft({ teammate: "Sam Lee", what: "a reply to Dana", client: "Acme", hours: 26, kind: "client_reply" })).toContain("about 26 hours");
  });
});
