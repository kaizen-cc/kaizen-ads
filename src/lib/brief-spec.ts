// The brief as the maker reads it: one structure for every format, as simple as the lead video editor's own brief,
// with the few things Kaizen adds (the insight and its source, who it's for, versions that test one variable, the copy,
// the client's rules folded in, the allotment). Fixed by the brief: the message, the payoff, the hook lines, the musts
// and the nevers. The maker's call: how it's made. Only "the build" changes by format: a video's beats, a carousel's
// slides, a single image's frame. Anything only the client can tell us sits in "Confirm with client" (it never holds
// the brief). Two pages at most: every list five items or fewer, every line short.
//
// The brief stays text everywhere it travels (tickets, Asana, the PDF), written with fixed headings, so this module
// renders a spec to that text and reads it back. Older briefs (Insight, Hook, Do, Don't, Constraints, KPI...) still
// read, and render with their sections. Pure: safe in the browser and on the server, tested in tests/brief-spec.test.ts
// and tests/brief-review.test.ts.

import { PAYOFF_RULE } from "./brief-payoff";
import { briefFileStem } from "./creative-drive-paths";

export type AssetStatus = "have" | "need" | "shoot" | "missing";
export type SpecAsset = { item: string; status: AssetStatus };
/** A fact only the client knows (the reveal, the tip, the stat, the offer's terms, the date): never invented */
export type ClientFact = { question: string; answer: string; source: string };

export type BriefSpec = {
  /** Why it works: the specific, true thing the ad says or shows */
  insight: string;
  /** Where the insight comes from (Brand Bible, a call, client memory), when it's from the context */
  insightSource: string;
  /** Who it's for, in one line (targeting is the media buyer's) */
  who: string;
  /** The funnel stage ("Evergreen TOF", "Retargeting") */
  stage: string;
  /** Older briefs: the one thing to take away */
  keyMessage: string;
  /** Older briefs, or a hook that isn't V1's line */
  hook: string;
  /** Older briefs: cleared claims */
  proof: string[];
  /** Video: about how long ("~30s") */
  length: string;
  /** Video: 4 to 6 beats, one line each (beatOf / beatLine) */
  beats: string[];
  /** Video: music and voiceover in one line */
  audio: string;
  /** Carousel: one line per slide (slideOf / slideLine); older briefs, the message each slide carries */
  slides: string[];
  /** Single image: the frame's lines ("Headline: ...", frameOf / frameLines) */
  frame: string[];
  /** What changes per version (the hook or the headline), V1 first */
  versions: string[];
  /** Older briefs: formats, legal, safe zones */
  constraints: string[];
  /** Must (older briefs: Do) */
  dos: string[];
  /** Never (older briefs: Don't) */
  donts: string[];
  assets: SpecAsset[];
  /** The ad's copy, one labelled line each ("Primary: ...", copyOf / copyLines) */
  copy: string[];
  kpi: string;
  success: string;
  /** What's left to the maker: edit style, cut points, transitions, which clips, music within the rules */
  yourCall: string;
  /** Only when the request asked for a script */
  script: string;
  confirm: ClientFact[];
  /** One line: specs, safe zone and file names (the app writes it from the request when it's empty) */
  exportLine: string;
};

export const emptySpec = (): BriefSpec => ({
  insight: "",
  insightSource: "",
  who: "",
  stage: "",
  keyMessage: "",
  hook: "",
  proof: [],
  length: "",
  beats: [],
  audio: "",
  slides: [],
  frame: [],
  versions: [],
  constraints: [],
  dos: [],
  donts: [],
  assets: [],
  copy: [],
  kpi: "",
  success: "",
  yourCall: "",
  script: "",
  confirm: [],
  exportLine: "",
});

/** What the maker decides, said the same way on every brief unless the writer narrows it */
export const YOUR_CALL_DEFAULT = "Edit style, cut points, transitions, layout, which clips or photos within the folders, and music within the rules are yours. Keep the message, the payoff, the hook lines and the musts.";

export const ASSET_WORD: Record<AssetStatus, string> = { have: "Have", need: "Need", shoot: "Client to shoot", missing: "Missing" };

/** The headings the brief is written with, in order (the text a maker reads, and what's parsed back) */
export const SPEC_HEADINGS = [
  "Stage",
  "Why it works",
  "Who it's for",
  "Key message",
  "Hook",
  "Proof",
  "Length",
  "Beats",
  "Audio",
  "Slides",
  "Frame",
  "Versions",
  "Constraints",
  "Must",
  "Never",
  "Your call",
  "Assets",
  "Copy",
  "KPI",
  "Success looks like",
  "Script",
  "Confirm with client",
  "Export",
] as const;
type Heading = (typeof SPEC_HEADINGS)[number];

/** The caps every writer's brief is held to (two pages: every list five or fewer) */
export const LIMITS = { must: 5, never: 5, beats: 6, slides: 10, assets: 5, primary: 2, headlines: 2, confirm: 5, versions: 10 } as const;

