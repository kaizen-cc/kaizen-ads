import { describe, expect, it } from "vitest";
import { actingLines, lineActionsPrompt, mayActOnLine, mayAskTeammate, mayAudit } from "@/lib/line-actions";

const exec = { role: "executive", isExec: true };
const googleBuyer = { role: "google_buyer" };
const metaBuyer = { role: "media_buyer" };
const emailBuilder = { role: "email_builder" };
const headOfEmail = { role: "head_of_email" };

describe("who runs audits and sprints, per line", () => {
  it("a Google buyer can't start a Meta audit, even on their own client", () => {
    const seats = ["google_buyer"];
    expect(mayAudit(googleBuyer, "google", seats).ok).toBe(true);
    const meta = mayAudit(googleBuyer, "meta", seats);
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe("Only the Meta buyer on this client, the head of Meta or an exec can run a Meta audit or sprint.");
  });

  it("a buyer runs their line's audit only on clients where they hold the seat", () => {
    expect(mayAudit(metaBuyer, "meta", ["meta_buyer"]).ok).toBe(true);
    expect(mayAudit(metaBuyer, "meta", []).ok).toBe(false);
  });

  it("an email builder can't start any audit, nor send an ask to a buyer", () => {
    for (const line of ["meta", "google", "email", "social"] as const) expect(mayAudit(emailBuilder, line, ["email_builder"]).ok).toBe(false);
    expect(mayAskTeammate(emailBuilder, ["email_builder"], "task").ok).toBe(false);
    expect(mayAskTeammate(emailBuilder, ["email_builder"], "ask").ok).toBe(false);
    // Sharing what they know is still fine
    expect(mayAskTeammate(emailBuilder, ["email_builder"], "fyi").ok).toBe(true);
  });

  it("a head of email can audit email but not Meta", () => {
    expect(mayAudit(headOfEmail, "email", []).ok).toBe(true);
    expect(mayAudit(headOfEmail, "meta", []).ok).toBe(false);
    expect(mayActOnLine(headOfEmail, "email", [], "change this client's Klaviyo").ok).toBe(true);
  });

  it("the client's email strategist and social media manager own their lines; designers and creatives never do", () => {
    expect(mayAudit({ role: "email_strategist" }, "email", ["email_strategist"]).ok).toBe(true);
    expect(mayAudit({ role: "social_media_manager" }, "social", ["social_manager"]).ok).toBe(true);
    expect(mayAudit({ role: "graphic_designer" }, "social", ["social_creative"]).ok).toBe(false);
    expect(mayAudit({ role: "video_editor" }, "meta", ["video_editor"]).ok).toBe(false);
    expect(mayAudit({ role: "copywriter" }, "email", []).ok).toBe(false);
    expect(mayAudit({ role: "customer_success" }, "meta", []).ok).toBe(false);
  });

  it("an exec can do all of it", () => {
    for (const line of ["meta", "google", "tiktok", "email", "social", "creative"] as const) expect(mayActOnLine(exec, line, []).ok).toBe(true);
    expect(mayAskTeammate(exec, [], "task").ok).toBe(true);
    expect(actingLines(exec, [])).toEqual(["meta", "google", "email", "social"]);
  });

  it("tells the chat what this person may start, and that the rest is read only", () => {
    const p = lineActionsPrompt(googleBuyer, ["google_buyer"]);
    expect(p).toMatch(/for Google Ads only/);
    expect(p).toMatch(/Never offer or start one for Meta or email or organic social/);
    expect(lineActionsPrompt(emailBuilder, ["email_builder"])).toMatch(/none for this person; here they view the data and ask questions/);
    expect(lineActionsPrompt(exec, [])).toMatch(/every line/);
  });
});
