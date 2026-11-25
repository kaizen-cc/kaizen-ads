import { describe, expect, it } from "vitest";
import { docIdOf, endIndexOf, findHeading, occurrences, paragraphsOf, planDocEdit, sectionEnd, type GDocJson } from "@/lib/docs-edit-core";
import { emailBodies } from "@/lib/assistant/messages";
import { gmailDraftArgs } from "@/lib/workspace-mcp-core";

// A doc: Title / H1 "Plan" / body / H2 "Week 1" / body / H2 "Week 2" / body
const para = (start: number, text: string, style = "NORMAL_TEXT") => ({ startIndex: start, endIndex: start + text.length + 1, paragraph: { elements: [{ textRun: { content: `${text}\n` } }], paragraphStyle: { namedStyleType: style } } });
function doc(): GDocJson {
  const rows: [string, string][] = [
    ["Plan", "HEADING_1"],
    ["Intro words.", "NORMAL_TEXT"],
    ["Week 1", "HEADING_2"],
    ["Launch the sale.", "NORMAL_TEXT"],
    ["Week 2", "HEADING_2"],
    ["Follow up on the sale.", "NORMAL_TEXT"],
  ];
  let at = 1;
  const content = rows.map(([t, s]) => {
    const p = para(at, t, s);
    at = p.endIndex;
    return p;
  });
  return { title: "Nov plan", body: { content: [{ startIndex: 0, endIndex: 1 } as never, ...content] } };
}

describe("reading a doc's structure", () => {
  it("lists paragraphs with heading levels", () => {
    const ps = paragraphsOf(doc());
    expect(ps.map((p) => p.level)).toEqual([1, null, 2, null, 2, null]);
    expect(ps[2].text).toBe("Week 1");
  });
  it("finds a heading and where its section ends", () => {
    const d = doc();
    const ps = paragraphsOf(d);
    const w1 = findHeading(ps, "week 1")!;
    expect(w1.text).toBe("Week 1");
    expect(sectionEnd(ps, w1, endIndexOf(d))).toBe(ps[4].start);
    const w2 = findHeading(ps, "Week 2")!;
    expect(sectionEnd(ps, w2, endIndexOf(d))).toBe(endIndexOf(d));
    expect(findHeading(ps, "nothing like it")).toBeNull();
  });
  it("counts exact matches", () => {
    expect(occurrences(doc(), "sale")).toBe(2);
    expect(occurrences(doc(), "Sale")).toBe(0);
  });
  it("reads doc ids from links", () => {
    expect(docIdOf("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#heading=h.x")).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(docIdOf("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit")).toBeNull();
  });
});

describe("planning an edit", () => {
  it("replaces text everywhere, and refuses words that aren't there", () => {
    const p = planDocEdit(doc(), { action: "replace_text", find: "sale", replace_with: "launch" });
    expect(p.ok && p.requests).toEqual([{ replaceAllText: { containsText: { text: "sale", matchCase: true }, replaceText: "launch" } }]);
    expect(p.ok && p.summary).toContain("2 places");
    const no = planDocEdit(doc(), { action: "replace_text", find: "Black Friday" });
    expect(no.ok).toBe(false);
  });
  it("inserts at the end of a heading's section as body text", () => {
    const d = doc();
    const at = paragraphsOf(d)[4].start;
    const p = planDocEdit(d, { action: "insert_under_heading", heading: "Week 1", text: "Email the list." });
    expect(p.ok && p.requests).toEqual([
      { insertText: { location: { index: at }, text: "Email the list.\n" } },
      { updateParagraphStyle: { range: { startIndex: at, endIndex: at + 16 }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    ]);
    const missing = planDocEdit(d, { action: "insert_under_heading", heading: "Week 9", text: "x" });
    expect(!missing.ok && missing.error).toContain("Week 1");
  });
  it("appends at the end and adds a styled section", () => {
    const d = doc();
    const end = endIndexOf(d);
    expect(planDocEdit(d, { action: "append", text: "Done." })).toMatchObject({ ok: true, requests: [{ insertText: { location: { index: end }, text: "\nDone." } }] });
    const s = planDocEdit(d, { action: "add_section", heading: "Week 3", text: "Recap.", level: 2 });
    expect(s.ok && s.requests[0]).toEqual({ insertText: { location: { index: end }, text: "\nWeek 3\nRecap." } });
    expect(s.ok && s.requests[1]).toEqual({ updateParagraphStyle: { range: { startIndex: end + 1, endIndex: end + 8 }, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } });
    expect(planDocEdit(d, { action: "append", text: "  " }).ok).toBe(false);
  });
});

describe("Gmail drafts through MCP read like REST drafts", () => {
  it("gives plain text alone for plain words, HTML with links and the signature", () => {
    expect(emailBodies("Hi there")).toEqual({ plain: "Hi there", html: null });
    const b = emailBodies("See [the deck](https://x.co/d)", '<div>Santi<br><a href="https://k.co">Kaizen</a></div>');
    expect(b.plain).toBe("See the deck (https://x.co/d)\n\nSanti\nKaizen (https://k.co)");
    expect(b.html).toContain('<a href="https://x.co/d"');
    expect(b.html).toContain("gmail_signature");
  });
  it("sends HTML only when Google's create_draft takes it, else REST", () => {
    const e = { to: "a@b.co", subject: "Hi", plain: "x", html: "<div>x</div>" };
    expect(gmailDraftArgs(["to", "subject", "body"], e)).toBeNull();
    expect(gmailDraftArgs(["to", "subject", "body", "htmlBody"], e)?.html).toEqual({ names: ["htmlBody"], value: "<div>x</div>" });
    expect(gmailDraftArgs(["to", "subject", "body"], { ...e, html: null })?.body.value).toBe("x");
    expect(gmailDraftArgs(null, e)).toBeNull();
  });
});