const one = (s: string) => s.replace(/\s*\u2014\s*/g, ", ").replace(/\s+/g, " ").trim();
const list = (xs: string[]) => xs.map(one).filter(Boolean);

// ─── The build: beats, slides, the frame; and the versions and the copy ─────────────────────────────────

export type Beat = { time: string; name: string; onScreen: string; text: string; says: string; source: string };
export type SlideRow = { job: string; headline: string; shows: string };
export type Frame = { headline: string; subline: string; shows: string; readsFirst: string; cta: string };
export type CopySet = { primary: string[]; headlines: string[]; cta: string };

const TIME = /^~?\d{1,2}(?::\d{2})?(?:\.\d)?\s?s?\s*[-–]\s*\d{1,2}(?::\d{2})?(?:\.\d)?\s?s?$/i;
const TIME_LEAD = /^(~?\d{1,2}(?::\d{2})?(?:\.\d)?\s?s?\s*[-–]\s*\d{1,2}(?::\d{2})?(?:\.\d)?\s?s?)\s*[:.|-]?\s+(.*)$/i;
const SEP = /\s+\|\s+/;
const sourced = (s: string) => /^(.*?)\s*\(Source:\s*([^)]*)\)\s*$/i.exec(s);

/** A beat line read back: "0:00-0:05 | Hook | On screen: ... | Says: "..." (Source: interview 0:00-0:04)" */
export function beatOf(line: string): Beat {
  const b: Beat = { time: "", name: "", onScreen: "", text: "", says: "", source: "" };
  const raw = one(line.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+(?=\S)/, ""));
  let parts = raw.split(SEP).filter(Boolean);
  // A line with no separators: "0-3s: the opening line" keeps its time, the rest is what happens
  if (parts.length === 1) {
    const m = TIME_LEAD.exec(raw);
    if (m) {
      b.time = m[1].replace(/\s+/g, "");
      b.onScreen = m[2].trim();
      parts = [];
    }
  }
  for (const p of parts) {
    const m = /^(On screen|Shows|Visual|On-screen text|Text|Says|Said|Line|VO|Source)\s*:\s*(.*)$/i.exec(p);
    if (m) {
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === "on screen" || k === "shows" || k === "visual") b.onScreen = [b.onScreen, v].filter(Boolean).join(" ");
      else if (k === "text" || k === "on-screen text") b.text = v;
      else if (k === "source") b.source = v;
      else b.says = v;
    } else if (!b.time && TIME.test(p)) b.time = p.replace(/\s+/g, "");
    else if (!b.name && p.split(/\s+/).length <= 4) b.name = p;
    else b.onScreen = [b.onScreen, p].filter(Boolean).join(" ");
  }
  const s = sourced(b.says);
  if (s) {
    b.says = s[1].trim();
    b.source = b.source || s[2].trim();
  }
  return b;
}

/** A beat as its line (the inverse of beatOf) */
export function beatLine(b: Beat) {
  const says = b.says ? `Says: ${one(b.says)}${b.source ? ` (Source: ${one(b.source)})` : ""}` : b.source ? `Source: ${one(b.source)}` : "";
  return [one(b.time), one(b.name), b.onScreen && `On screen: ${one(b.onScreen)}`, b.text && `Text: ${one(b.text)}`, says].filter(Boolean).join(" | ");
}

const SLIDE_JOB = /^(hook|problem|proof|payoff|reveal|benefit|feature|offer|how it works|story|step \d+|cta|close|end card|the turn|context|myth|truth|tip \d*)$/i;

/** A slide line read back: "Hook | Headline: ... | Shows: ..."; an older slide (one plain line) is its headline */
export function slideOf(line: string): SlideRow {
  const s: SlideRow = { job: "", headline: "", shows: "" };
  const parts = one(line.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, "")).split(SEP).filter(Boolean);
  const labelled = parts.some((p) => /^(Headline|Says|Shows|Visual|Job)\s*:/i.test(p));
  for (const p of parts) {
    const m = /^(Headline|Says|Shows|Visual|Job)\s*:\s*(.*)$/i.exec(p);
    if (m) {
      const k = m[1].toLowerCase();
      if (k === "job") s.job = m[2].trim();
      else if (k === "shows" || k === "visual") s.shows = [s.shows, m[2].trim()].filter(Boolean).join(" ");
      else s.headline = m[2].trim();
    } else if (!s.job && (labelled || parts.length > 1) && (SLIDE_JOB.test(p) || p.split(/\s+/).length <= 3)) s.job = p;
    else if (!s.headline) s.headline = p;
    else s.shows = [s.shows, p].filter(Boolean).join(" ");
  }
  return s;
}

export function slideLine(s: SlideRow) {
  if (!s.job && !s.shows) return one(s.headline);
  return [one(s.job), s.headline && `Headline: ${one(s.headline)}`, s.shows && `Shows: ${one(s.shows)}`].filter(Boolean).join(" | ");
}

