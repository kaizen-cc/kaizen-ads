import { describe, expect, it } from "vitest";
import { fixGmailLink, gmailLink, hasCalendarPart, isCalendarEmail, isInternalOnly } from "@/lib/email-filters";
import { isCreativeRole } from "@/lib/roles";
import { chasesIntake } from "@/lib/next-for-me";
import { forCreative } from "@/lib/today";

describe("the creative team", () => {
  it("is the Head of Creative, designers and editors (lead makers too)", () => {
    for (const r of ["head_of_creative", "graphic_designer", "video_editor", "lead_graphic_designer", "lead_video_editor"]) expect(isCreativeRole(r)).toBe(true);
    for (const r of ["executive", "head_of_meta", "head_of_google", "media_buyer", "google_buyer", "copywriter", "customer_success", null]) expect(isCreativeRole(r)).toBe(false);
  });

  it("keeps what they can act on urgent and turns the rest into information", () => {
    const out = forCreative([
      { key: "fatigue:c:1", score: 58 },
      { key: "mine:ticket:1", score: 90 },
      { key: "owed-lead:1", score: 84 },
      { key: "said-lead:1", score: 85 },
      { key: "assets:c:2026-11", score: 50 },
    ]);
    expect(out.map((o) => o.score)).toEqual([58, 90, 59, 59, 50]);
  });
});

describe("who chases an intake form", () => {
  const me = (role: string, id = "me") => ({ id, role, isCoordinator: role === "customer_success" });
  it("is the client's account manager when there is one", () => {
    const seats = [{ profileId: "am", role: "coordinator" }, { profileId: "buyer", role: "meta_buyer" }];
    expect(chasesIntake(me("customer_success", "am"), seats)).toBe(true);
    expect(chasesIntake(me("customer_success", "other"), seats)).toBe(false);
    expect(chasesIntake(me("media_buyer", "buyer"), seats)).toBe(false);
  });
  it("falls to customer success and the client's buyers when nobody is", () => {
    const seats = [{ profileId: "buyer", role: "meta_buyer" }, { profileId: "hoc", role: "graphic_designer" }];
    expect(chasesIntake(me("customer_success", "cs"), seats)).toBe(true);
    expect(chasesIntake(me("media_buyer", "buyer"), seats)).toBe(true);
    expect(chasesIntake(me("head_of_meta", "lead"), seats)).toBe(false);
  });
  it("is never the creative team", () => {
    expect(chasesIntake(me("head_of_creative", "hoc"), [{ profileId: "hoc", role: "graphic_designer" }])).toBe(false);
  });
});

describe("emails that aren't the client talking", () => {
  it("spots calendar invites and RSVPs by subject", () => {
    for (const s of ["Invitation: Weekly sync @ Tue Nov 4, 2026 2pm - 3pm (EST) (santi@kaizenmarketing.agency)", "Updated invitation: Kickoff", "Accepted: Creative review @ Wed", "Declined: Monthly call", "Tentatively accepted: Monthly call", "Canceled event: Standup", "Updated invitation with note: Kickoff"]) expect(isCalendarEmail(s)).toBe(true);
    for (const s of ["New creative for the holiday sale", "Re: Invoice for October", "Accepting new offers this month", null]) expect(isCalendarEmail(s)).toBe(false);
  });
  it("spots a calendar part at any depth", () => {
    expect(hasCalendarPart({ mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain" }, { mimeType: "text/calendar" }] }] })).toBe(true);
    expect(hasCalendarPart({ mimeType: "multipart/mixed", parts: [{ mimeType: "application/octet-stream", filename: "invite.ics" }] })).toBe(true);
    expect(isCalendarEmail("Hello", { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain" }, { mimeType: "text/html" }] })).toBe(false);
  });
  it("spots mail only between us", () => {
    expect(isInternalOnly(["a@kaizenmarketing.agency", "B@KaizenMarketing.agency"])).toBe(true);
    expect(isInternalOnly(["a@kaizenmarketing.agency", "owner@client.com"])).toBe(false);
    expect(isInternalOnly([])).toBe(false);
  });
});

describe("the Gmail link", () => {
  it("picks the account instead of a /u/<address>/ path that 404s", () => {
    expect(gmailLink("santi@kaizenmarketing.agency", "18f2a")).toBe("https://mail.google.com/mail/?authuser=santi%40kaizenmarketing.agency#all/18f2a");
  });
  it("rewrites links saved the old way and leaves the rest", () => {
    expect(fixGmailLink("https://mail.google.com/mail/u/santi@kaizenmarketing.agency/#all/18f2a")).toBe(gmailLink("santi@kaizenmarketing.agency", "18f2a"));
    expect(fixGmailLink("https://slack.com/archives/C1/p1")).toBe("https://slack.com/archives/C1/p1");
    expect(fixGmailLink(null)).toBe(null);
  });
});
