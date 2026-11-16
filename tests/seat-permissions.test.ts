import { describe, expect, it } from "vitest";
import { HEAD_SEATS, mayAssignAnySeat, mayAssignSeat } from "@/lib/seat-permissions";

const email = ["email-marketing"];
const social = ["social-media"];

describe("who may assign a seat", () => {
  it("lets executives and leaders assign any seat", () => {
    expect(mayAssignSeat({ role: "executive", isExec: true }, "meta_buyer", [])).toBe(true);
    expect(mayAssignSeat({ role: "head_of_meta", isLead: true }, "email_builder", [])).toBe(true);
  });
  it("lets the Head of Email assign the email seats on email clients only", () => {
    const me = { role: "head_of_email" };
    for (const s of HEAD_SEATS.head_of_email) {
      expect(mayAssignSeat(me, s, email)).toBe(true);
      expect(mayAssignSeat(me, s, social)).toBe(false);
    }
    expect(mayAssignSeat(me, "social_manager", [...email, ...social])).toBe(false);
    expect(mayAssignSeat(me, "meta_buyer", email)).toBe(false);
  });
  it("lets the Head of Organic Social assign the social seats on social clients only", () => {
    const me = { role: "head_of_social" };
    for (const s of HEAD_SEATS.head_of_social) {
      expect(mayAssignSeat(me, s, social)).toBe(true);
      expect(mayAssignSeat(me, s, email)).toBe(false);
    }
    expect(mayAssignSeat(me, "email_strategist", [...email, ...social])).toBe(false);
  });
  it("gives nobody else any", () => {
    for (const role of ["email_strategist", "social_media_manager", "media_buyer", "copywriter", null]) {
      expect(mayAssignSeat({ role }, "email_strategist", email)).toBe(false);
      expect(mayAssignAnySeat({ role })).toBe(false);
    }
    expect(mayAssignAnySeat({ role: "head_of_email" })).toBe(true);
  });
});
