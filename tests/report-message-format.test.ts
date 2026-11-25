import { describe, expect, it } from "vitest";
import { buildReportEmail, forSlack, slackToPlain, unmark } from "@/lib/reports/delivery-core";
import { emailHtml } from "@/lib/email-layout";

// The send step's message is written with formatting buttons and kept as Slack's own marks: Slack shows bold, italic,
// strikethrough, links and emoji as written; the email draws the same, plus underline (Slack has none: plain words).
const MSG = "<!here> Hi team!\n*Big week* 🎉 with _strong_ ~old~ ++new++ numbers. See <https://x.test/r/1|the report>.";

describe("one message, both places", () => {
  it("Slack gets its own formatting, underline as plain words", () => {
    expect(forSlack(MSG)).toBe("<!here> Hi team!\n*Big week* 🎉 with _strong_ ~old~ new numbers. See <https://x.test/r/1|the report>.");
  });
  it("the email draws bold, italic, underline, strikethrough, emoji and a link on its words", () => {
    const mail = buildReportEmail({ client: "Acme", kind: "weekly", periodLabel: "Nov 16 – Nov 22", parts: [{ platform: "meta", metrics: null, sections: null }], from: { name: "Sam Buyer", email: null }, message: MSG });
    const html = emailHtml({ title: mail.title, blocks: mail.blocks });
    expect(html).toContain("Big week</b>");
    expect(html).toContain("<i>strong</i>");
    expect(html).toContain("<u>new</u>");
    expect(html).toContain("<s>old</s>");
    expect(html).toContain("🎉");
    expect(html).toMatch(/<a href="https:\/\/x\.test\/r\/1"[^>]*>the report<\/a>/);
    expect(html).not.toContain("++");
  });
  it("the plain-text email and the inbox preview read clean", () => {
    expect(unmark(slackToPlain("See <https://x.test/r/1|the report>, ++now++ and *bold*"))).toBe("See the report (https://x.test/r/1), now and bold");
  });
  it("a bare address is still a link, and never wrapped twice", () => {
    const html = emailHtml({ title: "T", blocks: [{ kind: "para", text: "Go to https://x.test/a and [b](https://x.test/b)" }] });
    expect(html.match(/<a /g)).toHaveLength(2);
  });
});
