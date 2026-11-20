// Brand guidelines a client shares (a Drive file, an email, Slack, a call, the intake form), read into their Brand
// Bible. Plain functions, no server APIs: what counts as a guideline signal, whether the Bible says none was shared,
// and the Bible section written from what was read. The reading and the approval live in src/lib/brand-guidelines.ts.

/** Words that mean a brand guideline, logo, colors or fonts were shared or talked about */
const SIGNAL = /\bbrand(ing)?[\s-]*(guide(line)?s?|book|kit|standards?|identity|assets?|colou?rs?|fonts?)\b|\bstyle[\s-]*guide\b|\blogos?\b|\bfonts?\b|\btypefaces?\b|\btypography\b|\bhex\s*(codes?|values?)?\b|#[0-9a-f]{6}\b|\bpantone\b|\bcolou?r\s*(palette|codes?|scheme|swatch(es)?)\b/i;

/** A message, call note or file name that mentions brand guidelines, logos, colors or fonts */
export function mentionsGuideline(text: string | null | undefined) {
  return Boolean(text && SIGNAL.test(text));
}

/** A file name that looks like a guideline file (not just any file that mentions a logo in passing) */
export function isGuidelineFile(name: string | null | undefined) {
  return Boolean(name && /\bbrand|guide|\bstyle|\blogo|\bfont|palette|identity|\bkit\b/i.test(name));
}

/** A Drive folder that holds the brand: the client's Headquarters "Brand" and "Guidelines" folders (anything in them counts) */
export function isBrandFolder(folder: string | null | undefined) {
  return Boolean(folder && /\bbrand|guideline|\bstyle ?guide|\blogos?\b|identity/i.test(folder));
}

/** A Drive file that's part of the brand: named like a guideline, or kept in a brand folder */
export function isBrandFile(i: { title?: string | null; meta?: unknown }) {
  const folder = (i.meta as { folder?: string } | null)?.folder ?? null;
  return isGuidelineFile(i.title) || isBrandFolder(folder);
}

