import { describe, expect, it } from "vitest";
import { mimeMessage, rawEmail } from "@/lib/assistant/messages";
import { composeScopeMessage, draftError, gmailDraftLink, serviceAccountClientId, slackMessageLink, slackSelfNote } from "@/lib/assistant/platform-drafts-core";

const decode = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

describe("the Gmail draft's raw email", () => {
  it("a new email carries to, cc and subject, and no thread headers", () => {
    const m = decode(rawEmail({ from: "Owner <owner@kaizen.test>", to: "dana@client.test", cc: "lead@kaizen.test", subject: "Next steps", body: "Hi Dana,\nThanks." }));
    expect(m).toContain("From: Owner <owner@kaizen.test>\r\n");
    expect(m).toContain("To: dana@client.test\r\n");
    expect(m).toContain("Cc: lead@kaizen.test\r\n");
    expect(m).toContain("Subject: Next steps\r\n");
    expect(m).not.toMatch(/In-Reply-To|References/);
    expect(m).toContain("Hi Dana,\r\nThanks.");
  });

  it("a reply stays in its thread: In-Reply-To is the last message, References ends with it", () => {
    const m = mimeMessage({ from: "Owner <owner@kaizen.test>", to: "dana@client.test", subject: "Re: Q4 plan", body: "Sounds good.", inReplyTo: "<msg-2@mail.test>", references: "<msg-1@mail.test>" });
    expect(m).toContain("In-Reply-To: <msg-2@mail.test>\r\n");
    expect(m).toContain("References: <msg-1@mail.test> <msg-2@mail.test>\r\n");
  });

  it("a reply to the first message gets References from In-Reply-To alone", () => {
    const m = mimeMessage({ from: "a@x.test", to: "b@x.test", subject: "Re: hi", body: ".", inReplyTo: "<first@x.test>" });
    expect(m).toContain("References: <first@x.test>\r\n");
  });

  it("no header injection from a subject or a recipient", () => {
    const m = mimeMessage({ from: "a@x.test", to: "b@x.test\r\nBcc: evil@x.test", subject: "Hi\nBcc: evil@x.test", body: "." });
    expect(m).not.toMatch(/\r\nBcc:/);
  });

  it("an attached PDF goes as multipart with the text first", () => {
    const m = mimeMessage({ from: "a@x.test", to: "b@x.test", subject: "SOW", body: "Attached.", attachments: [{ name: "Scope of Work.pdf", mime: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) }] }, "B1");
    expect(m).toContain('Content-Type: multipart/mixed; boundary="B1"');
    expect(m.indexOf("Attached.")).toBeLessThan(m.indexOf('filename="Scope of Work.pdf"'));
    expect(m).toContain("JVBERg==");
  });
});

describe("Gmail draft links", () => {
  it("opens the draft in the person's own account", () => {
    expect(gmailDraftLink("Owner@Kaizen.test", "18c2f")).toBe("https://mail.google.com/mail/u/owner%40kaizen.test/#drafts?compose=18c2f");
    expect(gmailDraftLink("owner@kaizen.test")).toBe("https://mail.google.com/mail/u/owner%40kaizen.test/#drafts");
  });
});

describe("when Google refuses", () => {
  it("reads the client ID from the key JSON, never the key", () => {
    expect(serviceAccountClientId(JSON.stringify({ client_id: "1234567890123", private_key: "-----BEGIN PRIVATE KEY-----" }))).toBe("1234567890123");
    expect(serviceAccountClientId("not json")).toBeNull();
    expect(serviceAccountClientId(undefined)).toBeNull();
    expect(serviceAccountClientId(JSON.stringify({ client_id: "abc" }))).toBeNull();
  });

  it("unauthorized_client is the one Admin console setting, with the client ID", () => {
    const e = draftError(new Error('unauthorized_client: Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.'), "1234567890123");
    expect(e.scope).toBe(true);
    expect(e.message).toMatch(/^Gmail drafts need one Admin console setting: add gmail.compose to the service account's domain-wide delegation/);
    expect(e.message).toContain("1234567890123");
    expect(e.message).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(e.message).not.toMatch(/PRIVATE KEY/);
  });

  it("an insufficient-scope 403 is the same setting", () => {
    expect(draftError(new Error('Google /gmail/v1/users/me/drafts: 403 {"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}'), null).scope).toBe(true);
    expect(draftError(new Error("Request had insufficient authentication scopes."), null).scope).toBe(true);
  });

  it("anything else is said as it is, not as the setting", () => {
    const e = draftError(new Error("Google /gmail/v1/users/me/drafts: 500 backend error"), "1");
    expect(e.scope).toBe(false);
    expect(e.message).toContain("500 backend error");
    expect(draftError(new Error("files missing: SOW.pdf"), null)).toEqual({ scope: false, message: expect.stringContaining("couldn't be read") });
    expect(draftError(new Error("invalid_grant: Invalid email or User ID"), null).message).toContain("doesn't know that mailbox");
  });

  it("the message without a client ID still reads whole", () => {
    expect(composeScopeMessage(null)).not.toContain("client ID");
  });
});

describe("the Slack self-DM draft", () => {
  it("links the thread it's meant for", () => {
    expect(slackMessageLink("C0123ABC", "1700000000.000100")).toBe("https://slack.com/archives/C0123ABC/p1700000000000100");
    expect(slackMessageLink("C0123ABC", null)).toBeNull();
    expect(slackMessageLink("C0123ABC", "nope")).toBeNull();
  });

  it("says where it goes, then the message untouched", () => {
    const n = slackSelfNote({ where: "#acme-internal, reply to Dana", link: "https://slack.com/archives/C1/p1", text: "On it.\nWill share Friday." });
    expect(n.startsWith("Draft for #acme-internal, reply to Dana (<https://slack.com/archives/C1/p1|open the thread>)")).toBe(true);
    expect(n.endsWith("\n\nOn it.\nWill share Friday.")).toBe(true);
  });
});
