import { describe, expect, it } from "vitest";
import { mimeMessage, rawEmail } from "@/lib/assistant/messages";

const base = { from: "Dana <dana@kaizen.test>", to: "client@example.com", subject: "Your email sprint", body: "Hi!\nThe handoff is attached." };
const pdf = new Uint8Array(Buffer.from("%PDF-1.4 fake pdf bytes ".repeat(10)));

describe("mimeMessage", () => {
  it("stays a plain text email when nothing is attached", () => {
    const m = mimeMessage(base, "B");
    expect(m).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(m).not.toContain("multipart");
    expect(m.endsWith("Hi!\r\nThe handoff is attached.")).toBe(true);
  });

  it("attaches a PDF as multipart/mixed with the text first", () => {
    const m = mimeMessage({ ...base, attachments: [{ name: "Kaizen - Sierra Dreams - Scope of Work.pdf", mime: "application/pdf", data: pdf }] }, "BOUNDARY1");
    expect(m).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY1"');
    const parts = m.split("--BOUNDARY1");
    // preamble, text, file, closing
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain("text/plain");
    expect(parts[1]).toContain("Hi!\r\nThe handoff is attached.");
    expect(parts[2]).toContain('Content-Type: application/pdf; name="Kaizen - Sierra Dreams - Scope of Work.pdf"');
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="Kaizen - Sierra Dreams - Scope of Work.pdf"');
    expect(parts[2]).toContain("Content-Transfer-Encoding: base64");
    expect(parts[3].startsWith("--")).toBe(true);
    // The file comes back byte for byte, in lines of at most 76
    const b64 = parts[2].split("\r\n\r\n")[1].trim();
    expect(b64.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(b64.replace(/\r\n/g, ""), "base64").equals(Buffer.from(pdf))).toBe(true);
  });

  it("encodes a non-ASCII file name and keeps headers on one line", () => {
    const m = mimeMessage({ ...base, subject: "Hello\r\nBcc: evil@x.com", attachments: [{ name: 'Résumé "q".pdf', mime: "application/pdf", data: pdf }] }, "B2");
    expect(m).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20q%20.pdf");
    expect(m).not.toMatch(/\r\nBcc:/);
  });

  it("skips an empty file", () => {
    expect(mimeMessage({ ...base, attachments: [{ name: "x.pdf", mime: "application/pdf", data: new Uint8Array() }] }, "B")).not.toContain("multipart");
  });

  it("goes to Gmail as base64url without padding", () => {
    const raw = rawEmail({ ...base, attachments: [{ name: "a.pdf", mime: "application/pdf", data: pdf }] });
    expect(raw).not.toMatch(/[+/=]/);
    const back = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(back).toContain("multipart/mixed");
    expect(back).toContain("a.pdf");
  });
});
