// A Brand Bible's Markdown split into its sections ("## 3. Audience profiles"), for the review viewer, the PDF and the
// review chat's edits. Plain functions, no server or browser APIs, so all three share them.

export type BibleSection = { id: string; num: string; title: string; heading: string; body: string };
export type Audience = { title: string; tier: string | null; body: string };
export type Quote = {
  quote: string;
  who: string;
  meta: string;
  use: "ok" | "check" | "no" | null;
  useNote: string;
  /** The v3 review bank's own columns, when the table has them */
  stars?: string;
  source?: string;
  link?: string | null;
  profile?: string;
  angle?: string;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "section";

export function splitBible(markdown: string): BibleSection[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const out: BibleSection[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  const push = () => {
    if (!cur) return;
    const text = cur.heading.replace(/^##\s+/, "").trim();
    const m = text.match(/^(\d+[a-z]?)[.)]?\s+(.*)$/i);
    const title = (m ? m[2] : text).replace(/\*\*/g, "");
    const used = new Set(out.map((s) => s.id));
    let id = slug(title);
    while (used.has(id)) id += "-2";
    out.push({ id, num: m ? m[1] : "", title, heading: cur.heading.trim(), body: cur.lines.join("\n").trim() });
  };
  for (const l of lines) {
    if (/^##\s+/.test(l)) {
      push();
      cur = { heading: l, lines: [] };
    } else if (cur) cur.lines.push(l);
    // Anything before the first section (a title line) is left out: the viewer has its own cover
  }
  push();
  return out;
}

/** What kind of section it is, from its title, so the viewer can give it its own layout */
export function kindOf(title: string) {
  const t = title.toLowerCase();
  if (t.startsWith("read this first")) return "first";
  if (t.includes("audience")) return "audiences";
  if (t.includes("review bank")) return "reviews";
  if (t.includes("open question")) return "questions";
  if (t.startsWith("sources") || t.startsWith("change log")) return "reference";
  return "text";
}

/** The ### subsections of the audience profiles, each with its confidence (Proven, Likely, Hypothesis) */
export function audiencesOf(body: string): { intro: string; list: Audience[] } {
  const parts = body.split(/\n(?=###\s)/);
  const intro = parts[0].startsWith("###") ? "" : parts.shift()!.trim();
  const list = parts
    .filter((p) => p.startsWith("###"))
    .map((p) => {
      const [head, ...rest] = p.split("\n");
      const title = head.replace(/^###\s+/, "").trim();
      const tier = title.match(/\((Proven|Likely|Hypothesis)\)/i)?.[1] ?? null;
      return { title: title.replace(/\s*\((Proven|Likely|Hypothesis)\)\s*/i, ""), tier, body: rest.join("\n").trim() };
    });
  return { intro, list };
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Every pipe table in a section, as a header and rows */
export function tablesOf(body: string) {
  const tables: { head: string[]; rows: string[][] }[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const rows: string[][] = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      if (!/^\|[\s:|-]+\|?$/.test(lines[i].trim())) rows.push(cells(lines[i]));
      i++;
    }
    if (rows.length) tables.push({ head: rows[0], rows: rows.slice(1) });
  }
  return tables;
}

/** A Markdown link's URL in a cell ("[Align page](https://...), read Nov 4"), or a bare URL */
const linkIn = (cell: string) => cell.match(/\]\((https?:[^)\s]+)\)/)?.[1] ?? cell.match(/https?:\/\/[^\s|)]+/)?.[0] ?? null;
const plain = (cell: string) =>
  cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();

/**
 * The review bank as quote cards: the words, who said it, the stars, where it's from (with its link), the profile and
 * angle, and whether it's cleared for ads. Reads the v3 table ("RV# | Review (word for word) | Stars | Shown as |
 * Source, date, link | Profile | Angle | Use in ads") and the older ones (any table with a quote, review or words column).
 */
export function quotesOf(body: string): Quote[] {
  const t = tablesOf(body).find((x) => x.head.some((h) => /quote|review|verbatim|words|complaint/i.test(h)));
  if (!t) return [];
  const col = (re: RegExp, not: number[] = []) => t.head.findIndex((h, i) => re.test(h) && !not.includes(i));
  const q = col(/quote|verbatim|words|^review|^complaint/i);
  const who = col(/who|name|reviewer|customer|author|shown as/i, [q]);
  const ok = col(/^ok|clear|use in|^use|status|permission/i, [q]);
  const stars = col(/star|rating/i, [q]);
  const source = col(/source|link/i, [q, who]);
  const profile = col(/profile|audience/i, [q]);
  const angle = col(/angle|objection/i, [q]);
  const named = [q, who, ok, stars, source, profile, angle];
  const rest = t.head.map((_, i) => i).filter((i) => !named.includes(i) && !/#$|^id$/i.test(t.head[i]));
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");
  return t.rows
    .filter((r) => r[q])
    .map((r) => {
      const src = at(r, source);
      const st = plain(at(r, stars));
      return {
        quote: plain(r[q]).replace(/^["“]|["”]$/g, ""),
        who: plain(at(r, who)),
        meta: rest
          .map((i) => plain(r[i] ?? ""))
          .filter(Boolean)
          .join(" · "),
        use: ok < 0 || !r[ok] ? null : /^(ok|yes|cleared|✓|approved|use it)/i.test(r[ok]) ? "ok" : /^(can.?t|no|don.?t|never|not for)/i.test(r[ok]) ? "no" : "check",
        useNote: at(r, ok),
        stars: /^(not shown|n\/?a|–|-|—)?$/i.test(st) ? "" : st,
        source: plain(src),
        link: linkIn(src),
        profile: plain(at(r, profile)),
        angle: plain(at(r, angle)),
      };
    });
}

/** A ### subsection of a section body (its heading and text up to the next ### or the end), and the text around it */
export function subsectionOf(body: string, re: RegExp): { heading: string; body: string; before: string; after: string } | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^###\s+/.test(l) && re.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^###\s+/.test(l));
  if (end < 0) end = lines.length;
  return {
    heading: lines[start].replace(/^###\s+/, "").trim(),
    body: lines
      .slice(start + 1, end)
      .join("\n")
      .trim(),
    before: lines.slice(0, start).join("\n").trim(),
    after: lines.slice(end).join("\n").trim(),
  };
}

/** The review bank's heading, as the v3 structure writes it under section 4 ("### 4b. Review bank") */
export const REVIEW_BANK = /review bank/i;

/**
 * Where the review bank lives: its own section ("## Review bank", older Bibles) or, in the v3 structure, a ###
 * subsection of another section ("### 4b. Review bank" under "## 4. ..."). The section it's in and the bank's own text.
 */
export function reviewBankOf(sections: BibleSection[]): { section: BibleSection; body: string } | null {
  const own = sections.find((s) => kindOf(s.title) === "reviews");
  if (own) return { section: own, body: own.body };
  for (const s of sections) {
    const sub = subsectionOf(s.body, REVIEW_BANK);
    if (sub) return { section: s, body: sub.body };
  }
  return null;
}

/** Counts for the cover */
export function statsOf(sections: BibleSection[]) {
  const by = (k: string) => sections.find((s) => kindOf(s.title) === k);
  const titled = (re: RegExp) => sections.find((s) => re.test(s.title));
  const rows = (s?: BibleSection) => (s ? tablesOf(s.body).reduce((n, t) => n + t.rows.length, 0) : 0);
  const aud = by("audiences");
  const bank = reviewBankOf(sections);
  return {
    audiences: aud ? audiencesOf(aud.body).list.length : 0,
    // The v3 bank sits under section 4 as "### 4b. Review bank"; older Bibles gave it its own section
    reviews: bank ? quotesOf(bank.body).length || tablesOf(bank.body).reduce((n, t) => n + t.rows.length, 0) : 0,
    competitors: rows(titled(/competitor/i)),
    moments: rows(titled(/calendar|moments/i)),
  };
}

/**
 * Puts edited sections back into the Bible. A section is matched by its heading (numbering and case aside); one
 * that isn't there is added before the sources. Returns the new Markdown and the titles it changed.
 */
export function applyEdits(markdown: string, edits: { section: string; markdown: string }[]) {
  const key = (s: string) =>
    s
      .replace(/^#+\s*/, "")
      .replace(/^\d+[a-z]?[.)]?\s+/i, "")
      .replace(/\*\*/g, "")
      .trim()
      .toLowerCase();
  const lines = markdown.replace(/\r/g, "").split("\n");
  const firstHeading = lines.findIndex((l) => /^##\s+/.test(l));
  const head = firstHeading > 0 ? lines.slice(0, firstHeading).join("\n").trimEnd() : "";
  const sections = splitBible(markdown).map((s) => ({ heading: s.heading, body: s.body }));
  const changed: string[] = [];
  for (const e of edits) {
    if (!e.markdown.trim()) continue;
    const i = sections.findIndex((s) => key(s.heading) === key(e.section));
    let text = e.markdown.replace(/\r/g, "").trim();
    const heading = i >= 0 ? sections[i].heading : `## ${e.section.replace(/^#+\s*/, "")}`;
    // The edit may or may not repeat its heading
    if (/^##\s+/.test(text)) text = text.split("\n").slice(1).join("\n").trim();
    if (i >= 0) sections[i] = { heading, body: text };
    else {
      const at = sections.findIndex((s) => /sources|change log/i.test(s.heading));
      sections.splice(at >= 0 ? at : sections.length, 0, { heading, body: text });
    }
    changed.push(key(heading));
  }
  const body = sections.map((s) => `${s.heading}\n\n${s.body}`).join("\n\n");
  return { markdown: `${head ? `${head}\n\n` : ""}${body}\n`, changed };
}

/** Adds a dated line to the change log (made if missing) */
export function logChange(markdown: string, line: string) {
  const sections = splitBible(markdown);
  const log = sections.find((s) => /change log/i.test(s.title));
  const entry = `- ${line}`;
  if (!log) return `${markdown.trimEnd()}\n\n## Change log\n\n${entry}\n`;
  return applyEdits(markdown, [{ section: log.heading, markdown: `${log.body}\n${entry}` }]).markdown;
}
