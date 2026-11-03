import { describe, expect, it } from "vitest";
import { parseQuestion, ROUTE } from "@/lib/bible-questions";

describe("Brand Bible questions", () => {
  it("reads the tag, the options and multi", () => {
    const q = parseQuestion({ question: "[creative] Which of these claims may appear in ads? {options: FDA-approved film | Trusted by top chefs | Sustainably sourced}{multi}" });
    expect(q.category).toBe("creative");
    expect(q.options).toEqual(["FDA-approved film", "Trusted by top chefs", "Sustainably sourced"]);
    expect(q.multi).toBe(true);
    expect(q.question).toBe("Which of these claims may appear in ads?");
  });

  it("keeps the same id when only the tags change", () => {
    expect(parseQuestion({ question: "[offer] Which boxes are in stock?" }).qid).toBe(parseQuestion({ question: "Which boxes are in stock?" }).qid);
  });

  it("labels untagged questions the way the team routes them", () => {
    const cat = (question: string, who = "Client") => parseQuestion({ question, who }).category;
    expect(cat("What are the Thanksgiving, Black Friday, Cyber Monday and December offers, prices and gift boxes?")).toBe("offer");
    expect(cat("Which products may carry “fresh, never frozen”: Build Your Own Box, the lobster boxes, king crab and caviar?")).toBe("creative");
    expect(cat("Which of these claims may appear in ads: “the only seafood delivery company…”, trusted by top chefs?")).toBe("creative");
    expect(cat("Should ads point to the Build Your Own Box page (and which of its two URLs) or to each box's own page?")).toBe("media");
    expect(cat("What is the breakeven cost per new customer and the KPI unit to judge creative against?", "Media buyer, with the client")).toBe("media");
    expect(cat("Which boxes are in stock and safe to feature?", "Media buyer")).toBe("offer");
    expect(cat("Can the client send a working link to the brand guideline (colors, fonts, logo rules)?")).toBe("creative");
    expect(cat("Which paid platforms (Meta, Google) will run for the restaurant, and from when?", "Kaizen")).toBe("media");
  });

  it("routes each label: the client first where it's theirs", () => {
    expect(ROUTE.offer).toEqual(["client", "media_buyer"]);
    expect(ROUTE.creative).toEqual(["client", "head_of_creative"]);
    expect(ROUTE.media).toEqual(["media_buyer"]);
  });
});
