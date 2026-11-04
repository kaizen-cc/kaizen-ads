// Cutting a document's text into the chunks agents look things up in: about CHUNK_WORDS words each, on page or
// paragraph breaks, each with the pages it spans and a heading (its first real line). Pure, so it's tested on its own.

export const CHUNK_WORDS = 900;
export type Section = { heading: string; pageFrom: number | null; pageTo: number | null; text: string };

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const headingOf = (s: string) => (s.split("\n").map((l) => l.trim()).find((l) => l.length > 3) ?? "").replace(/^#+\s*/, "").slice(0, 100);

/** Pages into chunks of about CHUNK_WORDS words, each with the pages it spans */
export function chunkPages(pages: string[]): Section[] {
  const out: Section[] = [];
  let cur: string[] = [];
  let from = 1;
  let n = 0;
  pages.forEach((p, i) => {
    if (!p.trim()) return;
    if (!cur.length) from = i + 1;
    // A very long page is split on its own
    if (words(p) > CHUNK_WORDS * 1.5) {
      if (cur.length) out.push({ heading: headingOf(cur.join("\n")), pageFrom: from, pageTo: i, text: cur.join("\n\n") });
      cur = [];
      n = 0;
      for (const part of chunkText(p)) out.push({ ...part, pageFrom: i + 1, pageTo: i + 1 });
      return;
    }
    cur.push(p);
    n += words(p);
    if (n >= CHUNK_WORDS) {
      out.push({ heading: headingOf(cur.join("\n")), pageFrom: from, pageTo: i + 1, text: cur.join("\n\n") });
      cur = [];
      n = 0;
    }
  });
  if (cur.length) out.push({ heading: headingOf(cur.join("\n")), pageFrom: from, pageTo: pages.length, text: cur.join("\n\n") });
  return out;
}

/** Text without pages into chunks on paragraph breaks */
export function chunkText(text: string): Section[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: Section[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const p of paras) {
    cur.push(p);
    n += words(p);
    if (n >= CHUNK_WORDS) {
      out.push({ heading: headingOf(cur.join("\n")), pageFrom: null, pageTo: null, text: cur.join("\n\n") });
      cur = [];
      n = 0;
    }
  }
  if (cur.length) out.push({ heading: headingOf(cur.join("\n")), pageFrom: null, pageTo: null, text: cur.join("\n\n") });
  return out;
}
