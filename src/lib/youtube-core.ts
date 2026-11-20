// YouTube learning, the pure part (no database, no network, no AI), so the rules are easy to test: reading YouTube
// links, the channel feed and caption tracks; cleaning the AI's takeaways; and who each takeaway goes to, by line and
// role (never by name). The server side is src/lib/youtube.ts; the page is Settings › AI agents › YouTube.

// ─── Links ──────────────────────────────────────────────────────────────────

export type YtRef = { kind: "video"; id: string } | { kind: "channel"; channelId: string } | { kind: "handle"; handle: string } | { kind: "custom"; path: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A YouTube link, @handle or channel id → what it points at; null when it isn't YouTube */
export function parseYouTube(input: string | null | undefined): YtRef | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^@[\w.-]{2,100}$/.test(raw)) return { kind: "handle", handle: raw.slice(1) };
  if (CHANNEL_ID.test(raw)) return { kind: "channel", channelId: raw };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return VIDEO_ID.test(id) ? { kind: "video", id } : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = u.searchParams.get("v");
  if (v && VIDEO_ID.test(v)) return { kind: "video", id: v };
  const parts = u.pathname.split("/").filter(Boolean);
  const [a, b] = parts;
  if (!a) return null;
  if (["shorts", "live", "embed", "v"].includes(a) && b && VIDEO_ID.test(b)) return { kind: "video", id: b };
  if (a === "channel" && b && CHANNEL_ID.test(b)) return { kind: "channel", channelId: b };
  if (a.startsWith("@") && a.length > 2) return { kind: "handle", handle: decodeURIComponent(a.slice(1)) };
  if ((a === "c" || a === "user") && b) return { kind: "custom", path: `${a}/${b}` };
  return null;
}

/** Every YouTube video link in a piece of text, once each */
export function videoIdsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>()"']+/gi)) {
    const r = parseYouTube(m[0]);
    if (r?.kind === "video") out.add(r.id);
  }
  return [...out];
}

export const videoUrl = (id: string, atSeconds?: number | null) => `https://www.youtube.com/watch?v=${id}${atSeconds && atSeconds > 0 ? `&t=${Math.floor(atSeconds)}s` : ""}`;
export const channelUrl = (channelId: string) => `https://www.youtube.com/channel/${channelId}`;
export const feedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/** Seconds as m:ss (or h:mm:ss) */
export const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

// ─── The channel feed ───────────────────────────────────────────────────────

export const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : null;
};

export type FeedVideo = { videoId: string; title: string; publishedAt: string | null; description: string | null; thumbnail: string | null; channelTitle: string | null; channelId: string | null; short: boolean };
export type Feed = { channelTitle: string | null; channelId: string | null; videos: FeedVideo[] };

/** A channel's RSS feed (youtube.com/feeds/videos.xml?channel_id=…): its name and latest uploads, newest first */
export function parseFeed(xml: string): Feed {
  const head = xml.split("<entry")[0] ?? "";
  const channelTitle = tag(head, "title");
  const channelId = tag(head, "yt:channelId");
  const videos: FeedVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const videoId = tag(e, "yt:videoId");
    if (!videoId || !VIDEO_ID.test(videoId)) continue;
    const cid = tag(e, "yt:channelId");
    const title = tag(e, "title") ?? tag(e, "media:title") ?? "";
    videos.push({
      videoId,
      title,
      // A Short (its link is /shorts/, or the title says so): too thin to teach, never read from a channel
      short: /youtube\.com\/shorts\//.test(e) || /#shorts?\b/i.test(title),
      publishedAt: tag(e, "published"),
      description: tag(e, "media:description"),
      thumbnail: e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null,
      channelTitle: tag(e.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? "", "name") ?? channelTitle,
      channelId: cid ? (cid.startsWith("UC") ? cid : `UC${cid}`) : channelId ? (channelId.startsWith("UC") ? channelId : `UC${channelId}`) : null,
    });
  }
  videos.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { channelTitle, channelId: channelId ? (channelId.startsWith("UC") ? channelId : `UC${channelId}`) : null, videos };
}

/** The channel id written into a channel page (its canonical link, or the page's own data) */
export function channelIdFromPage(html: string): string | null {
  return html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? null;
}

/** A page's og: meta value */
export const ogMeta = (html: string, prop: string) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="og:${prop}" content="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};

// ─── Captions ───────────────────────────────────────────────────────────────

export type Cue = { at: number; text: string };

/**
 * A caption track in any of the shapes YouTube serves: the classic XML (<text start dur>), the "format 3" XML
 * (<p t d> in milliseconds, words in <s>), or json3 ({ events: [{ tStartMs, segs: [{ utf8 }] }] })
 */