/** Every link in a text (an intake answer: a Google doc or folder, Dropbox, a website), cleaned of trailing punctuation */
export function linksIn(text: string | null | undefined): string[] {
  return [...new Set(((text ?? "").match(/https?:\/\/[^\s<>"'\]]+/g) ?? []).map((u) => u.replace(/[).,;]+$/, "")))].filter((u) => !/google\.com\/search/i.test(u));
}

/** Whether the Bible says the client's brand guideline isn't on file (shared nowhere, hex codes missing, a gap) */
export function saysNotShared(markdown: string | null | undefined) {
  if (!markdown) return false;
  return /brand\s*guide(line)?s?[^\n]{0,40}?\b(not\s+(yet\s+)?(shared|provided|on\s+file|received)|none\s+(shared|provided|on\s+file)|missing|unknown)\b|(hex(\s*codes?)?|colou?rs?|fonts?|logo(\s*files?)?)[^\n]{0,40}?\b(not|aren'?t|isn'?t)\s+(yet\s+)?(on\s+file|shared|provided|known)\b/i.test(markdown);
}

/** Google Docs and Drive links in a message (a guideline shared as a link) */
export function googleLinksIn(text: string | null | undefined) {
  return [...new Set((text ?? "").match(/https:\/\/(?:docs|drive)\.google\.com\/[^\s<>)"'\]]+/g) ?? [])];
}

export type GuidelineRead = {
  found: boolean;
  colors: { name: string; hex: string; use: string; source: string }[];
  fonts: { name: string; use: string; source: string }[];
  logos: { name: string; link: string; use: string; source: string }[];
  rules: { rule: string; source: string }[];
};

/** The section the Bible gets, every line with where it came from */
export function renderGuidelines(g: GuidelineRead, day: string) {
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim() || "—";
  const out: string[] = [`Read from what the client shared, approved by the Head of Creative (${day}). Creative follows these.`];
  if (g.colors.length) out.push("", "**Colors**", "", "| Color | Hex | Use | Source |", "| --- | --- | --- | --- |", ...g.colors.map((c) => `| ${cell(c.name)} | ${cell(c.hex)} | ${cell(c.use)} | ${cell(c.source)} |`));
  if (g.fonts.length) out.push("", "**Fonts**", "", "| Font | Use | Source |", "| --- | --- | --- |", ...g.fonts.map((f) => `| ${cell(f.name)} | ${cell(f.use)} | ${cell(f.source)} |`));
  if (g.logos.length) out.push("", "**Logos**", "", ...g.logos.map((l) => `- ${l.link ? `[${l.name}](${l.link})` : l.name}${l.use ? `: ${l.use}` : ""} (${l.source})`));
  if (g.rules.length) out.push("", "**Rules**", "", ...g.rules.map((r) => `- ${r.rule} (${r.source})`));
  return out.join("\n");
}

/** Anything worth putting in front of the Head of Creative */
export const hasGuidelines = (g: GuidelineRead) => g.found && g.colors.length + g.fonts.length + g.logos.length + g.rules.length > 0;

/** The Bible section the guidelines live in */
export const GUIDELINES_SECTION = "Brand guidelines";

/**
 * A guideline read waiting on approval is a Bible change stored as a question_answer row with no question, marked in
 * proposed ({ type: "brand_guideline", fingerprint, gap }), so the table's allowed kinds don't need to change.
 */
export const GUIDELINE_MARK = { type: "brand_guideline" } as const;
export const isGuidelineRow = (r: { kind?: unknown; proposed?: unknown }) => r.kind === "question_answer" && (r.proposed as { type?: unknown } | null)?.type === GUIDELINE_MARK.type;

/** A file in the client's context that may be a brand guideline (a Drive file) */
export type FileItem = { client_id: string; title: string | null; url: string | null; occurred_at: string };

/** Per client, the newest guideline file among the Drive files (name says brand guide, logo, style, fonts, palette) */
export function latestGuidelineFiles(items: FileItem[]) {
  const out = new Map<string, string>();
  for (const i of items) {
    if (!isGuidelineFile(i.title)) continue;
    const prev = out.get(i.client_id);
    if (!prev || i.occurred_at > prev) out.set(i.client_id, i.occurred_at);
  }
  return out;
}

export type Marker = { clientId: string; doneAt: string; filesAt: string | null };

/**
 * Which clients the back-fill still owes a read: never read first, then those with a guideline file newer than the one
 * last read. Each client is read once; the marker holds the newest file time it covered.
 */
export function backfillOrder(clientIds: string[], markers: Marker[], latest: Map<string, string>, limit = 500) {
  const by = new Map(markers.map((m) => [m.clientId, m]));
  const fresh: string[] = [];
  const newer: string[] = [];
  for (const id of clientIds) {
    const m = by.get(id);
    if (!m) fresh.push(id);
    else {
      const at = latest.get(id);
      if (at && (!m.filesAt || at > m.filesAt)) newer.push(id);
    }
  }
  // Clients with a guideline file first (that's where something will be found), then the rest
  fresh.sort((a, b) => Number(latest.has(b)) - Number(latest.has(a)));
  return [...fresh, ...newer].slice(0, limit);
}

/** Hex colors written in a text, each with the label next to it ("Deep green: #2F4A3A", "#2F4A3A (Sand)") */
export function extractHexColors(text: string | null | undefined, source: string) {
  const out: GuidelineRead["colors"] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? "").split(/\n+/)) {
    const re = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      let h = m[1].toUpperCase();
      if (h.length === 3) h = h.replace(/./g, (c) => c + c);
      const hex = `#${h}`;
      if (seen.has(hex)) continue;
      seen.add(hex);
      const before = line.slice(0, m.index).replace(/[\s:–—\-|(\[]+$/, "");
      const after = line.slice(m.index + m[0].length).replace(/^[\s)\]|]+/, "");
      const label = (before.split(/[|;,]/).pop() ?? "").trim().slice(-40) || after.replace(/^[(\-–—:]\s*/, "").split(/[|;,)]/)[0].trim().slice(0, 40);
      out.push({ name: label.replace(/^[\W_]+|[\W_]+$/g, ""), hex, use: "", source });
    }
  }
  return out;
}

/** Colors the read missed that the material states in plain hex, added with their source */
export function mergeHexColors(read: GuidelineRead, found: GuidelineRead["colors"]): GuidelineRead {
  const have = new Set(read.colors.map((c) => c.hex.toUpperCase()));
  const add = found.filter((c) => !have.has(c.hex));
  return add.length ? { ...read, found: true, colors: [...read.colors, ...add.map((c) => ({ ...c, name: c.name || c.hex }))] } : read;
}
