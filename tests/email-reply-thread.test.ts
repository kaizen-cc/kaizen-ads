import { describe, expect, it } from "vitest";
import { addressesIn, gmailThreadId, mimeMessage, rawEmail, replyAllCc, replyTo, reSubject, subjectCore } from "@/lib/assistant/messages";

const decode = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const ME = "strategist@kaizen.test";

describe("a reply drafted inside the thread", () => {
  it("keeps the subject as Re: <original> once, and carries In-Reply-To and References from the last message", () => {
    const m = decode(rawEmail({ from: `Strategist <${ME}>`, to: "Jamie <jamie@client.test>", subject: reSubject("Re: Black Friday plan"), body: "Thanks Jamie.", inReplyTo: "<CAF-last@mail.gmail.com>", references: "<CAF-first@mail.gmail.com> <CAF-second@mail.gmail.com>" }));
    expect(m).toContain("Subject: Re: Black Friday plan\r\n");
    expect(m).not.toContain("Re: Re:");
    expect(m).toContain("In-Reply-To: <CAF-last@mail.gmail.com>\r\n");
    expect(m).toContain("References: <CAF-first@mail.gmail.com> <CAF-second@mail.gmail.com> <CAF-last@mail.gmail.com>\r\n");
  });

  it("goes to whoever wrote last, or to who they wrote to when the last one was theirs", () => {
    expect(replyTo({ from: "Jamie <jamie@client.test>", to: ME }, ME)).toBe("Jamie <jamie@client.test>");
    expect(replyTo({ from: `Strategist <${ME}>`, to: "Jamie <jamie@client.test>" }, ME)).toBe("Jamie <jamie@client.test>");
    expect(replyTo({ from: "Jamie <jamie@client.test>", to: ME, replyTo: "team@client.test" }, ME)).toBe("team@client.test");
  });

  it("reply all puts everyone else on Cc, never themselves or the person it's to", () => {
    const to = replyTo({ from: "Jamie <jamie@client.test>", to: ME }, ME);
    expect(replyAllCc({ to: `${ME}, Pat <pat@client.test>`, cc: "lead@kaizen.test, JAMIE@client.test" }, ME, to)).toBe("pat@client.test, lead@kaizen.test");
    expect(replyAllCc({ to: ME, cc: null }, ME, to)).toBeNull();
    expect(mimeMessage({ from: ME, to, cc: "pat@client.test", subject: "Re: x", body: ".", inReplyTo: "<a@b>" })).toContain("Cc: pat@client.test\r\n");
  });
});

describe("the thread they pointed at", () => {
  it("reads a thread id from a search or a Gmail link", () => {
    expect(gmailThreadId("18c2f0a1b2c3d4e5")).toBe("18c2f0a1b2c3d4e5");
    expect(gmailThreadId("https://mail.google.com/mail/u/0/#inbox/18C2F0A1B2C3D4E5")).toBe("18c2f0a1b2c3d4e5");
    expect(gmailThreadId("https://mail.google.com/mail/u/strategist@kaizen.test/#all/18c2f0a1b2c3d4e5")).toBe("18c2f0a1b2c3d4e5");
    expect(gmailThreadId("https://mail.google.com/mail/u/0/#label/Clients/18c2f0a1b2c3d4e5")).toBe("18c2f0a1b2c3d4e5");
  });
  it("Gmail's newer link tokens can't be read by the API: none", () => {
    expect(gmailThreadId("https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWdbPqTxyzAbcdEfGh")).toBeNull();
    expect(gmailThreadId("not a thread")).toBeNull();
  });
  it("finds a reply's thread by the subject without its Re: and Fwd:", () => {
    expect(subjectCore("Re: Fwd: RE: Black Friday plan")).toBe("Black Friday plan");
    expect(addressesIn("Dana <D@x.com>, e@y.com")).toEqual(["d@x.com", "e@y.com"]);
  });
});