/** The frame's lines read back */
export function frameOf(lines: string[]): Frame {
  const f: Frame = { headline: "", subline: "", shows: "", readsFirst: "", cta: "" };
  for (const raw of lines) {
    const t = one(raw.replace(/^[-•*]\s+/, ""));
    const m = /^(Headline|Subline|Shows|In the frame|Visual|Reads first|Hierarchy|CTA|Button)\s*:\s*(.*)$/i.exec(t);
    if (!m) {
      f.shows = [f.shows, t].filter(Boolean).join(" ");
      continue;
    }
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "headline") f.headline = v;
    else if (k === "subline") f.subline = v;
    else if (k === "reads first" || k === "hierarchy") f.readsFirst = v;
    else if (k === "cta" || k === "button") f.cta = v;
    else f.shows = [f.shows, v].filter(Boolean).join(" ");
  }
  return f;
}

export function frameLines(f: Frame) {
  return [f.headline && `Headline: ${one(f.headline)}`, f.subline && `Subline: ${one(f.subline)}`, f.shows && `Shows: ${one(f.shows)}`, f.readsFirst && `Reads first: ${one(f.readsFirst)}`, f.cta && `CTA: ${one(f.cta)}`].filter((x): x is string => Boolean(x));
}

/** The copy's lines read back, capped (primary text up to 2, headlines up to 2, one CTA) */
export function copyOf(lines: string[]): CopySet {
  const c: CopySet = { primary: [], headlines: [], cta: "" };
  for (const raw of lines) {
    const t = one(raw.replace(/^[-•*]\s+/, ""));
    const m = /^(Primary(?: text)?|Headlines?|CTA|Call to action)\s*:\s*(.*)$/i.exec(t);
    const v = (m ? m[2] : t).trim();
    if (!v) continue;
    const k = m?.[1].toLowerCase() ?? "primary";
    if (k.startsWith("headline")) c.headlines.push(v);
    else if (k === "cta" || k === "call to action") c.cta = c.cta || v;
    else c.primary.push(v);
  }
  return { primary: c.primary.slice(0, LIMITS.primary), headlines: c.headlines.slice(0, LIMITS.headlines), cta: c.cta };
}

export function copyLines(c: CopySet) {
  return [...c.primary.map((x) => `Primary: ${one(x)}`), ...c.headlines.map((x) => `Headline: ${one(x)}`), ...(c.cta ? [`CTA: ${one(c.cta)}`] : [])];
}

/** A version line without its "V2:" */
const versionText = (s: string) => one(s.replace(/^[-•*]\s+/, "").replace(/^V\d{1,2}\s*[:.)\-–]\s*/i, ""));

/** The hook as the brief has it: its Hook line, or V1's line */
export const hookOf = (sp: Pick<BriefSpec, "hook"> & { versions?: string[] }) => sp.hook.trim() || versionText(sp.versions?.[0] ?? "");

/** The brief's build as rows: the beats, the slides and the frame, read from their lines */
export const beatRows = (sp: Pick<BriefSpec, "beats">) => sp.beats.map(beatOf).filter((b) => b.name || b.onScreen || b.says || b.text);
export const slideRows = (sp: Pick<BriefSpec, "slides">) => sp.slides.map(slideOf).filter((s) => s.headline || s.shows || s.job);
export const frameOfSpec = (sp: Pick<BriefSpec, "frame">) => frameOf(sp.frame);

