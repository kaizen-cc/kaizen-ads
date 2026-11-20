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
