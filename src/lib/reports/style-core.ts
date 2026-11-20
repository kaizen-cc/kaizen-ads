// A client's report style: what the team has taught Kaizen OS about how THIS client wants their reports (sections,
// metrics, comparisons, length, tone, format). Kept per client and per line (ads, email, social), versioned: every
// change is a new version with who taught it and from where, and undo steps back one version. Every report drafted
// for the client after that (the Monday weekly, the monthly recap, a built report) is written with the newest version,
// so what one buyer fixes once is never fixed again. The pure part lives here (merging, the banner, the prompt block,
// what a hand edit changed); reading and writing is style.ts.

export type StyleLine = "ads" | "email" | "social";
/** Where a lesson came from */
export type StyleSource = "studio_ask" | "hand_edit" | "layout" | "kaizen_ai" | "assistant" | "undo" | "import";
export type StyleRule = { text: string; topic: string | null; by: string | null; at: string; source: StyleSource };
export type StyleVersion = {
  id: string;
  version: number;
  rules: StyleRule[];
  change: string;
  source: StyleSource;
  taught_by_name: string | null;
  created_at: string;
  undone_at: string | null;
};

export const MAX_RULES = 30;
const MAX_RULE_CHARS = 280;

/** The line a report belongs to, from its platform */
export function lineOfPlatform(platform: string | null | undefined): StyleLine {
  if (platform === "klaviyo" || platform === "email") return "email";
  if (platform === "social") return "social";
  return "ads";
}

const METRICS: [RegExp, string][] = [
  [/\bcpm\b/, "cpm"],
  [/\bctr\b|click[- ]through/, "ctr"],
  [/\bcpc\b|cost per click/, "cpc"],
  [/\broas\b|return on ad spend/, "roas"],
  [/\bfrequency\b/, "frequency"],
  [/\breach\b/, "reach"],
  [/\bimpressions?\b/, "impressions"],
  [/hook rate|thumb[- ]?stop/, "hook_rate"],
  [/lead quality/, "lead_quality"],
  [/\bcpa\b|\bcpl\b|cost per (purchase|lead|result|acquisition|sale)/, "cost_per_result"],
];

/**
 * What a rule is about, when a newer rule on it should replace the older one (one value at a time): a metric shown or
 * left out ("no CPM" then "show CPM"), length, tone, the format it's handed over in, the tiles. Rules about anything else
 * (comparisons, creatives, sections, order) add up, so "top creatives" and later "worst creatives too" are both kept.
 */
export function topicOf(text: string): string | null {
  const t = text.toLowerCase();
  if (/^((meta|google|tiktok) )?(tiles|key metrics|campaign columns)\b/.test(t)) return `layout:${t.split(":")[0].trim()}`;
  if (/\b(power ?point|pptx|google slides|slides|deck|pdf)\b/.test(t)) return "format";
  if (/\b(tone|formal|casual|friendly|warm|emoji|emojis|voice)\b/.test(t)) return "tone";
  if (/\b(short|shorter|long|longer|concise|brief|length|words|bullets? max|at most \d+ bullets|\d+ bullets)\b/.test(t)) return "length";
  const metrics = METRICS.filter(([re]) => re.test(t)).map(([, k]) => k);
  // One metric named: a rule about showing it or not. Several: a comparison or a structure, which adds up
  if (metrics.length === 1 && !/\b(compare|comparison|versus|vs\.?|by offer|per offer|before|after)\b/.test(t)) return `metric:${metrics[0]}`;
  return null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();

/** Two rules that say the same thing (the same words, or one inside the other and nearly as long) */
export function sameRule(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.includes(short) && short.length / long.length >= 0.7;
}

export const cleanRule = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-•*\d.)\s]+/, "")
    .trim()
    .slice(0, MAX_RULE_CHARS);

export type Merge = { rules: StyleRule[]; added: string[]; replaced: { was: string; now: string }[]; removed: string[]; changed: boolean };

/**
 * The style after a lesson: new rules added (newest last), a rule on the same single-value topic replaced, the same rule
 * said again kept once (in its newest words), rules asked to be forgotten taken out, at most MAX_RULES (the oldest go).
 */
export function mergeRules(current: StyleRule[], incoming: { text: string; by: string | null; source: StyleSource; at?: string }[], remove: string[] = []): Merge {
  const at = new Date().toISOString();
  let rules = current.map((r) => ({ ...r }));
  const removed: string[] = [];
  for (const raw of remove) {
    const want = cleanRule(raw);
    if (!want) continue;
    const hit = rules.filter((r) => sameRule(r.text, want) || norm(r.text).includes(norm(want)));
    if (!hit.length) continue;
    removed.push(...hit.map((h) => h.text));
    rules = rules.filter((r) => !hit.includes(r));
  }
  const added: string[] = [];
  const replaced: Merge["replaced"] = [];
  for (const inc of incoming) {
    const text = cleanRule(inc.text);
    if (!text) continue;
    const rule: StyleRule = { text, topic: topicOf(text), by: inc.by, at: inc.at ?? at, source: inc.source };
    const same = rules.findIndex((r) => sameRule(r.text, text));
    if (same >= 0) {
      // Said again: kept once, in the newest words, and nothing new to show unless the words changed
      if (norm(rules[same].text) !== norm(text)) {
        replaced.push({ was: rules[same].text, now: text });
        rules.splice(same, 1);
        rules.push(rule);
      }
      continue;
    }
    const clash = rule.topic ? rules.findIndex((r) => r.topic === rule.topic) : -1;
    if (clash >= 0) {
      replaced.push({ was: rules[clash].text, now: text });
      rules.splice(clash, 1);
    } else added.push(text);
    rules.push(rule);
  }
  if (rules.length > MAX_RULES) rules = rules.slice(rules.length - MAX_RULES);
  return { rules, added, replaced, removed, changed: Boolean(added.length || replaced.length || removed.length) };
}