export function parseCaptions(body: string): Cue[] {
  const s = String(body ?? "").trim();
  if (!s) return [];
  const out: Cue[] = [];
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
      for (const e of j.events ?? []) {
        const text = (e.segs ?? []).map((x) => x.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
        if (text) out.push({ at: (e.tStartMs ?? 0) / 1000, text });
      }
    } catch {
      return [];
    }
    return out;
  }
  for (const m of s.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = decodeEntities(decodeEntities(m[2]).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) out.push({ at: Number(m[1]) || 0, text });
  }
  if (out.length) return out;
  for (const m of s.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) out.push({ at: Number(m[1]) / 1000, text });
  }
  return out;
}

/** Cues as a transcript with a time mark about every 30 seconds, so a takeaway can point back to its moment */
export function transcriptOf(cues: readonly Cue[]): string {
  const lines: string[] = [];
  let mark = -Infinity;
  let line: string[] = [];
  for (const c of cues) {
    if (c.at - mark >= 30) {
      if (line.length) lines.push(line.join(" "));
      mark = c.at;
      line = [`[${clock(c.at)}]`];
    }
    line.push(c.text);
  }
  if (line.length) lines.push(line.join(" "));
  return lines.join("\n");
}

/** "[1:02:03]" or "1:23" or 83 → seconds; null when it isn't a time */
export function secondsOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  const m = String(v ?? "").trim().replace(/^\[|\]$/g, "").match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

/** The caption track to read: English made by a person first, then English auto-captions, then anything */
export function pickTrack<T extends { languageCode?: string; kind?: string }>(tracks: readonly T[]): T | null {
  if (!tracks.length) return null;
  const en = (t: T) => (t.languageCode ?? "").toLowerCase().startsWith("en");
  return tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find(en) ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
}

// ─── Lines and roles ────────────────────────────────────────────────────────

/** The lines a source or takeaway teaches. meta is the Meta and TikTok ads line. */
export const YT_LINES = ["meta", "google", "creative", "email", "social"] as const;
export type YtLine = (typeof YT_LINES)[number];
export const YT_LINE_LABEL: Record<YtLine, string> = { meta: "Meta + TikTok ads", google: "Google ads", creative: "Creative", email: "Email", social: "Organic social" };

/** Only real lines, once each, in order; "all" means every line */
export function cleanLines(xs: readonly unknown[] | null | undefined): YtLine[] {
  const list = (xs ?? []).map((x) => String(x).toLowerCase().trim());
  if (list.includes("all")) return [...YT_LINES];
  const alias = (x: string) => (x === "tiktok" || x === "facebook" || x === "paid_social" ? "meta" : x === "design" || x === "video" ? "creative" : x);
  return YT_LINES.filter((l) => list.map(alias).includes(l));
}

/** The team roles a takeaway can be about (what the AI may tag), and who they are in plain words for the prompt */
export const YT_ROLES = [
  "head_of_meta", "media_buyer", "head_of_google", "google_buyer",
  "head_of_creative", "lead_graphic_designer", "graphic_designer", "lead_video_editor", "video_editor", "copywriter",
  "head_of_email", "email_strategist", "email_designer", "email_builder",
  "head_of_social", "social_media_manager",
] as const;
export type YtRole = (typeof YT_ROLES)[number];

/**
 * Who hears about a takeaway on each line, always: the line's head and the people who run it day to day. The craft
 * roles (graphic designers for images, video editors for video, the copywriter, email designers and builders) only
 * when the takeaway is tagged with their role: it's about their craft.
 */
export const LINE_ALWAYS: Record<YtLine, readonly string[]> = {
  meta: ["head_of_meta", "media_buyer"],
  google: ["head_of_google", "google_buyer"],
  creative: ["head_of_creative", "lead_graphic_designer", "lead_video_editor"],
  email: ["head_of_email", "email_strategist"],
  social: ["head_of_social", "social_media_manager"],
};
export const LINE_CRAFT: Record<YtLine, readonly string[]> = {
  meta: [],
  google: [],
  creative: ["graphic_designer", "video_editor", "copywriter"],
  email: ["email_designer", "email_builder"],
  social: [],
};

/** The head of each line: with the execs, the only ones who accept a takeaway into the agents' learning */
export const LINE_HEAD: Record<YtLine, string> = { meta: "head_of_meta", google: "head_of_google", creative: "head_of_creative", email: "head_of_email", social: "head_of_social" };

/** An exec's focus lines that cover each takeaway line (src/lib/exec-focus/core.ts FOCUS_LINES) */
const FOCUS_OF: Record<YtLine, readonly string[]> = { meta: ["meta", "tiktok"], google: ["google"], creative: ["creative", "creative_performance"], email: ["email"], social: ["social"] };

