// Loom links in any text: a Slack message (<https://www.loom.com/share/abc|title>), an email, a pasted list (one per
// line, a CSV export) or the source of a Loom folder page. Pure, so it can be tested and used in the browser.

const VIDEO = /loom\.com\/(?:share|embed|v)\/([a-f0-9]{16,40})(?![a-f0-9])/gi;
const FOLDER = /loom\.com\/share\/folder\/([a-f0-9]{16,40})(?![a-f0-9])/gi;

/** Every Loom video in the text, once each, in order, as its share link */
export function loomLinks(text: string): { id: string; url: string }[] {
  const seen = new Set<string>();
  const out: { id: string; url: string }[] = [];
  for (const m of (text ?? "").matchAll(VIDEO)) {
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://www.loom.com/share/${id}` });
  }
  return out;
}

/** A pasted list: links, and bare 32-character video ids on their own (an export of ids), once each */
export function pastedLooms(text: string): { id: string; url: string }[] {
  const out = loomLinks(text);
  const seen = new Set(out.map((l) => l.id));
  // A bare id: 32 hex characters standing alone (not part of a longer token or a URL)
  for (const m of (text ?? "").matchAll(/(?<![\w/.-])([a-f0-9]{32})(?![\w-])/gi)) {
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://www.loom.com/share/${id}` });
  }
  return out;
}

/** Every Loom folder link in the text (loom.com/share/folder/{id}), once each */
export function loomFolders(text: string): { id: string; url: string }[] {
  const seen = new Set<string>();
  const out: { id: string; url: string }[] = [];
  for (const m of (text ?? "").matchAll(FOLDER)) {
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://www.loom.com/share/folder/${id}` });
  }
  return out;
}

/** A Loom Space link: only its members can open it, so it can't be read from a link */
export const isLoomSpace = (text: string) => /loom\.com\/spaces\//i.test(text ?? "");
