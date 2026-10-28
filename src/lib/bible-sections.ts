// A Brand Bible's Markdown split into its sections ("## 3. Audience profiles"), for the review viewer, the PDF and the
// review chat's edits. Plain functions, no server or browser APIs, so all three share them.

export type BibleSection = { id: string; num: string; title: string; heading: string; body: string };
export type Audience = { title: string; tier: string | null; body: string };
export type Quote = { quote: string; who: string; meta: string; use: "ok" | "check" | "no" | null; useNote: string };

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

/** The review bank as quote cards: the column with the words, who said it, and whether it's cleared for ads */
export function quotesOf(body: string): Quote[] {
  const t = tablesOf(body).find((x) => x.head.some((h) => /quote|review|verbatim|words/i.test(h)));
  if (!t) return [];
  const col = (re: RegExp) => t.head.findIndex((h) => re.test(h));
  const q = col(/quote|verbatim|words|review/i);
  const who = col(/who|name|reviewer|customer|author|shown as/i);
  const ok = col(/^ok|clear|use in|^use|status|permission/i);
  const rest = t.head.map((_, i) => i).filter((i) => i !== q && i !== who && i !== ok && !/#$|^id$/i.test(t.head[i]));
  return t.rows
    .filter((r) => r[q])
    .map((r) => ({
      quote: r[q].replace(/^["“]|["”]$/g, ""),
      who: who >= 0 ? r[who] : "",
      meta: rest.map((i) => r[i]).filter(Boolean).join(" · "),
      use: ok < 0 || !r[ok] ? null : /^(ok|yes|cleared|✓|approved|use it)/i.test(r[ok]) ? "ok" : /^(can.?t|no|don.?t|never|not for)/i.test(r[ok]) ? "no" : "check",
      useNote: ok >= 0 ? (r[ok] ?? "") : "",
    }));
}

/** Counts for the cover */
export function statsOf(sections: BibleSection[]) {
  const by = (k: string) => sections.find((s) => kindOf(s.title) === k);
  const titled = (re: RegExp) => sections.find((s) => re.test(s.title));
  const rows = (s?: BibleSection) => (s ? tablesOf(s.body).reduce((n, t) => n + t.rows.length, 0) : 0);
  const aud = by("audiences");
  return {
    audiences: aud ? audiencesOf(aud.body).list.length : 0,
    reviews: rows(by("reviews")),
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
