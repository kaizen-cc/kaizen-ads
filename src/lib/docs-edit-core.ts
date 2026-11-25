// Editing a Google Doc for an agent, the plain parts (no network) so they can be tested: the doc's paragraphs and
// headings from the Docs API's document, and each edit (replace text, insert under a heading, append, add a section)
// as the batchUpdate requests that make it, with a one-line description to show the person before their yes.

export type DocAction = "replace_text" | "insert_under_heading" | "append" | "add_section";
export const DOC_ACTIONS: DocAction[] = ["replace_text", "insert_under_heading", "append", "add_section"];

type El = { textRun?: { content?: string } };
export type GDocJson = {
  title?: string;
  body?: { content?: { startIndex?: number; endIndex?: number; paragraph?: { elements?: El[]; paragraphStyle?: { namedStyleType?: string } } }[] };
};

export type Para = { start: number; end: number; text: string; level: number | null };

/** The doc's paragraphs in order: their range, their text (without the closing newline) and heading level (null: body) */
export function paragraphsOf(doc: GDocJson): Para[] {
  const out: Para[] = [];
  for (const c of doc.body?.content ?? []) {
    if (!c.paragraph) continue;
    const text = (c.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
    const style = c.paragraph.paragraphStyle?.namedStyleType ?? "";
    const m = /^HEADING_(\d)$/.exec(style);
    out.push({ start: c.startIndex ?? 0, end: c.endIndex ?? 0, text, level: m ? Number(m[1]) : style === "TITLE" ? 0 : null });
  }
  return out;
}

export const docText = (doc: GDocJson) => paragraphsOf(doc).map((p) => p.text).join("\n");

/** Where the doc's text ends (the last index text can be inserted at) */
export function endIndexOf(doc: GDocJson): number {
  const last = (doc.body?.content ?? []).at(-1)?.endIndex ?? 2;
  return Math.max(1, last - 1);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The heading matching these words (exact first, then one that starts with or contains them) */
export function findHeading(paras: Para[], words: string): Para | null {
  const w = norm(words);
  if (!w) return null;
  const heads = paras.filter((p) => p.level !== null);
  return heads.find((p) => norm(p.text) === w) ?? heads.find((p) => norm(p.text).startsWith(w)) ?? heads.find((p) => norm(p.text).includes(w)) ?? null;
}

/** The end of a heading's section: just before the next heading at the same level or above, else the doc's end */
export function sectionEnd(paras: Para[], head: Para, docEnd: number): number {
  const i = paras.indexOf(head);
  const next = paras.slice(i + 1).find((p) => p.level !== null && head.level !== null && p.level <= head.level);
  return next ? next.start : docEnd;
}

/** How many times text appears in the doc (as replaceAllText counts it: case-sensitive) */
export const occurrences = (doc: GDocJson, find: string) => (find ? docText(doc).split(find).length - 1 : 0);

export type DocEdit = { action: DocAction; find?: string; replace_with?: string; heading?: string; text?: string; level?: number };
export type Planned = { ok: true; requests: unknown[]; summary: string } | { ok: false; error: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The batchUpdate requests for one edit, and what it does in a line (or why it can't) */
export function planDocEdit(doc: GDocJson, e: DocEdit): Planned {
  const paras = paragraphsOf(doc);
  const end = endIndexOf(doc);
  const text = (e.text ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (e.action === "replace_text") {
    const find = e.find ?? "";
    if (!find.trim()) return { ok: false, error: "What text should change? Give the exact words in the doc." };
    const n = occurrences(doc, find);
    if (!n) return { ok: false, error: `"${clip(find, 80)}" isn't in the doc (exact words, same capitals).` };
    return { ok: true, requests: [{ replaceAllText: { containsText: { text: find, matchCase: true }, replaceText: e.replace_with ?? "" } }], summary: `Replace "${clip(find, 80)}" with "${clip(e.replace_with ?? "", 80)}" (${n} ${n === 1 ? "place" : "places"})` };
  }
  if (!text) return { ok: false, error: "What should go in? Give the text." };
  if (e.action === "append") return { ok: true, requests: [{ insertText: { location: { index: end }, text: `\n${text}` } }], summary: `Add at the end: "${clip(text, 120)}"` };
  if (e.action === "insert_under_heading") {
    const head = findHeading(paras, e.heading ?? "");
    if (!head) return { ok: false, error: `No heading "${clip(e.heading ?? "", 80)}" in the doc. Its headings: ${paras.filter((p) => p.level !== null).map((p) => p.text).slice(0, 15).join(" · ") || "none"}.` };
    const at = sectionEnd(paras, head, end);
    // At the next heading's start the new text goes in as its own paragraph before it; at the end, after a newline
    const insert = at === end ? `\n${text}` : `${text}\n`;
    const reqs: unknown[] = [{ insertText: { location: { index: at }, text: insert } }];
    // Text inserted in front of a heading takes the heading's style: set it back to body text
    if (at !== end) reqs.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + insert.length }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
    return { ok: true, requests: reqs, summary: `Add under "${head.text}" (at the end of that section): "${clip(text, 120)}"` };
  }
  // add_section: a new heading and its text at the end
  const heading = (e.heading ?? "").replace(/\s+/g, " ").trim();
  if (!heading) return { ok: false, error: "What's the new section's heading?" };
  const level = Math.min(6, Math.max(1, Math.round(e.level ?? 2)));
  const headStart = end + 1;
  const headEnd = headStart + heading.length + 1;
  return {
    ok: true,
    requests: [
      { insertText: { location: { index: end }, text: `\n${heading}\n${text}` } },
      { updateParagraphStyle: { range: { startIndex: headStart, endIndex: headEnd }, paragraphStyle: { namedStyleType: `HEADING_${level}` }, fields: "namedStyleType" } },
      { updateParagraphStyle: { range: { startIndex: headEnd, endIndex: headEnd + Math.max(1, text.length) }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    ],
    summary: `Add a new section at the end, "${heading}" (heading ${level}): "${clip(text, 120)}"`,
  };
}

/** The doc id from a Google Docs link (or a bare id) */
export function docIdOf(link: string): string | null {
  const m = /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(link) ?? /^([A-Za-z0-9_-]{25,})$/.exec(link.trim());
  return m ? m[1] : null;
}
