// Long text the assistant works with: a document someone uploaded or pasted, a Google Doc it opened, a long thread.
// Nothing is cut short: the text is split into chunks at paragraph or sentence breaks (the chunks put back together are
// exactly the text), each chunk can be read on its own, and the whole text can be searched for words. Pure: no keys,
// no network, so the tests hold it.

/** A pasted or typed message is taken whole up to this many characters (about twenty pages) */
export const PASTE_CHARS = 60_000;
/** One chunk of a long document, as the model reads it in one go */
export const CHUNK_CHARS = 12_000;
/** Documents up to this many characters (in all, newest first) go into the assistant's context whole */
export const INLINE_DOC_CHARS = 60_000;

export type Chunk = { i: number; from: number; to: number; text: string };

/**
 * Splits text into chunks of at most `size` characters, each ending at a paragraph break, else a line break, else the
 * end of a sentence, else a space, in the last fifth of the window (a hard cut only when there's none). Joined back
 * in order, the chunks are exactly the text: nothing is dropped or repeated.
 */
export function chunkText(text: string, size = CHUNK_CHARS): Chunk[] {
  const out: Chunk[] = [];
  const n = Math.max(200, Math.floor(size));
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + n);
    if (end < text.length) {
      const window = text.slice(at, end);
      const floor = Math.floor(window.length * 0.8);
      const cut = [/\n\s*\n(?=[^\n]*$)/, /\n(?=[^\n]*$)/, /[.!?]["')\]]?\s(?=[^.!?]*$)/, /\s(?=\S*$)/]
        .map((re) => {
          const m = window.slice(floor).match(re);
          return m && m.index != null ? floor + m.index + m[0].length : -1;
        })
        .find((x) => x > 0);
      if (cut && cut > 0) end = at + cut;
    }
    out.push({ i: out.length, from: at, to: end, text: text.slice(at, end) });
    at = end;
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The words of a search: quoted phrases kept together, the rest split on spaces (two letters or more) */
export function searchTerms(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"]{2,80})"/g)].map((m) => norm(m[1].trim()));
  const rest = norm(query.replace(/"[^"]*"/g, " "))
    .split(/[^a-z0-9$%@.'-]+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set([...phrases, ...rest])].slice(0, 12);
}
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "about", "into", "what", "when", "how", "our", "their", "they", "are", "was", "were", "you", "your", "of", "to", "in", "on", "a", "an", "is", "it", "or", "be", "at", "by", "as"]);

export type Hit = { chunk: number; at: number; score: number; snippet: string };

/**
 * Where the words appear in the text: the best passages (most of the words close together), each with the chunk it's
 * in and a few hundred characters around it. A phrase in quotes must match as written (accents and case aside).
 */
export function searchText(text: string, query: string, opts: { size?: number; limit?: number; around?: number } = {}): Hit[] {
  const terms = searchTerms(query);
  if (!terms.length || !text) return [];
  const low = norm(text);
  const chunks = chunkText(text, opts.size ?? CHUNK_CHARS);
  const around = opts.around ?? 350;
  const spots: { at: number; term: string }[] = [];
  for (const t of terms) {
    let i = low.indexOf(t);
    let guard = 0;
    while (i >= 0 && guard++ < 400) {
      spots.push({ at: i, term: t });
      i = low.indexOf(t, i + t.length);
    }
  }
  if (!spots.length) return [];
  spots.sort((a, b) => a.at - b.at);
  // Each spot scores by how many different words are near it; the best spots that don't overlap win
  const scored = spots.map((s) => {
    const near = new Set(spots.filter((o) => Math.abs(o.at - s.at) <= around).map((o) => o.term));
    return { ...s, score: near.size + (s.term.includes(" ") ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  const picked: typeof scored = [];
  for (const s of scored) {
    if (picked.some((p) => Math.abs(p.at - s.at) < around * 2)) continue;
    picked.push(s);
    if (picked.length >= (opts.limit ?? 8)) break;
  }
  return picked.map((s) => {
    const from = Math.max(0, s.at - around);
    const to = Math.min(text.length, s.at + around);
    const chunk = chunks.find((c) => s.at >= c.from && s.at < c.to)?.i ?? 0;
    return { chunk, at: s.at, score: s.score, snippet: `${from > 0 ? "..." : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "..." : ""}` };
  });
}

/** One chunk to read, with where it sits ("part 2 of 5") and what's next */
export function readChunk(text: string, part: number, size = CHUNK_CHARS): { part: number; parts: number; text: string; next: number | null; chars: number } {
  const chunks = chunkText(text, size);
  const i = Math.max(0, Math.min(chunks.length - 1, Math.floor(part) || 0));
  const c = chunks[i] ?? { text: "", i: 0 };
  return { part: i + 1, parts: chunks.length, text: c.text, next: i + 1 < chunks.length ? i + 2 : null, chars: text.length };
}

/**
 * Which documents go into the context whole, newest first, within the budget; the rest are listed with how to read
 * them (read_upload, a part at a time, or a search). Returns the indexes kept whole.
 */
export function inlineWhole(sizes: readonly number[], budget = INLINE_DOC_CHARS): Set<number> {
  const keep = new Set<number>();
  let used = 0;
  for (let i = sizes.length - 1; i >= 0; i--) {
    if (sizes[i] <= 0) continue;
    if (used + sizes[i] > budget) continue;
    keep.add(i);
    used += sizes[i];
  }
  return keep;
}

/**
 * A conversation's lines for the prompt, without letting a few long pastes crowd everything out: the newest lines are
 * whole until `budget` characters are used, and an older line past that which is long keeps its start, with a note that
 * it's kept whole (read_pasted_text). Short lines are never touched. Same order as given.
 */
export function fitLines<T extends { content: string }>(rows: readonly T[], budget = 90_000, keepStart = 1500): T[] {
  const out = rows.slice();
  let used = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i].content ?? "";
    if (i === out.length - 1 || used + c.length <= budget || c.length <= keepStart * 2) {
      used += c.length;
      continue;
    }
    out[i] = { ...out[i], content: `${c.slice(0, keepStart)} [... ${(c.length - keepStart).toLocaleString("en-US")} more characters of this message are kept whole: read_pasted_text has it]` };
    used += keepStart;
  }
  return out;
}