/** Whether an exec's focus covers any of these lines (no focus set: everything) */
export function focusCovers(focus: readonly string[] | null | undefined, lines: readonly YtLine[]): boolean {
  if (!focus?.length) return true;
  return lines.some((l) => FOCUS_OF[l].some((f) => focus.includes(f)));
}

/** Whether this person decides on a takeaway on these lines: an exec, or the head of one of its lines */
export const canDecide = (me: { role: string | null | undefined; isExec?: boolean | null }, lines: readonly YtLine[]) => Boolean(me.isExec) || lines.some((l) => LINE_HEAD[l] === me.role);

/** Whether this person adds and edits sources: an exec or any line head */
export const canManageSources = (me: { role: string | null | undefined; isExec?: boolean | null }) => Boolean(me.isExec) || (Object.values(LINE_HEAD) as string[]).includes(String(me.role ?? ""));

export type Person = { id: string; role: string; isExec: boolean; execFocus?: readonly string[] | null; active?: boolean };
export type Routed = { team: string[]; execs: string[] };

/**
 * Everyone a takeaway goes to: on each of its lines, the line's head and day-to-day people, plus the craft roles it's
 * tagged with; the execs whose focus covers one of its lines get it in their digest. A lead maker counts as a lead.
 */
export function routeTakeaway(t: { lines: readonly YtLine[]; roles: readonly string[] }, people: readonly Person[]): Routed {
  const want = new Set<string>();
  for (const l of t.lines) {
    for (const r of LINE_ALWAYS[l]) want.add(r);
    for (const r of LINE_CRAFT[l]) if (t.roles.includes(r)) want.add(r);
  }
  // A takeaway tagged with a role on a line it isn't filed under still reaches that role (an editing tip on a Meta video)
  for (const r of t.roles) if ((YT_ROLES as readonly string[]).includes(r)) want.add(r);
  const team: string[] = [];
  const execs: string[] = [];
  for (const p of people) {
    if (p.active === false) continue;
    if (p.isExec) {
      if (t.lines.length && focusCovers(p.execFocus, t.lines)) execs.push(p.id);
      continue;
    }
    if (want.has(p.role)) team.push(p.id);
  }
  return { team, execs };
}

// ─── The agents a takeaway teaches ──────────────────────────────────────────

/**
 * The role agents a takeaway is filed to when it's accepted: the line's agent, plus the email creative or builder, or
 * the copywriter, when it's about their craft
 */
export function agentsForTakeaway(t: { lines: readonly YtLine[]; roles: readonly string[] }): string[] {
  const out: string[] = [];
  const add = (k: string) => void (out.includes(k) || out.push(k));
  for (const l of t.lines) {
    if (l === "meta") add("media_buyer");
    if (l === "google") add("google_buyer");
    if (l === "creative") {
      add("creative_director");
      if (t.roles.includes("copywriter")) add("copywriter");
    }
    if (l === "email") {
      add("email_strategist");
      if (t.roles.includes("email_designer")) add("email_creative");
      if (t.roles.includes("email_builder")) add("email_builder");
    }
    if (l === "social") add("social_strategist");
  }
  return out;
}

// ─── The AI's takeaways ─────────────────────────────────────────────────────

export type Takeaway = { takeaway: string; why: string; lines: YtLine[]; roles: YtRole[]; atSeconds: number | null };

const tidy = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * The AI's takeaways, cleaned: real text only, lines and roles we know (a takeaway with no line takes the source's),
 * the time mark read as seconds within the video's length, near-duplicates dropped, at most `max`
 */
export function cleanTakeaways(raw: unknown, opts: { fallbackLines: readonly YtLine[]; max?: number; durationSeconds?: number | null }): Takeaway[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Takeaway[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    const takeaway = tidy(o.takeaway ?? o.text, 500);
    if (takeaway.length < 12) continue;
    const key = takeaway.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = cleanLines(Array.isArray(o.lines) ? o.lines : []);
    const roles = [...new Set((Array.isArray(o.roles) ? o.roles : []).map((x) => String(x)).filter((x): x is YtRole => (YT_ROLES as readonly string[]).includes(x)))];
    let at = secondsOf(o.at ?? o.at_seconds ?? o.timestamp);
    if (at !== null && opts.durationSeconds && at > opts.durationSeconds) at = null;
    out.push({ takeaway, why: tidy(o.why, 300), lines: lines.length ? lines : [...opts.fallbackLines], roles, atSeconds: at });
    if (out.length >= (opts.max ?? 8)) break;
  }
  return out;
}