/** A beat's time in seconds ("0:05-0:09", "3-6s", "0:27–0:30"), or null when it doesn't read */
export function beatSpan(time: string): [number, number] | null {
  const m = /^~?(\d{1,2}(?::\d{2})?(?:\.\d)?)\s?s?\s*[-–]\s*(\d{1,2}(?::\d{2})?(?:\.\d)?)\s?s?$/i.exec(time.trim());
  if (!m) return null;
  const sec = (x: string) => (x.includes(":") ? Number(x.split(":")[0]) * 60 + Number(x.split(":")[1]) : Number(x));
  const a = sec(m[1]);
  const b = sec(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

/** The pacing bar: each beat's share of the video (equal shares when the times don't read), and the ticks every 5s */
export function pacing(beats: Beat[]) {
  const spans = beats.map((b) => beatSpan(b.time));
  const known = spans.every(Boolean) && spans.length > 0;
  const total = known ? Math.max(...spans.map((s) => s![1])) : beats.length;
  const parts = beats.map((b, i) => ({ name: b.name || `Beat ${i + 1}`, share: known ? (spans[i]![1] - spans[i]![0]) / total : 1 / Math.max(1, beats.length) }));
  const ticks = known ? Array.from({ length: Math.floor(total / 5) + 1 }, (_, i) => i * 5).filter((s) => s <= total) : [];
  return { parts, total: known ? total : null, ticks };
}

// ─── The export line ────────────────────────────────────────────────────────

export type BuildFormat = "image" | "video" | "carousel";
const PX: Record<string, string> = { "4x5": "1080x1350 (4:5)", "9x16": "1080x1920 (9:16)" };

/**
 * The one export line, from the request: the specs, the 9:16 safe zone and the file names. Kaizen makes 4:5 and 9:16
 * only; a carousel's slides are 1080x1350; a video is MP4 H.264 with captions burned in.
 */
export function exportLineFor(formats: BuildFormat[], sizes: string[], client: string, title: string) {
  const keys = sizes.map((z) => z.replace(":", "x")).filter((z) => z === "4x5" || z === "9x16");
  const use = keys.length ? keys : ["4x5", "9x16"];
  const stem = briefFileStem(client, title);
  const parts: string[] = [];
  if (formats.includes("video")) parts.push(`Video: MP4 H.264, ${use.map((k) => PX[k]).join(" and ")}, captions burned in`);
  if (formats.includes("image")) parts.push(`Image: ${use.map((k) => PX[k]).join(" and ")}`);
  if (formats.includes("carousel")) parts.push("Carousel slides: 1080x1350 (4:5)");
  if (!parts.length) parts.push(use.map((k) => PX[k]).join(" and "));
  if (use.includes("9x16") && !(formats.length === 1 && formats[0] === "carousel")) parts.push("9:16 safe zone: nothing in the top 270 px or bottom 670 px");
  const names = (formats.length === 1 && formats[0] === "carousel" ? ["4x5"] : use).map((k) => `${stem}_V1_${k}`);
  parts.push(`Files: ${names.join(", ")}${formats.includes("carousel") ? " (slides add _Slide01)" : ""}`);
  return parts.join(" · ");
}

// ─── Text ────────────────────────────────────────────────────────

/** The confirm line: "Which seat, at which venue, and why? Answer: ... (Source: ...)" */
export function factLine(f: ClientFact) {
  const q = one(f.question);
  const a = one(f.answer);
  const s = one(f.source);
  return `${q}${a ? ` Answer: ${a}` : ""}${a && s ? ` (Source: ${s})` : ""}`;
}

export function parseFactLine(line: string): ClientFact {
  const t = line.replace(/^[-•*]\s+/, "").trim();
  const m = /^(.*?)(?:\s+Answer:\s*(.*?))?(?:\s+\(Source:\s*([^)]*)\))?\s*$/.exec(t);
  return { question: (m?.[1] ?? t).trim(), answer: (m?.[2] ?? "").trim(), source: (m?.[3] ?? "").trim() };
}

// ─── The opening: the idea, the fallback, and copy direction that strayed into it ─────────────────────────────

/** Sentences, split where a sentence ends (a period inside quotes, "buy.' with", doesn't end one) */
export function sentences(text: string) {
  return one(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"‘'(])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const words = (x: string) => x.split(/\s+/).filter(Boolean).length;
const COPY_LABEL = /^(?:[-•*]\s*)?(Primary(?: text)?|Headlines?|CTA|Call to action)\s*:\s*\S/i;
const COPY_DIRECTION = /\bcopy direction\b[^:]*:\s*/i;
/** "- Primary: a - Headline: b - CTA: c" on one line, as its lines */
const copyParts = (x: string) =>
  x
    .split(/\s+[-•]\s+(?=(?:Primary(?: text)?|Headlines?|CTA|Call to action)\s*:)/i)
    .map((p) => p.replace(/^[-•*]\s*/, "").trim())
    .filter((p) => COPY_LABEL.test(p));

/** A fallback's first sentence, short (about 25 words) for the header; a long one splits at a clause, the rest after */
export function splitFallback(text: string): { short: string; more: string } {
  const ss = sentences(text.replace(/^fallback\s*:\s*/i, ""));
  if (!ss.length) return { short: "", more: "" };
  let [short] = ss;
  let more = ss.slice(1).join(" ");
  if (words(short) > 25) {
    // A ", and" / "; " boundary outside quotes: the last that leaves a header line of 8 to 28 words, else the first
    // under 36 (a line that still fits the band once)
    let best = -1;
    let len = 0;
    const re = /(?:,\s+(?:and|but|so|then|or)\s+|;\s+)/g;
    for (let m = re.exec(short); m; m = re.exec(short)) {
      const left = short.slice(0, m.index);
      const quotes = (left.match(/[“”"]/g) ?? []).length + (left.match(/(?:^|\s)['‘]|['’](?=\s|$|[.,;:!?])/g) ?? []).length;
      const w = words(left);
      if (w < 8 || quotes % 2 !== 0) continue;
      if (w <= 28 || (best < 0 && w <= 36)) {
        best = m.index;
        len = m[0].length;
      }
    }
    if (best > 0) {
      const right = short.slice(best + len).trim();
      more = [right[0].toUpperCase() + right.slice(1), more].filter(Boolean).join(" ");
      short = `${short.slice(0, best).replace(/[,;:\s]+$/, "")}.`;
    }
  }
  return { short, more };
}

export type Opening = {
  /** The idea and its payoff: one sentence, never the copy direction */
  idea: string;
  /** The fallback's first sentence (about 25 words), for the header */
  fallback: string;
  /** The rest of the fallback, for "Confirm with client" ("If not: ...") */
  fallbackMore: string;
  /** Copy lines that strayed into the opening ("Copy direction: - Primary: ..."), for the Copy section */
  copy: string[];
  /** Anything else in the overview (an older brief's "Hooks to try:", a heading this doesn't know), as written */
  rest: string;
};

/**
 * The overview read for the header: the idea in one sentence (the first of the opening lines), the fallback split
 * short, and copy direction a writer put in the opening moved to where it belongs (the Copy section). Older briefs keep
 * what follows their opening as rest.
 */
export function openingOf(overview: string): Opening {
  const lines = overview.replace(/\r\n/g, "\n").split("\n");
  const firstBlank = lines.findIndex((l) => !l.trim());
  const opening = firstBlank < 0 ? lines : lines.slice(0, firstBlank);
  const after = firstBlank < 0 ? [] : lines.slice(firstBlank);
  const idea: string[] = [];
  const fallback: string[] = [];
  const copy: string[] = [];
  const rest: string[] = [];
  let state: "idea" | "copy" | "fallback" = "idea";
  const read = (raw: string, inOpening: boolean) => {
    const t = raw.trim();
    if (!t) return void rest.push("");
    if (/^\s/.test(raw) && !inOpening) return void rest.push(raw.replace(/\s+$/, ""));
    if (/^fallback\s*:/i.test(t)) {
      state = "fallback";
      return void fallback.push(t.replace(/^fallback\s*:\s*/i, ""));
    }
    const dir = COPY_DIRECTION.exec(t);
    if (dir) {
      const before = t.slice(0, dir.index).trim();
      if (before && inOpening && state === "idea") idea.push(before);
      copy.push(...copyParts(`- ${t.slice(dir.index + dir[0].length)}`));
      state = "copy";
      return;
    }
    if (COPY_LABEL.test(t) && (state === "copy" || inOpening)) {
      copy.push(...copyParts(t.startsWith("-") ? t : `- ${t}`));
      state = "copy";
      return;
    }
    if (!inOpening) return void rest.push(raw.replace(/\s+$/, ""));
    if (state === "fallback") return void fallback.push(t);
    if (state === "idea" && !/^[A-Z][^.!?\n]{0,48}:\s*$/.test(t)) return void idea.push(t);
    rest.push(raw.replace(/\s+$/, ""));
  };
  for (const l of opening) read(l, true);
  state = "idea";
  for (const l of after) {
    if (!l.trim()) state = "idea";
    read(l, false);
  }
  const f = splitFallback(fallback.join(" "));
  return { idea: sentences(idea.join(" "))[0] ?? "", fallback: f.short, fallbackMore: f.more, copy, rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Copy the brief's Copy section leaves empty, filled from copy direction found in the opening */
export function withCopyDirection(own: CopySet, direction: string[]): CopySet {
  const d = copyOf(direction);
  return { primary: own.primary.length ? own.primary : d.primary, headlines: own.headlines.length ? own.headlines : d.headlines, cta: own.cta || d.cta };
}

// "Confirm with client" never holds the work: a line telling the maker to hold, wait or not start says what to check
const HOLD = [
  /\b(?:hold|holds|holding|park|pause|freeze)\s+(?:this|the)\s+(?:ticket|brief|work|request|job|design|edit)\b/i,
  /\buntil the client (?:says|confirms|answers|replies|approves|signs off|agrees|gets back)\b/i,
  /\b(?:it|this|the (?:ticket|work|brief|request))\s+(?:waits|will wait|is on hold|stays on hold)\b/i,
  /\bblocks?\s+(?:the|this)\s+(?:work|brief|ticket|request)\b/i,
  /\b(?:don'?t|do not)\s+(?:start|begin|make it|build it)\b/i,
  /\bwait (?:for|on) the client\b/i,
  /\bon hold\b/i,
];

/** A confirm line without hold, wait or block language ("Hold this ticket until the client says yes" is "Check before making it.") */
export function withoutHold(line: string) {
  const ss = sentences(line);
  if (!ss.some((x) => HOLD.some((re) => re.test(x)))) return one(line);
  const out: string[] = [];
  for (const x of ss) {
    const keep = HOLD.some((re) => re.test(x)) ? "Check before making it." : x;
    if (!out.includes(keep)) out.push(keep);
  }
  return out.join(" ");
}

/** The spec as the brief's text, its sections in order, empty ones left out */
export function renderSpec(sp: BriefSpec): string {
  const blocks: string[] = [];
  const line = (h: Heading, v: string) => v.trim() && blocks.push(`${h}: ${one(v)}`);
  const bullets = (h: Heading, xs: string[]) => list(xs).length && blocks.push(`${h}:\n${list(xs).map((x) => `- ${x}`).join("\n")}`);
  line("Stage", sp.stage);
  line("Why it works", sp.insight.trim() ? `${one(sp.insight)}${sp.insightSource.trim() ? ` (Source: ${one(sp.insightSource)})` : ""}` : "");
  line("Who it's for", sp.who);
  line("Key message", sp.keyMessage);
  line("Hook", sp.hook);
  bullets("Proof", sp.proof);
  line("Length", sp.length);
  bullets("Beats", sp.beats);
  line("Audio", sp.audio);
  if (list(sp.slides).length) blocks.push(`Slides:\n${list(sp.slides).map((x, i) => `${i + 1}. ${x}`).join("\n")}`);
  bullets("Frame", sp.frame);
  const versions = sp.versions.map(versionText).filter(Boolean);
  if (versions.length) blocks.push(`Versions:\n${versions.map((x, i) => `- V${i + 1}: ${x}`).join("\n")}`);
  bullets("Constraints", sp.constraints);
  bullets("Must", sp.dos);
  bullets("Never", sp.donts);
  line("Your call", sp.yourCall);
  const assets = sp.assets.filter((a) => one(a.item));
  if (assets.length) blocks.push(`Assets:\n${assets.map((a) => `- ${ASSET_WORD[a.status]}: ${one(a.item)}`).join("\n")}`);
  bullets("Copy", sp.copy);
  line("KPI", sp.kpi);
  line("Success looks like", sp.success);
  if (sp.script.trim()) blocks.push(`Script:\n${sp.script.trim()}`);
  const facts = sp.confirm.filter((f) => one(f.question));
  if (facts.length) blocks.push(`Confirm with client:\n${facts.map((f) => `- ${factLine(f)}`).join("\n")}`);
  line("Export", sp.exportLine);
  return blocks.join("\n\n");
}

const HEAD_KEY: Record<string, Heading> = Object.fromEntries(SPEC_HEADINGS.map((h) => [h.toLowerCase(), h]));
// Older spellings read the same way
HEAD_KEY["insight"] = "Why it works";
HEAD_KEY["who it is for"] = "Who it's for";
HEAD_KEY["funnel stage"] = "Stage";
HEAD_KEY["do"] = "Must";
HEAD_KEY["dos"] = "Must";
HEAD_KEY["don't"] = "Never";
HEAD_KEY["don'ts"] = "Never";
HEAD_KEY["donts"] = "Never";
HEAD_KEY["success"] = "Success looks like";
HEAD_KEY["the frame"] = "Frame";
HEAD_KEY["the beats"] = "Beats";

const assetOf = (raw: string): SpecAsset => {
  const t = raw.replace(/^[-•*]\s+/, "").trim();
  const m = /^(Have|Need|Client to shoot|Shoot|Missing):\s*(.+)$/i.exec(t);
  if (!m) return { item: t, status: /\bmissing\b/i.test(t) ? "missing" : "have" };
  const w = m[1].toLowerCase();
  return { item: m[2].trim(), status: w === "have" ? "have" : w === "need" ? "need" : w === "missing" ? "missing" : "shoot" };
};

/**
 * The brief's text read back into its parts: overview (the lines before the first heading, and anything under a
 * heading this doesn't know) and the spec. structured: it had at least two headings, one of them the insight, the
 * hook, the versions, the beats or "Your call".
 */
export function parseBrief(text: string): { overview: string; spec: BriefSpec; structured: boolean } {
  const sp = emptySpec();
  const rest: string[] = [];
  let head: Heading | null = null;
  const script: string[] = [];
  let seen = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    // A heading starts its line: an indented "Hook:" or "Copy:" belongs to an older brief's concept list
    const h = /^\s/.test(raw) ? null : /^([A-Z][A-Za-z' ]{1,30}):\s*(.*)$/.exec(t);
    const key = h ? HEAD_KEY[h[1].toLowerCase()] : undefined;
    if (h && key) {
      head = key;
      seen++;
      const v = h[2].trim();
      if (v) take(key, v, true);
      continue;
    }
    if (!t) {
      // A script keeps its blank lines; any other section ends at one
      if (head === "Script") script.push("");
      else {
        rest.push("");
        head = null;
      }
      continue;
    }
    if (head) take(head, t, false);
    else {
      // A heading this module doesn't know ("Concepts:", "Hooks to try:") stays with the overview, under its heading
      rest.push(raw.replace(/\s+$/, ""));
    }
  }
  function take(key: Heading, v: string, inline: boolean) {
    const item = v.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    const join = (was: string) => [was, v].filter(Boolean).join(" ");
    switch (key) {
      case "Why it works": {
        const m = sourced(v);
        sp.insight = [sp.insight, m ? m[1] : v].filter(Boolean).join(" ");
        if (m) sp.insightSource = m[2].trim();
        return;
      }
      case "Who it's for":
        sp.who = join(sp.who);
        return;
      case "Stage":
        sp.stage = join(sp.stage);
        return;
      case "Key message":
        sp.keyMessage = join(sp.keyMessage);
        return;
      case "Hook":
        sp.hook = join(sp.hook);
        return;
      case "Length":
        sp.length = join(sp.length);
        return;
      case "Audio":
        sp.audio = join(sp.audio);
        return;
      case "KPI":
        sp.kpi = join(sp.kpi);
        return;
      case "Success looks like":
        sp.success = join(sp.success);
        return;
      case "Your call":
        sp.yourCall = join(sp.yourCall);
        return;
      case "Export":
        sp.exportLine = join(sp.exportLine);
        return;
      case "Script":
        script.push(inline ? v.trim() : v);
        return;
      case "Proof":
        sp.proof.push(item);
        return;
      case "Beats":
        sp.beats.push(v.replace(/^[-•*]\s+/, "").trim());
        return;
      case "Slides":
        sp.slides.push(item);
        return;
      case "Frame":
        sp.frame.push(item);
        return;
      case "Versions":
        sp.versions.push(versionText(v));
        return;
      case "Constraints":
        sp.constraints.push(item);
        return;
      case "Must":
        sp.dos.push(item);
        return;
      case "Never":
        sp.donts.push(item);
        return;
      case "Assets":
        sp.assets.push(assetOf(v));
        return;
      case "Copy":
        sp.copy.push(item);
        return;
      case "Confirm with client":
        sp.confirm.push(parseFactLine(v));
        return;
    }
  }
  sp.script = script.join("\n").trim();
  const overview = rest.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const structured = Boolean(sp.insight || sp.hook || sp.yourCall || sp.versions.length || sp.beats.length) && seen >= 2;
  return { overview, spec: sp, structured };
}

/** A writer's spec made safe to keep: trimmed, capped (two pages), no em dashes, "Your call" always said */
export function cleanSpec(raw: Partial<BriefSpec> | null | undefined): BriefSpec {
  const t = (s: unknown, max = 600) => (typeof s === "string" ? one(s).slice(0, max) : "");
  const xs = (v: unknown, n = 8, max = 300) => (Array.isArray(v) ? v.map((x) => t(x, max)).filter(Boolean).slice(0, n) : []);
  const statuses = ["have", "need", "shoot", "missing"];
  const beats = xs(raw?.beats, LIMITS.beats, 500).map((x) => beatLine(beatOf(x))).filter(Boolean);
  const slides = xs(raw?.slides, LIMITS.slides, 300).map((x) => slideLine(slideOf(x))).filter(Boolean);
  return {
    insight: t(raw?.insight, 700),
    insightSource: t(raw?.insightSource, 160),
    who: t(raw?.who, 240),
    stage: t(raw?.stage, 60),
    keyMessage: t(raw?.keyMessage, 300),
    hook: t(raw?.hook, 300),
    proof: xs(raw?.proof, 6),
    length: t(raw?.length, 40),
    beats,
    audio: t(raw?.audio, 240),
    slides,
    frame: frameLines(frameOf(xs(raw?.frame, 8, 300))),
    versions: xs(raw?.versions, LIMITS.versions, 240).map(versionText).filter(Boolean),
    constraints: xs(raw?.constraints, 10),
    dos: xs(raw?.dos, LIMITS.must, 200),
    donts: xs(raw?.donts, LIMITS.never, 200),
    assets: (Array.isArray(raw?.assets) ? raw.assets : [])
      .map((a) => ({ item: t(a?.item, 460), status: (statuses.includes(a?.status as string) ? a.status : "need") as AssetStatus }))
      .filter((a) => a.item)
      .slice(0, LIMITS.assets),
    copy: copyLines(copyOf(xs(raw?.copy, 10, 600))),
    kpi: t(raw?.kpi, 200),
    success: t(raw?.success, 300),
    yourCall: t(raw?.yourCall, 400) || YOUR_CALL_DEFAULT,
    script: typeof raw?.script === "string" ? raw.script.replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 4000) : "",
    confirm: (Array.isArray(raw?.confirm) ? raw.confirm : [])
      .map((c) => ({ question: withoutHold(t(c?.question, 300)), answer: t(c?.answer, 600), source: t(c?.source, 120) }))
      .filter((c) => c.question)
      .slice(0, LIMITS.confirm),
    exportLine: t(raw?.exportLine, 400),
  };
}

/** The brief's text from its overview and spec: overview first, then the spec's sections */
export function composeBrief(overview: string, sp: BriefSpec) {
  return [overview.trim(), renderSpec(sp)].filter(Boolean).join("\n\n");
}

/**
 * A writer's brief with its spec folded in, idempotent: any spec sections already in the brief are replaced by the
 * spec's (so a draft cleaned twice never doubles them).
 */
export function withSpec(brief: string, sp: BriefSpec | null | undefined) {
  if (!sp) return brief;
  return composeBrief(parseBrief(brief).overview, sp);
}

/**
 * A writer's brief, written as one string under the fixed headings (no nested schema: the API refuses grammars that
 * are too large), read back here: tidied (cleanSpec), the client-only facts it doesn't answer added to "Confirm with
 * client", and written again. Never loses a brief: one that doesn't read as sections, or anything that goes wrong
 * reading it, comes back exactly as written (free text).
 */
export function structureBrief(brief: string, title: string, addFacts?: (sp: BriefSpec, title: string) => BriefSpec): string {
  try {
    const p = parseBrief(brief);
    if (!p.structured) return brief;
    const sp = cleanSpec(p.spec);
    return composeBrief(p.overview, addFacts ? addFacts(sp, title) : sp);
  } catch {
    return brief;
  }
}

/** How the writers write the brief: the same words for every writer (roles, never names; no em dashes) */
export const SPEC_RULE = `THE BRIEF'S SHAPE. One structure for every format; only The build changes. The brief fixes the message, the payoff, the hook lines, the musts and the nevers; how it's made is the maker's call. Not so structured that the creative team is boxed in, not so loose that they run wild. It fits on two pages: every list 5 items or fewer, every line one short sentence, nothing said twice.
Write draft.brief as plain text: first ONE sentence with the idea and its concrete payoff (what the viewer learns or gets, e.g. "The owner's one-word answer, Convenience, is the detail: a real local team and more than one way to buy"). That opening is the idea only: never copy direction, primary text, headlines or a CTA there (they go under Copy). Then these sections, each starting on its own line with the heading exactly as written here, a blank line between sections, list items as "- " lines. Leave a section out when there's nothing to say.
Stage: the funnel stage in a few words ("Evergreen TOF", "Retargeting BOF").
Why it works: the insight in one or two sentences, the specific, true thing the ad says or shows, then where it comes from in the context in brackets, e.g. "(Source: Brand Bible)", "(Source: call Oct 12)"; no source when it isn't in the context.
Who it's for: one line, the avatar and what they want. Targeting is the media buyer's call: no ages, places or interest lists.
THE BUILD, for the request's format (only the one that applies; a request with several formats gets each):
Length: (video) about how long, e.g. "~30s".
Beats: (video, 4 to 6) one line each: "- <time> | <name> | On screen: <what we see, a few words> | Says: "<the exact spoken line>" (Source: <file> <timestamp>)", or "| Text: "<on-screen text>"" for words put on screen. Quote a line from footage only when assets_on_drive or a transcript gives it, with its file and timestamp; otherwise write the line to record or to put on screen. The first beat is the hook, the last the end card. A beat says what happens, never how to cut it.
Audio: (video) music and voiceover direction in one line.
Slides: (carousel) one numbered line per slide, read top to bottom as a flow: "1. <job: Hook, Proof, Payoff or CTA> | Headline: <the words on the slide> | Shows: <what it shows>".
Frame: (single image) "- Headline: <the words>", "- Subline: <the words>", "- Shows: <what's in the frame>", "- Reads first: <the order the eye takes, e.g. headline, then the product, then the button>", "- CTA: <the button text>" (only when it's on the image).
Versions: one line per version with only what changes (the hook or the headline): "- V1: <the line> (net new)", "- V2: <the line>". V1 is net new; every other version changes that one variable and nothing else.
Must: (up to 5) what has to be there: the logo moment, captions, the cleared claims only, the client's Brand Bible rules that matter here folded in. A real person's face or voice altered or generated (an AI avatar of a customer, a cloned or pitch-shifted voice, a face swap) gets a "Disclaimer: <the on-screen line>" item here and "Get the client's written consent for <who>'s likeness/voice" under Confirm with client.
Never: (up to 5, specific) the exact lines, assets and claims not to use ("Don't use: 'two great offices', the VIP lounge"), and the client's don'ts that matter here, folded in, never appended as a long list.
Your call: one line handing the maker edit style, cut points, transitions, which clips or photos within the folders, and music within the rules. Never direct those yourself.
Assets: (3 to 5 groups) each starting with its status: "- Have: <the file or folder exactly as assets_on_drive names it> (Drive: <folder>), <what to take from it, in a few words>", "- Need: <asset>", "- Client to shoot: <asset>", "- Missing: <a link that doesn't open>". Prefer a specific file over a whole folder when the file list shows it. List a file only when what we know about it (its name, folder, date) clearly fits this angle; when nothing on Drive clearly fits, write "- Need: <what to look for or get>" instead of pointing at a clip that may be unrelated. Don't write Drive links yourself: the app adds each file's link from its name. Never write a placeholder like MISSING or TBD in place of a link.
Copy: "- Primary: <text>" (up to 2), "- Headline: <text>" (up to 2), "- CTA: <the button>". The concept's copy direction lives here, never in the opening.
Script: only when the request explicitly asked for a script or voiceover text. Beats are not a script.
Confirm with client: (only when something is open) every fact the concept depends on that only the client knows (which seat or spot, the tip, the stat, the offer's terms, a date) and that the context doesn't answer, as the question to ask them, short and specific ("- Which seat, at which venue, and why?"). When the context does answer it, use it and write "- <question> Answer: <answer> (Source: <where>)". NEVER invent such a fact. It never holds the work: never write "hold this ticket", "wait for the client", "until the client says yes" or "don't start"; the maker goes ahead, and a line says what to check before making it. When the concept hangs on the answer, add a line after the idea that starts "Fallback:" with a version that works without it, in one short sentence (under 25 words).
Never write specs, sizes, safe zones or file names (the app adds the export line), a "next step", delivery instructions, or a summary that repeats the sections. Every line must agree with every other: no logo rule against a hook that shows the logo, no "evergreen" rule against event footage.
${PAYOFF_RULE}`;
