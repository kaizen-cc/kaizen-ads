import { describe, expect, it } from "vitest";
import { beforeAfter, describeWrite, driveQuery, eventRow, gmailRow, klaviyoPathOk, mayEditKlaviyo, scopeHelp } from "@/lib/kaizen-ai/workspace-core";

describe("hands-on Klaviyo: what may run", () => {
  it("reads anything under /api/", () => {
    expect(klaviyoPathOk("/api/templates/?filter=equals(name,'BFCM')", "GET").ok).toBe(true);
    expect(klaviyoPathOk("/api/flows/XyZ12/?include=flow-actions", "GET").ok).toBe(true);
  });
  it("never deletes, erases, suppresses or touches account settings", () => {
    for (const p of ["/api/profile-suppression-bulk-create-jobs/", "/api/data-privacy-deletion-jobs/", "/api/profile-bulk-delete-jobs/", "/api/accounts/", "/api/webhooks/"]) expect(klaviyoPathOk(p, "POST").ok).toBe(false);
  });
  it("refuses full URLs and climbing out", () => {
    expect(klaviyoPathOk("https://a.klaviyo.com/api/templates/", "GET").ok).toBe(false);
    expect(klaviyoPathOk("/api/../oauth", "GET").ok).toBe(false);
  });
  it("a write goes to one resource path", () => {
    expect(klaviyoPathOk("/api/templates/RtYu56/", "PATCH").ok).toBe(true);
    expect(klaviyoPathOk("/api/campaign-message-assign-template/", "POST").ok).toBe(true);
  });
  it("describes a change in plain words, long HTML by its size", () => {
    const html = "<html>" + "x".repeat(5000) + "</html>";
    const d = describeWrite("PATCH", "/api/templates/RtYu56/", { data: { type: "template", id: "RtYu56", attributes: { name: "BFCM hero", html } } });
    expect(d).toMatch(/^Change templates RtYu56, setting name: BFCM hero; html: <html>x+… \(5,013 characters\)$/);
    expect(describeWrite("POST", "/api/templates/", { data: { type: "template", attributes: { name: "New" } } })).toBe("Create templates, setting name: New");
  });
  it("shows the current values next to the new ones", () => {
    expect(beforeAfter({ data: { attributes: { subject: "Old line", name: "X" } } }, { data: { attributes: { subject: "New line" } } })).toEqual([{ field: "subject", now: "Old line", becomes: "New line" }]);
  });
  it("only the email team, leads and execs change it", () => {
    expect(mayEditKlaviyo({ role: "email_strategist" })).toBe(true);
    expect(mayEditKlaviyo({ role: "graphic_designer" })).toBe(false);
    expect(mayEditKlaviyo({ role: "meta_buyer", isLead: true })).toBe(true);
  });
});

describe("Google as rows", () => {
  it("a Gmail message", () => {
    const r = gmailRow({ id: "m1", threadId: "t1", snippet: "Hi", internalDate: String(Date.parse("2026-11-19T15:00:00Z")), payload: { headers: [{ name: "From", value: "Jason <j@acme.com>" }, { name: "Subject", value: "BFCM" }] } });
    expect(r).toMatchObject({ message_id: "m1", thread_id: "t1", from: "Jason <j@acme.com>", subject: "BFCM", date: "2026-11-19 15:00" });
  });
  it("a Drive search stays safe", () => expect(driveQuery("Kore's BFCM")).toBe("(name contains 'Kore s BFCM' or fullText contains 'Kore s BFCM') and trashed = false"));
  it("a calendar event", () => expect(eventRow({ summary: "Kore call", start: { dateTime: "2026-11-20T10:00:00-05:00" }, hangoutLink: "https://meet.google.com/x" })).toMatchObject({ title: "Kore call", where: "Google Meet" }));
  it("names the Admin setting when Google refuses the scope", () => {
    expect(scopeHelp("unauthorized_client: Client is unauthorized", "https://www.googleapis.com/auth/calendar.readonly")).toMatch(/calendar\.readonly/);
    expect(scopeHelp("Google answered 500", "x")).toBeNull();
  });
});