/** The one-line summary of a version's change, for the history */
export function changeLine(m: Pick<Merge, "added" | "replaced" | "removed">): string {
  const parts: string[] = [];
  if (m.added.length) parts.push(`Added: ${m.added.join("; ")}`);
  if (m.replaced.length) parts.push(`Changed: ${m.replaced.map((r) => r.now).join("; ")}`);
  if (m.removed.length) parts.push(`Dropped: ${m.removed.join("; ")}`);
  return parts.join(". ").slice(0, 600) || "No change";
}

/** The version in use: the newest one not undone */
export function currentVersion<T extends Pick<StyleVersion, "version" | "undone_at">>(versions: T[]): T | null {
  return [...versions].filter((v) => !v.undone_at).sort((a, z) => z.version - a.version)[0] ?? null;
}

/** The next version number (undone ones keep theirs, so numbers are never reused) */
export const nextVersion = (versions: Pick<StyleVersion, "version">[]) => versions.reduce((n, v) => Math.max(n, v.version), 0) + 1;

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/** "Using this client's report style (updated Nov 20 by Priscila)" */
export function styleBanner(v: Pick<StyleVersion, "created_at" | "taught_by_name" | "rules"> | null): string | null {
  if (!v || !v.rules.length) return null;
  const who = v.taught_by_name?.trim().split(/\s+/)[0];
  return `Using this client's report style (updated ${fmtDay(v.created_at)}${who ? ` by ${who}` : ""})`;
}

const SOURCE_LABEL: Record<StyleSource, string> = { studio_ask: "asked in the report", hand_edit: "edited the report", layout: "changed the metrics", kaizen_ai: "asked Kaizen AI", assistant: "asked the assistant", undo: "undid a change", import: "earlier reports" };
export const sourceLabel = (s: StyleSource) => SOURCE_LABEL[s] ?? s;

/** The style as the writer reads it: every rule, newest last (a newer rule wins over an older one it disagrees with) */
export function rulesBlock(rules: StyleRule[]): string {
  if (!rules.length) return "";
  return `<this_client_report_style>\nWhat the team has taught us about how THIS client wants their reports. Follow every rule: the sections, the metrics, the comparisons, the order, the length and the tone. A later rule wins over an earlier one it disagrees with. Only leave a rule out when the data for it doesn't exist this period, and then say so in a line.\n${rules.map((r) => `- ${r.text}`).join("\n")}\n</this_client_report_style>`;
}

// ─── What a hand edit changed ─────────────────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown> | null | undefined;
const words = (v: unknown): string[] => {
  if (v == null) return [];
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(words);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(words);
  return [String(v)];
};
const filled = (v: unknown) => words(v).length > 0;
const count = (v: unknown) => (Array.isArray(v) ? v.filter(filled).length : filled(v) ? 1 : 0);
const label = (k: string) => k.replace(/_/g, " ");

/**
 * The structural changes a buyer made by hand between two versions of a report's sections: a section emptied or
 * filled in, items added or cut, a trend chart added or removed, a section cut way down or written out longer. Plain
 * words for the AI that decides which are lasting preferences. Small rewordings are not listed.
 */
export function sectionsDiff(before: Loose, after: Loose): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    if (k === "stories") continue;
    const was = a[k];
    const now = b[k];
    if (filled(was) && !filled(now)) out.push(`Removed the whole "${label(k)}" section.`);
    else if (!filled(was) && filled(now)) out.push(`Added a "${label(k)}" section: ${words(now).slice(0, 40).join(" ")}`);
    else if (filled(was) && filled(now)) {
      const cw = count(was);
      const cn = count(now);
      if (Array.isArray(was) && Array.isArray(now) && cw !== cn && Math.abs(cw - cn) >= 2) out.push(`"${label(k)}" went from ${cw} items to ${cn}.`);
      const ww = words(was).length;
      const wn = words(now).length;
      if (ww >= 20 && wn <= ww * 0.55) out.push(`Cut "${label(k)}" from about ${ww} words to ${wn}.`);
      else if (wn >= 20 && wn >= ww * 1.8) out.push(`Wrote "${label(k)}" out longer: about ${ww} words to ${wn}.`);
    }
  }
  const titles = (v: unknown) => (Array.isArray(v) ? v.map((s) => String((s as { title?: string })?.title ?? "")).filter(Boolean) : []);
  const ts = titles(a.stories);
  const tn = titles(b.stories);
  for (const t of tn) if (!ts.includes(t)) out.push(`Added a trend chart: "${t}".`);
  for (const t of ts) if (!tn.includes(t)) out.push(`Removed the trend chart "${t}".`);
  return out.slice(0, 12);
}

/** Text the buyer typed in (new sentences, not in the draft): what they keep adding by hand is often a preference */
export function addedLines(before: Loose, after: Loose): string[] {
  const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).flatMap(leaves) : []);
  const lines = (v: Loose) =>
    leaves(v)
      .flatMap((x) => x.split(/(?<=[.!?])\s+/))
      .map((s) => s.trim())
      .filter((s) => s.split(/\s+/).length >= 4);
  const was = new Set(lines(before).map(norm));
  return lines(after)
    .filter((s) => !was.has(norm(s)))
    .slice(0, 8);
}
