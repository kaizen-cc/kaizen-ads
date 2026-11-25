import { describe, expect, it } from "vitest";
import { buildReportEmail, messageBlocks, slackToPlain } from "@/lib/reports/delivery-core";
import { contentBasis, driveBehind } from "@/lib/reports/drive-save-core";
import { outputsCheck, OUTPUTS_RULE } from "@/lib/reports/outputs-core";
import { emailHtml } from "@/lib/email-layout";
import { dedupeSections, ONCE_RULE, samePoint } from "@/lib/reports/style-core";

// One report, one text: the Slack post IS the message, the email's body IS that same message (turned from Slack's
// formatting into the email's, every point kept), and the PDF and pages are drawn from the sections. A strategist added
// points through the AI; the Slack message had them and the email didn't (it was rebuilt from three "did" and three
// "next" points), while the AI said "your changes are already in both".

const MESSAGE = `<!here> Atomic Wings Weekly Report | November 16 to November 22, 2026

Hi Team,
Here's how email and SMS performed for the week of November 16 to November 22.

*What happened*
We sent three campaigns this week. Our new Winback and Thanx loyalty automated emails went live ahead of the weekend, so it's too early to see much from them yet.
• Revenue from email and SMS: $4,464
• Orders: 188

*Coming up*
• November 25: Thanksgiving campaign
• November 27: App Push 3
• November 30: 79 Cent Wings
• December 7: App Push 4
• More December campaigns: we're building these now`;

const parts = [{ platform: "klaviyo" as const, metrics: null, sections: { summary: "Old summary.", did: ["a", "b", "c", "d"], next: ["one", "two", "three", "four"] } }];
const base = { client: "Atomic Wings", kind: "weekly", periodLabel: "Nov 16 – Nov 22", parts, from: { name: "Sam Strategist", email: "sam@example.com" }, first: "Pat", dashboard: null, serviceLabel: "Email", keyLines: ["Revenue: $4,464"] };

