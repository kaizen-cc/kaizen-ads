import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, PASTE_CHARS, chunkText, fitLines, inlineWhole, readChunk, searchText, searchTerms } from "@/lib/assistant/long-text";
import { TURN_CHARS, callHistory, longTurnText } from "@/lib/agent-call/history";
import { exportTypeFor, findGoogleLinks, googleReadProblem, parseGoogleLink, rowsToCsv } from "@/lib/google-links";
import { LOOKUP_TOOLS, googleLinksHint, lookupHint, lookupOrder } from "@/lib/assistant/lookup";

// A 20-page brief, roughly: paragraphs of sentences, ~50k characters
const doc = Array.from({ length: 120 }, (_, i) => `Section ${i + 1}. The 24-hour reminder email goes out if the booking isn't confirmed. Flow step ${i + 1} sends at 9am with the offer for Kore Outdoor. Then the follow up waits two days before the next touch.\n\n`).join("");

describe("long documents and pastes are never cut short", () => {
  it("chunks put back together are exactly the text", () => {
    const chunks = chunkText(doc, 5000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.map((c) => c.text).join("")).toBe(doc);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(5000);
    // Breaks land on paragraph ends, not mid-word
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith("\n\n")).toBe(true);
  });

  it("splits text with no breaks at all without losing a character", () => {
    const blob = "x".repeat(CHUNK_CHARS * 3 + 17);
    const chunks = chunkText(blob);
    expect(chunks.map((c) => c.text).join("")).toBe(blob);
    expect(chunks).toHaveLength(4);
  });

  it("reads any part and says what's next", () => {
    const one = readChunk(doc, 0, 5000);
    expect(one.part).toBe(1);
    expect(one.next).toBe(2);
    const last = readChunk(doc, 999, 5000);
    expect(last.part).toBe(last.parts);
    expect(last.next).toBeNull();
    expect(doc.endsWith(last.text)).toBe(true);
  });

  it("finds passages by words, phrases in quotes as written", () => {
    const hits = searchText(doc, '"reminder email" Section 77');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("Section 77");
    expect(searchTerms('the "24-hour reminder" for Kore')).toEqual(["24-hour reminder", "kore"]);
    expect(searchText(doc, "zebra")).toEqual([]);
  });

  it("takes a pasted document whole up to sixty thousand characters (the old cap cut it at 4,000)", () => {
    expect(TURN_CHARS).toBe(PASTE_CHARS);
    expect(PASTE_CHARS).toBeGreaterThanOrEqual(60_000);
    const paste = doc.slice(0, 50_000);
    expect(longTurnText(paste)).toBe(paste.trim());
    expect(longTurnText(paste)).toContain(doc.slice(4000, 4100));
  });

  it("keeps long pastes in the conversation whole while they fit, older ones flagged as kept", () => {
    const rows = [
      { role: "user", content: "a".repeat(50_000) },
      { role: "agent", content: "got it" },
      { role: "user", content: "b".repeat(50_000) },
      { role: "agent", content: "got that too" },
      { role: "user", content: "c".repeat(30_000) },
    ];
    const h = callHistory(rows);
    expect(h.recent[4].content).toHaveLength(30_000);
    expect(h.recent[2].content).toHaveLength(50_000);
    expect(h.recent[0].content).toContain("read_pasted_text");
    expect(h.recent[0].content.length).toBeLessThan(2000);
    expect(h.recent[1].content).toBe("got it");
    // Short lines are never touched
    expect(fitLines([{ content: "hi" }, { content: "there" }])).toEqual([{ content: "hi" }, { content: "there" }]);
  });

  it("puts the newest documents in the context whole within the budget", () => {
    expect([...inlineWhole([10_000, 0, 40_000, 30_000], 60_000)].sort()).toEqual([0, 3]);
    expect([...inlineWhole([40_000, 30_000], 60_000)]).toEqual([1]);
    expect([...inlineWhole([5000, 5000], 60_000)].sort()).toEqual([0, 1]);
  });
});