/** The learning an accepted takeaway becomes: the lesson, with where it came from */
export function learningText(t: { takeaway: string; why?: string | null }, v: { title: string | null; channel: string | null; url: string }): string {
  const src = `${v.channel ? `${v.channel}, ` : ""}"${(v.title ?? "a YouTube video").slice(0, 120)}" (${v.url})`;
  return `${t.takeaway}${t.why ? ` Why: ${t.why}` : ""} Source: ${src}.`.slice(0, 800);
}

// ─── The notices ────────────────────────────────────────────────────────────

export type NoticeTakeaway = { videoTitle: string; channel: string | null; decide: boolean };

/** One person's notice for the day: how many takeaways from how many videos, the first few titles, and what's theirs to decide */
export function noticeText(items: readonly NoticeTakeaway[], opts: { digest?: boolean } = {}): { title: string; body: string } {
  const videos = [...new Map(items.map((i) => [i.videoTitle, i])).values()];
  const decide = items.filter((i) => i.decide).length;
  const n = items.length;
  const title = opts.digest
    ? `YouTube digest: ${n} takeaway${n === 1 ? "" : "s"} from ${videos.length} video${videos.length === 1 ? "" : "s"} today`
    : `${n} new takeaway${n === 1 ? "" : "s"} from YouTube for your work`;
  const names = videos
    .slice(0, 3)
    .map((v) => `"${v.videoTitle.slice(0, 70)}"${v.channel ? ` (${v.channel})` : ""}`)
    .join(", ");
  const more = videos.length > 3 ? ` and ${videos.length - 3} more` : "";
  const ask = decide ? ` ${decide} wait${decide === 1 ? "s" : ""} for your call: accept into the agents' learning, call in an agent, or dismiss.` : "";
  return { title, body: `From ${names}${more}.${ask}` };
}

// ─── Transcripts: which source next ─────────────────────────────────────────

/** Past this a channel's video isn't transcribed (cost), unless it was added on purpose: about an hour */
export const MAX_SECONDS = 62 * 60;

export type TranscriptStep = "gemini" | "service" | "wait-key" | "long" | "unavailable" | "later" | "paste";

/**
 * Where a video's transcript comes from when the free captions track gave none, in the owner's order: Gemini (when
 * its key is set and this run's cap has room), then the transcript service (when its key is set), then a person
 * pasting it. A private, removed or age-restricted video stops here; a channel's video past an hour waits for someone
 * to add it on purpose; with no key at all it waits for the Gemini key.
 */
export function nextTranscriptStep(v: { playable: string | null; seconds: number | null; allowLong: boolean; geminiKey: boolean; geminiLeft: number; serviceKey: boolean; geminiFailed?: boolean }): TranscriptStep {
  if (v.playable === "ERROR" || v.playable === "LOGIN_REQUIRED" || v.playable === "UNPLAYABLE") return "unavailable";
  if (!v.allowLong && v.seconds && v.seconds > MAX_SECONDS) return "long";
  if (v.geminiKey && !v.geminiFailed) return v.geminiLeft > 0 ? "gemini" : "later";
  if (v.serviceKey) return "service";
  return v.geminiKey ? "paste" : "wait-key";
}

/** Gemini's answer as a transcript: code fences and preambles dropped; null when it found no speech */
export function cleanGeminiTranscript(raw: string | null | undefined): string | null {
  let t = String(raw ?? "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t || /^NO_SPEECH\b/i.test(t)) return null;
  // Anything before the first time mark is the model talking, not the video
  const first = t.search(/\[\d{1,2}:\d{2}(?::\d{2})?\]/);
  if (first > 0 && first < 300) t = t.slice(first);
  return t.length >= 40 ? t : null;
}

/**
 * What a Gemini error means: 'unavailable' (the video is private, removed or age-restricted: Gemini can't open it),
 * 'key' (the key is missing, wrong or not allowed), 'retry' (a rate limit, an overload, a timeout: try again later)
 */
export function geminiErrorKind(status: number, message: string): "unavailable" | "key" | "retry" {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || /api key|permission denied|api_key_invalid|unauthenticated/.test(m)) return "key";
  if (status === 429 || status >= 500) return "retry";
  if (/private|unavailable|not found|age|restricted|cannot be accessed|could not (be )?(read|process|access)|invalid video|no longer|removed|unsupported/.test(m)) return "unavailable";
  return "retry";
}

/** What a blocked video's state reads as on its card */
export const BLOCKED_LABEL: Record<"key" | "unavailable" | "long", string> = { key: "Waiting for the Gemini key", unavailable: "Video unavailable", long: "Over an hour" };