describe("the email's body is the message", () => {
  const mail = buildReportEmail({ ...base, message: MESSAGE });
  const html = emailHtml({ title: mail.title, hello: mail.hello, lines: mail.lines, blocks: mail.blocks, bullets: mail.bullets, note: mail.note });

  it("carries every point of the message, none cut to fit", () => {
    for (const s of ["Winback and Thanx loyalty", "December 7: App Push 4", "More December campaigns: we're building these now", "November 25: Thanksgiving campaign"]) {
      expect(html).toContain(s.replace(/'/g, "'"));
      expect(mail.text).toContain(s);
    }
    const coming = mail.blocks.find((b) => b.kind === "list" && b.items.some((x) => x.startsWith("November 25")));
    expect(coming && coming.kind === "list" ? coming.items : []).toHaveLength(5);
  });

  it("keeps the headings, and drops what only belongs in Slack (@here, the title line, the greeting)", () => {
    expect(mail.blocks[0]).toEqual({ kind: "para", text: "Here's how email and SMS performed for the week of November 16 to November 22." });
    expect(mail.blocks).toContainEqual({ kind: "heading", text: "What happened" });
    expect(mail.blocks).toContainEqual({ kind: "heading", text: "Coming up" });
    expect(html).not.toContain("&lt;!here&gt;");
    expect(mail.text).not.toContain("Weekly Report | November");
    expect(mail.text).not.toContain("Hi Team,");
    expect(mail.hello).toBe("Hi Pat,");
  });

  it("is not drawn from the sections any more when there's a message (nothing to fall behind)", () => {
    expect(mail.text).not.toContain("Old summary");
    expect(mail.lines).toEqual([]);
    expect(mail.bullets).toEqual([]);
    expect(mail.blocks.at(-1)).toEqual({ kind: "para", text: "The full report is attached as a PDF." });
  });

  it("an edit to the message is in the email at once", () => {
    const edited = buildReportEmail({ ...base, message: `${MESSAGE}\n• December 14: Holiday gift cards` });
    expect(edited.text).toContain("December 14: Holiday gift cards");
    expect(mail.text).not.toContain("December 14");
  });

  it("falls back to the sections only when there is no message", () => {
    const none = buildReportEmail({ ...base, message: "  " });
    expect(none.blocks).toEqual([]);
    expect(none.text).toContain("Old summary");
  });

  it("is scrubbed for a white label client like the rest of the email", () => {
    const wl = buildReportEmail({ ...base, whiteLabel: true, message: "*What happened*\nKaizen sent three campaigns.\n• Kaizen Marketing built the flows" });
    expect(JSON.stringify(wl.blocks)).not.toMatch(/Kaizen/);
  });
});

describe("Slack's formatting, turned into the email's", () => {
  it("links, mentions and emoji codes", () => {
    expect(slackToPlain("See <https://x.test/r/abc|your report> :tada: <@U123> <!channel>")).toBe("See [your report](https://x.test/r/abc)");
    expect(slackToPlain("<https://x.test>")).toBe("https://x.test");
  });
  it("bold and italic are drawn, anything else stays text", () => {
    const html = emailHtml({ title: "T", blocks: [{ kind: "para", text: "Revenue was *up 12%* and <script>x</script> _nice_" }] });
    expect(html).toContain("<b");
    expect(html).toContain("up 12%</b>");
    expect(html).toContain("<i>nice</i>");
    expect(html).not.toContain("<script>");
  });
  it("a sign-off at the end goes (the email signs itself)", () => {
    const b = messageBlocks("Hi team,\nSpend held steady.\n\nBest,\nSam");
    expect(b).toEqual([{ kind: "para", text: "Spend held steady." }]);
  });
});

describe("after the AI changes a report, the app says which outputs changed", () => {
  const before = { message: MESSAGE, sections: { did: ["a"] } };
  it("a message change is in the Slack message and the email, never claimed for the PDF", () => {
    const c = outputsCheck(before, { message: `${MESSAGE}\n• New point`, sections: { did: ["a"] } });
    expect(c).toMatchObject({ slack: true, email: true, pdf: false });
    expect(c.line).toBe("Checked after saving: the Slack message and the email (one text) are updated; the PDF is as before.");
  });
  it("a sections change is the PDF", () => {
    const c = outputsCheck(before, { message: MESSAGE, sections: { did: ["a", "b"] } });
    expect(c).toMatchObject({ slack: false, email: false, pdf: true });
    expect(c.line).toContain("the PDF is updated; the Slack message and the email are as before");
  });
  it("both, and nothing", () => {
    expect(outputsCheck(before, { message: "x", sections: {} }).line).toContain("the Slack message and the email (one text) and the PDF are updated");
    expect(outputsCheck(before, before).line).toBe("Checked after saving: nothing changed in the Slack message, the email or the PDF.");
  });
  it("tells the writer the email is the message, and never to send anyone to regenerate", () => {
    expect(OUTPUTS_RULE).toMatch(/body of the email, word for word/);
    expect(OUTPUTS_RULE).toMatch(/never tell them to regenerate/);
  });
});

describe("a Drive copy says when the report changed after it was saved", () => {
  it("the same words give the same fingerprint, whatever order the keys come in", () => {
    expect(contentBasis({ sections: { did: ["a"], next: ["b"] }, message: "Hi", extras: null })).toBe(contentBasis({ sections: { next: ["b"], did: ["a"] }, message: " Hi ", extras: "" }));
    expect(contentBasis({ sections: { did: ["a"] }, message: "Hi" })).not.toBe(contentBasis({ sections: { did: ["a", "b"] }, message: "Hi" }));
  });
  it("behind only when it was saved with a fingerprint and the report moved on", () => {
    const now = contentBasis({ sections: { did: ["a"] }, message: "Hi" });
    const save = { url: null, name: "x.pdf", at: "2026-11-23T00:00:00Z", by: null, byName: null };
    expect(driveBehind({ ...save, basis: now }, now)).toBe(false);
    expect(driveBehind({ ...save, basis: "old" }, now)).toBe(true);
    expect(driveBehind(save, now)).toBe(false);
  });
});

describe("a cut reaches every version, and each piece of work is told once", () => {
  it("removing a repeated paragraph from the message removes it from the email too", () => {
    const repeated = `${MESSAGE}\n\n*What we did*\n• Launched the Winback and Thanx loyalty automated emails`;
    const before = buildReportEmail({ ...base, message: repeated });
    const after = buildReportEmail({ ...base, message: MESSAGE });
    expect(before.text.match(/Winback and Thanx/g)).toHaveLength(2);
    expect(after.text.match(/Winback and Thanx/g)).toHaveLength(1);
    expect(outputsCheck({ message: repeated, sections: {} }, { message: MESSAGE, sections: {} }).email).toBe(true);
  });

  it("the email is the whole message, read as a complete email: greeting, every section, the PDF, the sign-off", () => {
    const full = `${MESSAGE}\n\n*Highlights*\n• Grand Theft Appetite (email, Nov 19): $1,636 from 60 orders\n\n*What we learned*\nFewer, stronger sends are paying off.`;
    const mail = buildReportEmail({ ...base, message: full });
    const headings = mail.blocks.filter((b) => b.kind === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(["What happened", "Coming up", "Highlights", "What we learned"]);
    expect(mail.text.startsWith("Hi Pat,")).toBe(true);
    expect(mail.text).toContain("The full report is attached as a PDF.");
    expect(mail.text).toContain("Any questions, just reply to this email.");
    expect(mail.text.trim().endsWith("Kaizen Marketing")).toBe(true);
    // Nothing of the message's content is missing from the email
    for (const line of full.split("\n").slice(4).map((l) => l.replace(/^[•*]\s*|\*/g, "").trim()).filter(Boolean)) expect(mail.text).toContain(line);
  });

  it("a point already made isn't made again in another section", () => {
    const s = dedupeSections({
      did: ["Launched the Winback and Thanx loyalty automated emails", "Sent Grand Theft Appetite by email on November 19"],
      doing: ["Launched the Winback and Thanx loyalty automated emails.", "Watching unsubscribes after they rose to 0.73%"],
      next: ["November 25: Thanksgiving campaign", "November 25: Thanksgiving campaign"],
    });
    expect(s.did).toHaveLength(2);
    expect(s.doing).toEqual(["Watching unsubscribes after they rose to 0.73%"]);
    expect(s.next).toEqual(["November 25: Thanksgiving campaign"]);
  });

  it("keeps points that only share a few words", () => {
    expect(samePoint("Thanksgiving, App Push 3 and 79 Cent Wings campaigns are scheduled", "November 25: Thanksgiving campaign")).toBe(false);
    expect(samePoint("Paused two ads", "Paused two ad sets on Meta for the holiday")).toBe(false);
  });

  it("every writer is told to say each piece of work once and to cut repeats from the message and the sections", () => {
    expect(ONCE_RULE).toMatch(/Say each piece of work once/);
    expect(ONCE_RULE).toMatch(/both the message and the sections/);
  });
});