describe("Google links", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  it("knows Docs, Sheets, Slides, Drive files and folders", () => {
    expect(parseGoogleLink(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).toMatchObject({ id, kind: "doc" });
    expect(parseGoogleLink(`https://docs.google.com/document/u/1/d/${id}/edit`)).toMatchObject({ id, kind: "doc" });
    expect(parseGoogleLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=12345`)).toMatchObject({ id, kind: "sheet", gid: "12345" });
    expect(parseGoogleLink(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`)).toMatchObject({ id, kind: "slides" });
    expect(parseGoogleLink(`https://drive.google.com/file/d/${id}/view?usp=drive_link`)).toMatchObject({ id, kind: "file" });
    expect(parseGoogleLink(`https://drive.google.com/open?id=${id}`)).toMatchObject({ id, kind: "file" });
    expect(parseGoogleLink(`https://drive.google.com/drive/folders/${id}`)).toMatchObject({ id, kind: "folder" });
    expect(parseGoogleLink(`https://drive.google.com/drive/u/0/folders/${id}?usp=sharing`)).toMatchObject({ id, kind: "folder" });
  });
  it("ignores what isn't a Google file", () => {
    expect(parseGoogleLink("https://example.com/document/d/abc")).toBeNull();
    expect(parseGoogleLink(`https://docs.google.evil.com/document/d/${id}`)).toBeNull();
    expect(parseGoogleLink("https://docs.google.com/document/d/short")).toBeNull();
    expect(parseGoogleLink("not a link")).toBeNull();
  });
  it("finds every link in a message once, trailing punctuation aside", () => {
    const text = `Can Kaizen AI not open this? https://docs.google.com/document/d/${id}/edit. Also (https://docs.google.com/spreadsheets/d/${id.replace("1", "2")}/edit) and again https://docs.google.com/document/d/${id}/edit`;
    const links = findGoogleLinks(text);
    expect(links.map((l) => l.kind)).toEqual(["doc", "sheet"]);
  });
  it("exports Docs and Slides as text and Sheets as a workbook, every tab", () => {
    expect(exportTypeFor("application/vnd.google-apps.document")?.mime).toBe("text/plain");
    expect(exportTypeFor("application/vnd.google-apps.presentation")?.mime).toBe("text/plain");
    expect(exportTypeFor("application/vnd.google-apps.spreadsheet")?.as).toBe("xlsx");
    expect(exportTypeFor("application/pdf")).toBeNull();
    expect(rowsToCsv([["a", "b,c"], ['say "hi"', ""]])).toBe('a,"b,c"\n"say ""hi""",');
  });
  it("explains a missing delegated scope for the admin", () => {
    expect(googleReadProblem("unauthorized_client: Client is unauthorized to retrieve access tokens").kind).toBe("scope");
    expect(googleReadProblem("unauthorized_client").say).toContain("drive.readonly");
    expect(googleReadProblem("Google /drive/v3/files: 404 File not found").kind).toBe("not_found");
    expect(googleReadProblem("Google /drive/v3/files: 403 forbidden").kind).toBe("no_access");
  });
});

describe("where the assistant looks", () => {
  it("looks everywhere for context instead of asking which source", () => {
    const order = lookupOrder("Can you get me context on the Kore Outdoor email project?");
    expect(order).toEqual(expect.arrayContaining(["client", "kaizen_ai", "slack", "email"]));
    const hint = lookupHint("Can you get me context on the Kore Outdoor email project?");
    expect(hint).toContain("Don't ask where to look");
    expect(hint).toContain("search_my_kaizen_ai");
    expect(hint).toContain("save_client_note");
  });
  it("puts the place they named first", () => {
    expect(lookupOrder("find the Kaizen AI thread Kore Outdoor 284 NEW")[0]).toBe("kaizen_ai");
    expect(lookupOrder("search my Slack DMs for the reminder email")[0]).toBe("slack");
    expect(lookupOrder("find that email from the client about flows")[0]).toBe("email");
    expect(lookupOrder("what did they say in the Loom about the welcome flow?")[0]).toBe("client");
  });
  it("stays out of the way when it isn't a lookup", () => {
    expect(lookupOrder("what do I need to do today?")).toEqual([]);
    expect(lookupOrder("draft a Slack reply to Dana")).toEqual([]);
    expect(lookupOrder("create a brief for Crust")).toEqual([]);
    expect(lookupHint("thanks!")).toBe("");
  });
  it("opens a pasted Google link without asking", () => {
    const text = "can Kaizen AI not open and read a Google Doc? https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012/edit";
    expect(lookupOrder(text)[0]).toBe("google_file");
    expect(googleLinksHint(text)).toContain("read_google_file");
    expect(googleLinksHint("no links here")).toBe("");
  });
  it("names a real tool for every source", () => {
    expect(Object.values(LOOKUP_TOOLS)).toEqual(["search_client", "search_my_kaizen_ai", "search_my_slack", "search_my_email", "read_google_file", "read_upload"]);
  });
});
