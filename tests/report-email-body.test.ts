import { describe, expect, it } from "vitest";
import { buildReportEmail, sentencesOf, summaryLines } from "@/lib/reports/delivery-core";
import { emailHtml } from "@/lib/email-layout";
import { oceanboxMeta } from "./fixtures/report-weekly";

// The weekly email's body was split into fragments ("56 the week before.", "16.", "38.") because the summary was cut
// into sentences at every period, including the one inside $4,583.98, $1.16 and 1.81. A sentence ends at a period
// followed by a space and the next sentence, never at a period inside a number.

const SUMMARY = "Spend was $4,583.98 this week against $5,102.40 the week before, with 38 leads at $30.56 each. Cost per lead moved from 1.81 to 1.38 on the $38 target, a 23.8% drop. Nov 2-8 was our best week since September.";

describe("sentencesOf", () => {
  it("never splits at a period inside a number or a price", () => {
    expect(sentencesOf(SUMMARY)).toEqual([
      "Spend was $4,583.98 this week against $5,102.40 the week before, with 38 leads at $30.56 each.",
      "Cost per lead moved from 1.81 to 1.38 on the $38 target, a 23.8% drop.",
      "Nov 2-8 was our best week since September.",
    ]);
  });

  it("still splits a sentence that ends in a number", () => {
    expect(sentencesOf("We booked 38. Then it rose to $38.")).toEqual(["We booked 38.", "Then it rose to $38."]);
    expect(sentencesOf("CPC fell to $1.16! Why? The new ads.")).toEqual(["CPC fell to $1.16!", "Why?", "The new ads."]);
  });

  it("keeps versions, multiples, abbreviations and dates whole", () => {
    expect(sentencesOf("ROAS hit 3.5x vs. 2.1x last week on v2.1 of the page. Nov. 8 was the peak.")).toEqual(["ROAS hit 3.5x vs. 2.1x last week on v2.1 of the page.", "Nov. 8 was the peak."]);
  });

  it("handles text with no ending punctuation, and nothing at all", () => {
    expect(sentencesOf("Leads up 12% at $4.50")).toEqual(["Leads up 12% at $4.50"]);
    expect(sentencesOf("  ")).toEqual([]);
    expect(sentencesOf(null)).toEqual([]);
  });
});

describe("the weekly email body", () => {
  const mail = buildReportEmail({
    client: "Aldecoa Coffee",
    kind: "weekly",
    periodLabel: "Nov 2 – Nov 8",
    parts: [{ platform: "meta", metrics: oceanboxMeta, sections: { headline: "Leads up", summary: SUMMARY, did: ["Moved $30.56 a day to the winners.", "Paused two ads"], next: ["Test a $38 offer"] } }],
    from: { name: "Sam Buyer", email: "sam@example.com" },
    first: "Pat",
    dashboard: null,
  });

  it("reads as whole short paragraphs, none of them a fragment of a number", () => {
    const body = mail.lines.slice(1);
    expect(body).toContain("Spend was $4,583.98 this week against $5,102.40 the week before, with 38 leads at $30.56 each.");
    expect(body).toContain("Cost per lead moved from 1.81 to 1.38 on the $38 target, a 23.8% drop.");
    // No paragraph is a bare number or begins in the middle of one
    for (const line of mail.lines) {
      expect(line).not.toMatch(/^[\d,.%$]+\.?$/);
      expect(line).not.toMatch(/^\d{1,3}[ ,]/);
    }
    // What we did and what's next stay whole too
    expect(body).toContain("What we did: Moved $30.56 a day to the winners; Paused two ads.");
  });

  it("renders each paragraph in the email's HTML once, with the key numbers as the bullet list", () => {
    const html = emailHtml({ preheader: mail.preheader, kicker: mail.kicker, title: mail.title, highlight: mail.highlight, hello: mail.hello, lines: mail.lines, bullets: mail.bullets, note: mail.note });
    expect(html).toContain("$4,583.98");
    expect(html).not.toMatch(/<p[^>]*>\s*\d+\.\s*<\/p>/);
    expect(html).not.toMatch(/<p[^>]*>56 the week before\.<\/p>/);
    expect(mail.bullets.length).toBeGreaterThan(0);
    expect(mail.text).toContain("• ");
  });

  it("the three sentences of the summary are the opening lines", () => {
    expect(summaryLines({ summary: SUMMARY })).toHaveLength(3);
  });
});
