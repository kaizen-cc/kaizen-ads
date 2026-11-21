import { describe, expect, it } from "vitest";
import { parseRevision } from "@/lib/email-drafts/core";

const current = { subject: "Your new landing page", body: "Hi Sam,\n\nThe new landing page is live. Have a look and tell us what you think.\n\nAlex" };

describe("parseRevision (the chat on an email under review)", () => {
  it("takes the AI's rewrite, cleaned of em dashes and markdown", () => {
    const r = parseRevision({ reply: "Made it shorter.", subject: "**Landing page is live**", body: "Hi Sam — the page is live. Take a look when you can.\n\nAlex" }, current);
    expect(r).toEqual({ reply: "Made it shorter.", subject: "Landing page is live", body: "Hi Sam, the page is live. Take a look when you can.\n\nAlex" });
  });

  it("keeps the current email when the AI only asks a question back", () => {
    const r = parseRevision({ reply: "Who should it go to?", subject: "", body: "" }, current);
    expect(r.subject).toBe(current.subject);
    expect(r.body).toBe(current.body);
    expect(r.reply).toBe("Who should it go to?");
  });

  it("survives a broken answer", () => {
    expect(parseRevision(null, current)).toEqual({ reply: "Done.", ...current });
  });
});
