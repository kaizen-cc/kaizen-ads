import { describe, expect, it } from "vitest";
import { emailBodies, htmlBody, mimeMessage, plainBody } from "@/lib/assistant/messages";

const body = [
  "Hi Cole,",
  "",
  "Here is the campaign plan:",
  "",
  "| Campaign | Send date | Exclusions | Send time |",
  "|---|:---|---:|---|",
  "| **Gift Card 1** | Dec 1 | V3 list | 5 PM local |",
  "| Gift Card 2 | Dec 8 |  | 5 PM local |",
  "",
  "Best,",
  "Ilias",
].join("\n");

describe("a markdown table in an email draft", () => {
  it("becomes one dash line per row in the plain part, with no pipes or dividers left", () => {
    const plain = plainBody(body);
    expect(plain).toContain("- Gift Card 1 · Send date: Dec 1 · Exclusions: V3 list · Send time: 5 PM local");
    expect(plain).toContain("- Gift Card 2 · Send date: Dec 8 · Send time: 5 PM local");
    expect(plain).not.toContain("|");
    expect(plain).not.toContain("---");
    expect(plain.startsWith("Hi Cole,\n\nHere is the campaign plan:\n\n- Gift Card 1")).toBe(true);
    expect(plain.endsWith("5 PM local\n\nBest,\nIlias")).toBe(true);
  });

  it("becomes a real HTML table in the HTML part", () => {
    const html = htmlBody(body);
    expect(html).toContain("<table");
    expect(html).toMatch(/<th [^>]*>Campaign<\/th>/);
    expect(html).toMatch(/<td [^>]*><b>Gift Card 1<\/b><\/td>/);
    expect(html).toMatch(/<td [^>]*>Dec 8<\/td>/);
    expect(html).not.toContain("|");
    expect(html).toContain("Best,<br>");
  });

  it("makes the draft carry an HTML part even with no links or signature", () => {
    const b = emailBodies("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(b.html).toContain("<table");
    expect(b.plain).toBe("- 1 · B: 2");
    expect(mimeMessage({ from: "a@x.co", to: "b@y.co", subject: "Plan", body }, "B")).toContain('Content-Type: multipart/alternative; boundary="B_alt"');
  });

  it("leaves text with a stray pipe but no table alone", () => {
    expect(emailBodies("Sizes: S | M | L\n- one\n- two")).toEqual({ plain: "Sizes: S | M | L\n- one\n- two", html: null });
  });
});
