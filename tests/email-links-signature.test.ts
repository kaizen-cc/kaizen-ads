import { describe, expect, it } from "vitest";
import {
  htmlBody,
  mimeMessage,
  plainBody,
  signatureText,
} from "@/lib/assistant/messages";

const base = {
  from: "Santi <santi@kaizen.test>",
  to: "john@client.test",
  subject: "Klaviyo",
  body: "Hey John,\nFeel free to [pick a time here](https://calendly.com/santi-28/30min) to see how we could help!",
};
const htmlOf = (m: string) => {
  const part = m
    .split('Content-Type: text/html; charset="UTF-8"')[1]
    .split("\r\n\r\n")[1]
    .split("\r\n--")[0];
  return Buffer.from(part.replace(/\r\n/g, ""), "base64").toString("utf8");
};
const SIG =
  '<div dir="ltr"><b>Santi Lozano</b><br>Kaizen Marketing<br><a href="https://kaizenmarketing.agency">kaizenmarketing.agency</a></div>';

describe("linked words in an email", () => {
  it("go out as a real link in the HTML part, and as words (address) in the plain one", () => {
    const m = mimeMessage(base, "B");
    expect(m).toContain(
      'Content-Type: multipart/alternative; boundary="B_alt"',
    );
    expect(htmlOf(m)).toContain(
      '<a href="https://calendly.com/santi-28/30min">pick a time here</a>',
    );
    expect(m).toContain(
      "Feel free to pick a time here (https://calendly.com/santi-28/30min) to see",
    );
    expect(m).not.toContain("[pick a time here]");
  });

  it("escapes the text, keeps line breaks, links bare addresses and bolds **words**", () => {
    expect(htmlBody("a <b> & **c**\nsee https://x.test/a?b=1&c=2.")).toBe(
      'a &lt;b&gt; &amp; <b>c</b><br>\r\nsee <a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>.',
    );
    expect(plainBody("**Hi** [here](https://x.test)")).toBe(
      "Hi here (https://x.test)",
    );
  });

  it("stays plain text when there's nothing to link and no signature", () => {
    const m = mimeMessage(
      { ...base, body: "Hi John,\nsee https://x.test" },
      "B",
    );
    expect(m).not.toContain("multipart");
  });
});

describe("their Gmail signature", () => {
  it("is added under the text, in Gmail's signature block, and as text in the plain part", () => {
    const m = mimeMessage(
      { ...base, body: "Hi John,\nThanks.", signature: SIG },
      "B",
    );
    const html = htmlOf(m);
    expect(html).toContain('class="gmail_signature"');
    expect(html.indexOf("Thanks.")).toBeLessThan(html.indexOf("Santi Lozano"));
    expect(m).toContain(
      "Thanks.\r\n\r\nSanti Lozano\r\nKaizen Marketing\r\nkaizenmarketing.agency",
    );
  });

  it("goes with an attached file too: the body (plain and HTML) first, then the file", () => {
    const m = mimeMessage(
      {
        ...base,
        signature: SIG,
        attachments: [
          {
            name: "a.pdf",
            mime: "application/pdf",
            data: new Uint8Array([37, 80, 68, 70]),
          },
        ],
      },
      "B1",
    );
    expect(m).toContain('Content-Type: multipart/mixed; boundary="B1"');
    expect(m.indexOf("multipart/alternative")).toBeLessThan(
      m.indexOf('filename="a.pdf"'),
    );
    expect(htmlOf(m)).toContain("Santi Lozano");
  });

  it("reads as plain text", () => {
    expect(
      signatureText('<p>Dana &amp; Co</p><a href="https://x.test">Site</a>'),
    ).toBe("Dana & Co\nSite (https://x.test)");
  });
});
