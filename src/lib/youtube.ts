import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import {
  agentsForTakeaway,
  canDecide,
  channelIdFromPage,
  channelUrl,
  cleanLines,
  cleanTakeaways,
  feedUrl,
  learningText,
  noticeText,
  ogMeta,
  parseCaptions,
  parseFeed,
  parseYouTube,
  pickTrack,
  routeTakeaway,
  transcriptOf,
  videoUrl,
  YT_LINE_LABEL,
  YT_LINES,
  YT_ROLES,
  type NoticeTakeaway,
  type Person,
  type Takeaway,
  type YtLine,
} from "@/lib/youtube-core";

// YouTube learning: channels and videos the agents keep studying (Settings › AI agents › YouTube). Built on the Loom
// pipeline's pattern: everything is queued (one row per video, ever), a worker in the context cron (?step=youtube)
// claims a few at a time within a time budget, reads each video (title, description, transcript), and the AI turns it
// into attributed takeaways. A takeaway is shared in the app with everyone on the lines it involves, by role; a line
// head or an exec accepts it into the agents' learning (only then do the agents read it), calls in an agent to work it
// into the playbook, or dismisses it.
//
// Reading YouTube without signing in: a channel's new uploads come from the YouTube Data API when YOUTUBE_API_KEY is
// set, else from the channel's public RSS feed. A @handle is resolved to its channel id once, from the channel page.
// The transcript comes from the caption track the watch page lists (YouTube sometimes refuses it to a server), else
// from a transcript service when YOUTUBE_TRANSCRIPT_API_KEY is set (Supadata). A video with neither is kept as
// "no transcript": anyone can paste its transcript (YouTube's "Show transcript") and it's read like the rest.

type Admin = SupabaseClient;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PAGE_HEADERS = { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "SOCS=CAI; CONSENT=YES+1" };
const DAY = 86_400_000;
const TRANSCRIPT_CHARS = 80_000;
/** A new channel: how many of its latest videos are read (the rest of its history isn't, unless added by link) */
const BACKFILL = 5;

const apiKey = () => process.env.YOUTUBE_API_KEY?.trim() || null;
const transcriptKey = () => process.env.YOUTUBE_TRANSCRIPT_API_KEY?.trim() || null;

async function get(url: string, opts: { headers?: Record<string, string>; ms?: number } = {}) {
  return fetch(url, { cache: "no-store", headers: opts.headers ?? PAGE_HEADERS, signal: AbortSignal.timeout(opts.ms ?? 20_000) });
}

// ─── Reading YouTube ────────────────────────────────────────────────────────

export type ChannelInfo = { channelId: string; title: string | null; handle: string | null; thumbnail: string | null; about: string | null };

/** A channel link, @handle or id → the channel (resolved once, when it's added) */
export async function resolveChannel(input: string): Promise<ChannelInfo> {
  const ref = parseYouTube(input);
  if (!ref || ref.kind === "video") throw new Error("That isn't a YouTube channel. Paste the channel's link or its @handle.");
  const key = apiKey();
  if (key) {
    const q = ref.kind === "channel" ? `id=${ref.channelId}` : ref.kind === "handle" ? `forHandle=${encodeURIComponent(`@${ref.handle}`)}` : `forUsername=${encodeURIComponent(ref.path.split("/")[1])}`;
    const r = await get(`https://www.googleapis.com/youtube/v3/channels?part=snippet&${q}&key=${key}`, { headers: {} }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { items?: { id: string; snippet?: { title?: string; customUrl?: string; description?: string; thumbnails?: { medium?: { url?: string } } } }[] } | null;
    const c = j?.items?.[0];
    if (c) return { channelId: c.id, title: c.snippet?.title ?? null, handle: c.snippet?.customUrl?.replace(/^@/, "") ?? (ref.kind === "handle" ? ref.handle : null), thumbnail: c.snippet?.thumbnails?.medium?.url ?? null, about: c.snippet?.description?.slice(0, 1000) ?? null };
  }
  const page = ref.kind === "channel" ? channelUrl(ref.channelId) : ref.kind === "handle" ? `https://www.youtube.com/@${encodeURIComponent(ref.handle)}` : `https://www.youtube.com/${ref.path}`;
  const r = await get(page).catch(() => null);
  if (!r?.ok) throw new Error(r?.status === 404 ? "YouTube has no channel at that address. Check the link or @handle." : "YouTube didn't answer. Try again in a minute.");
  const html = await r.text();
  const channelId = ref.kind === "channel" ? ref.channelId : channelIdFromPage(html);
  if (!channelId) throw new Error("Couldn't find the channel on that page. Paste the channel's link (youtube.com/@name).");
  return { channelId, title: ogMeta(html, "title"), handle: ref.kind === "handle" ? ref.handle : null, thumbnail: ogMeta(html, "image"), about: ogMeta(html, "description")?.slice(0, 1000) ?? null };
}

export type Upload = { videoId: string; title: string; publishedAt: string | null; description: string | null; thumbnail: string | null; channelTitle: string | null };

/** A channel's latest uploads, newest first (the Data API when there's a key, else the RSS feed: its 15 latest) */
export async function latestUploads(channelId: string): Promise<{ title: string | null; videos: Upload[] }> {
  const key = apiKey();
  if (key) {
    const r = await get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=15&playlistId=UU${channelId.slice(2)}&key=${key}`, { headers: {} }).catch(() => null);
    type Item = { contentDetails?: { videoId?: string; videoPublishedAt?: string }; snippet?: { title?: string; description?: string; channelTitle?: string; thumbnails?: { high?: { url?: string } } } };
    const j = (await r?.json().catch(() => null)) as { items?: Item[] } | null;
    if (r?.ok && j?.items) {
      const videos = j.items
        .filter((i) => i.contentDetails?.videoId)
        .map((i) => ({ videoId: i.contentDetails!.videoId!, title: i.snippet?.title ?? "", publishedAt: i.contentDetails?.videoPublishedAt ?? null, description: i.snippet?.description ?? null, thumbnail: i.snippet?.thumbnails?.high?.url ?? null, channelTitle: i.snippet?.channelTitle ?? null }));
      return { title: videos[0]?.channelTitle ?? null, videos };
    }
  }
  const r = await get(feedUrl(channelId), { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(r.status === 404 ? "YouTube has no feed for this channel any more (renamed or removed?)." : `YouTube's feed answered ${r.status}.`);
  const f = parseFeed(await r.text());
  return { title: f.channelTitle, videos: f.videos };
}

/** The JSON object assigned after `marker` in a page (balanced braces, strings respected) */
function jsonAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export type VideoRead = { title: string | null; channel: string | null; channelId: string | null; description: string | null; publishedAt: string | null; seconds: number | null; thumbnail: string | null; transcript: string | null; found: boolean; via: "captions" | "service" | null };

/** A video's title, channel, description and transcript; transcript null when neither YouTube nor the service gives it */
export async function readVideo(id: string): Promise<VideoRead> {
  const out: VideoRead = { title: null, channel: null, channelId: null, description: null, publishedAt: null, seconds: null, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, transcript: null, found: false, via: null };
  type Player = {
    playabilityStatus?: { status?: string };
    videoDetails?: { title?: string; author?: string; channelId?: string; shortDescription?: string; lengthSeconds?: string };
    microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string } };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl?: string; languageCode?: string; kind?: string }[] } };
  };
  let tracks: { baseUrl?: string; languageCode?: string; kind?: string }[] = [];
  try {
    const r = await get(`https://www.youtube.com/watch?v=${id}&hl=en`);
    if (r.ok) {
      const html = await r.text();
      const p = jsonAfter(html, "ytInitialPlayerResponse") as Player | null;
      const d = p?.videoDetails;
      if (d?.title) {
        out.found = true;
        out.title = d.title;
        out.channel = d.author ?? null;
        out.channelId = d.channelId ?? null;
        out.description = d.shortDescription?.slice(0, 5000) ?? null;
        out.seconds = Number(d.lengthSeconds) || null;
        const m = p?.microformat?.playerMicroformatRenderer;
        out.publishedAt = m?.publishDate ?? m?.uploadDate ?? null;
      } else {
        out.title = ogMeta(html, "title");
        out.found = Boolean(out.title);
      }
      tracks = p?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    }
  } catch {}
  // The caption track the page lists (json3 first: it carries the timings cleanly)
  const track = pickTrack(tracks);
  if (track?.baseUrl) {
    for (const url of [`${track.baseUrl}&fmt=json3`, track.baseUrl]) {
      try {
        const r = await get(url, { headers: { "user-agent": UA } });
        if (!r.ok) continue;
        const cues = parseCaptions(await r.text());
        if (cues.length) {
          out.transcript = transcriptOf(cues);
          out.via = "captions";
          break;
        }
      } catch {}
    }
  }
  // A transcript service, when YouTube won't give the captions to a server
  const key = transcriptKey();
  if (!out.transcript && key) {
    try {
      const r = await get(`https://api.supadata.ai/v1/youtube/transcript?videoId=${id}`, { headers: { "x-api-key": key }, ms: 45_000 });
      const j = (await r.json().catch(() => null)) as { content?: { text?: string; offset?: number }[] | string } | null;
      if (r.ok && j?.content) {
        const cues = Array.isArray(j.content) ? j.content.map((c) => ({ at: (c.offset ?? 0) / 1000, text: (c.text ?? "").trim() })).filter((c) => c.text) : [{ at: 0, text: j.content }];
        if (cues.length) {
          out.transcript = transcriptOf(cues);
          out.via = "service";
          out.found = true;
        }
      }
    } catch {}
  }
  return out;
}

// ─── Sources ────────────────────────────────────────────────────────────────

export type AddResult = { ok: true; id: string; kind: "channel" | "video"; title: string | null; queued: number } | { ok: false; error: string };

/** A channel subscribed (its latest few videos queued) or a single video added. Lines empty: the AI suggests them. */
export async function addSource(admin: Admin, input: string, opts: { lines?: string[]; by: string | null }): Promise<AddResult> {
  const ref = parseYouTube(input);
  if (!ref) return { ok: false, error: "That isn't a YouTube link. Paste a channel (youtube.com/@name), an @handle or a video link." };
  const lines = cleanLines(opts.lines ?? []);
  if (ref.kind === "video") {
    const { data, error } = await admin.from("youtube_sources").insert({ kind: "video", url: videoUrl(ref.id), lines, added_by: opts.by }).select("id").single();
    if (error || !data) return { ok: false, error: error?.message ?? "Couldn't save it." };
    await queueVideos(admin, [{ videoId: ref.id }], { sourceId: data.id as string, by: opts.by });
    return { ok: true, id: data.id as string, kind: "video", title: null, queued: 1 };
  }
  let ch: ChannelInfo;
  try {
    ch = await resolveChannel(input);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read that channel." };
  }
  const { data: had } = await admin.from("youtube_sources").select("id, active").eq("kind", "channel").eq("channel_id", ch.channelId).maybeSingle();
  if (had) {
    await admin.from("youtube_sources").update({ active: true, ...(lines.length ? { lines } : {}), updated_at: new Date().toISOString() }).eq("id", had.id);
    return { ok: true, id: had.id as string, kind: "channel", title: ch.title, queued: 0 };
  }
  const { data, error } = await admin
    .from("youtube_sources")
    .insert({ kind: "channel", url: ch.handle ? `https://www.youtube.com/@${ch.handle}` : channelUrl(ch.channelId), handle: ch.handle, channel_id: ch.channelId, title: ch.title?.slice(0, 200) ?? null, thumbnail_url: ch.thumbnail, about: ch.about, lines, added_by: opts.by })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't save the channel." };
  const checked = await checkSource(admin, data.id as string, { backfill: BACKFILL }).catch((e) => ({ queued: 0, error: e instanceof Error ? e.message : String(e) }));
  if (!lines.length) await suggestLines(admin, data.id as string).catch(() => null);
  return { ok: true, id: data.id as string, kind: "channel", title: ch.title, queued: checked.queued };
}

/** Videos into the queue: one row per YouTube video, ever (a video already there keeps its row) */
export async function queueVideos(admin: Admin, videos: { videoId: string; title?: string | null; publishedAt?: string | null; description?: string | null; thumbnail?: string | null; channelTitle?: string | null }[], opts: { sourceId?: string | null; by?: string | null; onDemand?: boolean }) {
  if (!videos.length) return 0;
  const rows = videos.map((v) => ({
    video_id: v.videoId,
    url: videoUrl(v.videoId),
    source_id: opts.sourceId ?? null,
    title: v.title?.slice(0, 300) || null,
    channel_title: v.channelTitle?.slice(0, 200) || null,
    description: v.description?.slice(0, 5000) || null,
    thumbnail_url: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    published_at: v.publishedAt ?? null,
    on_demand: Boolean(opts.onDemand),
    added_by: opts.by ?? null,
  }));
  const { data, error } = await admin.from("youtube_videos").upsert(rows, { onConflict: "video_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  // A video first read on demand that a source now covers: it joins the source (and is shared like the rest)
  if (opts.sourceId && !opts.onDemand)
    await admin.from("youtube_videos").update({ source_id: opts.sourceId, on_demand: false }).in("video_id", videos.map((v) => v.videoId)).is("source_id", null);
  return (data ?? []).length;
}

/**
 * One channel read again: uploads newer than the newest one we have queued. A new channel queues its latest few
 * (backfill); after that, only what's new.
 */
export async function checkSource(admin: Admin, id: string, opts: { backfill?: number } = {}) {
  const { data: s } = await admin.from("youtube_sources").select("id, kind, channel_id, title, added_by").eq("id", id).single();
  if (!s || s.kind !== "channel" || !s.channel_id) return { queued: 0, error: null as string | null };
  const now = new Date().toISOString();
  try {
    const feed = await latestUploads(s.channel_id as string);
    const { data: have } = await admin.from("youtube_videos").select("video_id, published_at").eq("source_id", id).order("published_at", { ascending: false, nullsFirst: false }).limit(50);
    const known = new Set((have ?? []).map((v) => v.video_id as string));
    const newest = (have ?? [])[0]?.published_at as string | undefined;
    let fresh = feed.videos.filter((v) => !known.has(v.videoId) && (!newest || (v.publishedAt ?? "") > newest));
    // A brand-new subscription reads its latest few, not the whole feed
    if (!known.size) fresh = fresh.slice(0, opts.backfill ?? BACKFILL);
    // Shorts and very short clips teach little: kept off by title (the transcript step skips what's too thin)
    const queued = await queueVideos(admin, fresh.map((v) => ({ ...v, channelTitle: v.channelTitle ?? feed.title ?? (s.title as string | null) })), { sourceId: id, by: (s.added_by as string | null) ?? null });
    const { count } = await admin.from("youtube_videos").select("id", { count: "exact", head: true }).eq("source_id", id);
    await admin.from("youtube_sources").update({ last_checked_at: now, error: null, video_count: count ?? 0, ...(feed.title && !s.title ? { title: feed.title.slice(0, 200) } : {}) }).eq("id", id);
    return { queued, error: null as string | null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("youtube_sources").update({ last_checked_at: now, error: error.slice(0, 300) }).eq("id", id);
    return { queued: 0, error };
  }
}

/** Channels not checked for a few hours: read again, oldest first, a handful a run */
export async function checkSources(admin: Admin, { budgetMs = 60_000, everyHours = 6 }: { budgetMs?: number; everyHours?: number } = {}) {
  const until = Date.now() + budgetMs;
  const { data } = await admin.from("youtube_sources").select("id, last_checked_at").eq("active", true).eq("kind", "channel").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(25);
  const due = (data ?? []).filter((s) => !s.last_checked_at || Date.now() - new Date(s.last_checked_at as string).getTime() > everyHours * 3_600_000);
  let checked = 0;
  let queued = 0;
  for (const s of due) {
    if (Date.now() > until) break;
    const r = await checkSource(admin, s.id as string);
    checked++;
    queued += r.queued;
  }
  return { checked, queued, due: due.length };
}

const SUGGEST = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "about"],
  properties: { lines: { type: "array", items: { type: "string", enum: [...YT_LINES] } }, about: { type: "string" } },
};

/** The lines a channel teaches, suggested by the AI from its name, description and latest titles (kept as the hint; lines filled when empty) */
export async function suggestLines(admin: Admin, id: string) {
  const { data: s } = await admin.from("youtube_sources").select("id, title, about, lines, channel_id").eq("id", id).single();
  if (!s) return null;
  const { data: vids } = await admin.from("youtube_videos").select("title").eq("source_id", id).order("published_at", { ascending: false }).limit(15);
  let titles = (vids ?? []).map((v) => v.title as string).filter(Boolean);
  if (!titles.length && s.channel_id) titles = (await latestUploads(s.channel_id as string).catch(() => ({ videos: [] as Upload[] }))).videos.map((v) => v.title);
  const out = await askJson<{ lines: string[]; about: string }>({
    agent: "market",
    label: "youtube lines",
    bare: true,
    schema: SUGGEST,
    override: { model: "haiku", effort: "low" },
    maxTokens: 800,
    system: `You sort a YouTube channel a marketing agency studies into the agency's lines it can teach. Lines: meta (paid social: Meta and TikTok ads, media buying, campaign structure, testing), google (Google and YouTube ads, search, Performance Max), creative (ad creative: hooks, images, video editing, UGC, copy for ads), email (email and SMS marketing, Klaviyo, flows), social (organic social: posting, content, community, growth). Pick every line it clearly teaches, usually one or two. about: one sentence on what the channel teaches, no people's names.`,
    prompt: `<channel>${s.title ?? "unknown"}</channel>\n<description>${(s.about ?? "").slice(0, 800)}</description>\n<latest_titles>\n${titles.slice(0, 15).join("\n")}\n</latest_titles>`,
  });
  const lines = cleanLines(out.lines);
  await admin
    .from("youtube_sources")
    .update({ suggested_lines: lines, ...(((s.lines as string[] | null) ?? []).length ? {} : { lines }), ...(out.about?.trim() && !s.about ? { about: out.about.trim().slice(0, 500) } : {}), updated_at: new Date().toISOString() })
    .eq("id", id);
  return lines;
}

// ─── Reading and distilling ─────────────────────────────────────────────────

type VideoRow = { id: string; video_id: string; url: string; source_id: string | null; title: string | null; channel_title: string | null; description: string | null; transcript: string | null; attempts: number; created_at: string; published_at: string | null; on_demand: boolean };

const DISTILL = {
  type: "object",
  additionalProperties: false,
  required: ["worth_it", "summary", "takeaways"],
  properties: {
    worth_it: { type: "boolean" },
    summary: { type: "string" },
    takeaways: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["takeaway", "why", "lines", "roles", "at"],
        properties: {
          takeaway: { type: "string" },
          why: { type: "string" },
          lines: { type: "array", items: { type: "string", enum: [...YT_LINES] } },
          roles: { type: "array", items: { type: "string", enum: [...YT_ROLES] } },
          at: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You study a marketing video for Kaizen, a performance marketing agency (paid social on Meta and TikTok, Google ads, ad creative, email marketing, organic social), and pull out what its team and AI agents should learn from it.

Return:
- worth_it: false when the video teaches nothing a marketer could act on (a vlog, a sponsor read, news with no method, an intro). Then takeaways is empty.
- summary: two or three sentences on what the video argues and how, attributed to the creator ("<channel> argues…").
- takeaways: the concrete, actionable methods, strategies, frameworks or findings (at most 8, the strongest first). Each:
  - takeaway: one or two sentences, specific enough to act on (numbers, structures, thresholds, sequences as the creator gives them). Attributed: say it's the creator's view or finding ("Per <channel>: …" or "<channel> finds…"), never present an opinion as settled fact. No people's names other than the channel's.
  - why: one line on why it matters or what it beats.
  - lines: the lines it applies to: meta (Meta and TikTok ads, media buying), google (Google and YouTube ads), creative (ad creative: images, video, hooks, copy), email, social (organic social).
  - roles: the team roles it matters to, from the list: the line's head and its day-to-day people (media_buyer, google_buyer, email_strategist, social_media_manager), and the craft roles only when it's about their craft: graphic_designer (static images), video_editor (video editing), copywriter (ad copy), email_designer (email design), email_builder (building in Klaviyo).
  - at: where in the video it's said, as the nearest [m:ss] mark from the transcript ("12:34"), or "" if unsure.
Skip generic advice every marketer knows ("test your creatives"), sponsor reads and calls to subscribe.`;

async function update(admin: Admin, id: string, patch: Record<string, unknown>) {
  await admin.from("youtube_videos").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/** The lines the video's source teaches (a pasted video with none: every line, so the AI decides) */
async function sourceLines(admin: Admin, sourceId: string | null): Promise<YtLine[]> {
  if (!sourceId) return [...YT_LINES];
  const { data } = await admin.from("youtube_sources").select("lines").eq("id", sourceId).maybeSingle();
  const l = cleanLines((data?.lines as string[] | null) ?? []);
  return l.length ? l : [...YT_LINES];
}

export type Distilled = { summary: string; takeaways: Takeaway[]; worthIt: boolean };

/** What one transcript teaches: the AI's summary and cleaned takeaways */
export async function distill(v: { title: string | null; channel: string | null; description: string | null; transcript: string; seconds?: number | null }, lines: YtLine[]): Promise<Distilled> {
  const out = await askJson<{ worth_it: boolean; summary: string; takeaways: unknown[] }>({
    agent: "market",
    label: "youtube takeaways",
    bare: true,
    schema: DISTILL,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 6000,
    system: SYSTEM,
    prompt: `<video channel="${(v.channel ?? "unknown").replace(/"/g, "'")}" title="${(v.title ?? "").replace(/"/g, "'")}">
<lines_this_channel_teaches>${lines.map((l) => YT_LINE_LABEL[l]).join(", ")}</lines_this_channel_teaches>
<description>${(v.description ?? "").slice(0, 1500)}</description>
<transcript>
${v.transcript.slice(0, TRANSCRIPT_CHARS)}
</transcript>
</video>`,
  });
  const takeaways = out.worth_it ? cleanTakeaways(out.takeaways, { fallbackLines: lines, durationSeconds: v.seconds ?? null }) : [];
  return { summary: String(out.summary ?? "").trim().slice(0, 1200), takeaways, worthIt: Boolean(out.worth_it) };
}

const NO_TRANSCRIPT = "YouTube didn't share this video's captions with the server. Paste its transcript (on YouTube: … › Show transcript) and it's read like the rest.";

/** One video: read, distilled, its takeaways saved (shared later, a person's day at a time) */
export async function processVideo(admin: Admin, row: VideoRow) {
  try {
    const page = row.transcript ? null : await readVideo(row.video_id);
    const transcript = row.transcript ?? page?.transcript ?? null;
    const about = { title: row.title ?? page?.title ?? null, channel_title: row.channel_title ?? page?.channel ?? null, description: row.description ?? page?.description ?? null, published_at: row.published_at ?? page?.publishedAt ?? null };
    if (!transcript) {
      // A brand-new upload may not have its captions yet: look again later, a few times
      const fresh = Date.now() - new Date(row.created_at).getTime() < DAY;
      if (fresh && row.attempts < 4) return update(admin, row.id, { ...about, status: "queued", next_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), error: "Waiting for captions" });
      return update(admin, row.id, { ...about, status: page?.found === false ? "failed" : "no_transcript", error: page?.found === false ? "YouTube didn't show this video (private, removed or age-restricted)." : NO_TRANSCRIPT });
    }
    if (transcript.length < 400) return update(admin, row.id, { ...about, transcript, status: "skipped", error: "Too short to teach anything (a Short or a clip)." });
    const lines = await sourceLines(admin, row.source_id);
    const d = await distill({ title: about.title, channel: about.channel_title, description: about.description, transcript, seconds: page?.seconds ?? null }, lines);
    await admin.from("youtube_takeaways").delete().eq("video_row", row.id).eq("status", "pending");
    if (d.takeaways.length)
      await admin.from("youtube_takeaways").insert(d.takeaways.map((t) => ({ video_row: row.id, takeaway: t.takeaway, why: t.why || null, lines: t.lines, roles: t.roles, at_seconds: t.atSeconds })));
    await update(admin, row.id, { ...about, transcript, summary: d.summary || null, status: d.worthIt && d.takeaways.length ? "done" : "skipped", error: d.worthIt ? null : "Nothing a marketer could act on.", shared_at: d.takeaways.length ? null : new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (row.attempts < 4) return update(admin, row.id, { status: "queued", next_at: new Date(Date.now() + 15 * 60_000 * row.attempts).toISOString(), error: msg.slice(0, 300) });
    await update(admin, row.id, { status: "failed", error: `Couldn't read it: ${msg}`.slice(0, 400) });
  }
}

/** The worker: claims due videos a few at a time until the budget runs out (a long queue goes through over several runs) */
export async function processYouTubeQueue(admin: Admin, { budgetMs = 300_000, parallel = 3 }: { budgetMs?: number; parallel?: number } = {}) {
  const until = Date.now() + budgetMs;
  let done = 0;
  // A distillation takes up to a couple of minutes: stop claiming while there's still time for one to finish
  while (Date.now() < until - 120_000) {
    const claimed: VideoRow[] = [];
    for (let i = 0; i < parallel; i++) {
      const { data } = await admin.rpc("claim_youtube_video");
      const r = (data as VideoRow[] | null)?.[0];
      if (!r) break;
      claimed.push(r);
    }
    if (!claimed.length) break;
    await Promise.all(claimed.map((r) => processVideo(admin, r)));
    done += claimed.length;
  }
  const { count } = await admin.from("youtube_videos").select("id", { count: "exact", head: true }).in("status", ["queued", "reading"]);
  return { done, left: count ?? 0 };
}

// ─── Sharing ────────────────────────────────────────────────────────────────

const nyDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const nyMidnight = (day: string) => new Date(`${day}T00:00:00-05:00`).toISOString();

type TakeawayRow = { id: string; video_row: string; takeaway: string; lines: string[]; roles: string[]; status: string; youtube_videos: { title: string | null; channel_title: string | null; shared_at: string | null; on_demand: boolean } | null };

/** The team, as the router reads them */
async function people(admin: Admin): Promise<Person[]> {
  const { data } = await admin.from("profiles").select("id, role, is_exec, exec_focus").eq("is_active", true).not("joined_at", "is", null);
  return (data ?? []).map((p) => ({ id: p.id as string, role: String(p.role ?? ""), isExec: Boolean(p.is_exec), execFocus: (p.exec_focus as string[] | null) ?? [] }));
}

/**
 * New takeaways out to everyone they involve, in the app: one notice per person per day (it grows as the day's videos
 * come in), the execs a digest of the lines in their focus. Never Slack: team work stays in the OS. Idempotent: the
 * day's notice is rebuilt from the day's shared takeaways each run.
 */
export async function shareTakeaways(admin: Admin) {
  const { data: fresh } = await admin.from("youtube_videos").select("id").eq("status", "done").eq("on_demand", false).is("shared_at", null).limit(50);
  if (!fresh?.length) return { shared: 0, told: 0 };
  const now = new Date().toISOString();
  await admin.from("youtube_videos").update({ shared_at: now }).in("id", fresh.map((v) => v.id));
  const day = nyDay();
  const told = await noticesFor(admin, day, new Set(fresh.map((v) => v.id as string)));
  return { shared: fresh.length, told };
}

/** The day's notices, rebuilt for everyone a newly shared video reaches */
async function noticesFor(admin: Admin, day: string, freshVideos: Set<string>) {
  const { data } = await admin
    .from("youtube_takeaways")
    .select("id, video_row, takeaway, lines, roles, status, youtube_videos!inner(title, channel_title, shared_at, on_demand)")
    .gte("youtube_videos.shared_at", nyMidnight(day))
    .eq("youtube_videos.on_demand", false)
    .neq("status", "dismissed")
    .limit(400);
  const rows = (data ?? []) as unknown as TakeawayRow[];
  if (!rows.length) return 0;
  const team = await people(admin);
  const byId = new Map(team.map((p) => [p.id, p]));
  const mine = new Map<string, { items: NoticeTakeaway[]; fresh: boolean; exec: boolean }>();
  for (const t of rows) {
    const lines = cleanLines(t.lines);
    const r = routeTakeaway({ lines, roles: t.roles ?? [] }, team);
    const item = (pid: string): NoticeTakeaway => ({ videoTitle: t.youtube_videos?.title ?? "A YouTube video", channel: t.youtube_videos?.channel_title ?? null, decide: t.status === "pending" && canDecide({ role: byId.get(pid)?.role, isExec: byId.get(pid)?.isExec }, lines) });
    for (const pid of [...r.team, ...r.execs]) {
      const m = mine.get(pid) ?? { items: [], fresh: false, exec: r.execs.includes(pid) };
      m.items.push(item(pid));
      if (freshVideos.has(t.video_row)) m.fresh = true;
      mine.set(pid, m);
    }
  }
  const upserts = [...mine.entries()]
    .filter(([, m]) => m.fresh)
    .map(([pid, m]) => {
      const { title, body } = noticeText(m.items, { digest: m.exec });
      // kind 'agent': about the agents' learning and this person's own work, so an exec's focus filter keeps it
      return { profile_id: pid, kind: "agent", key: `${m.exec ? "yt-digest" : "yt"}:${day}`, title, body, href: "/settings?tab=agents&section=youtube", priority: "normal", read_at: null, cleared_at: null };
    });
  for (let i = 0; i < upserts.length; i += 100) await admin.from("notifications").upsert(upserts.slice(i, i + 100), { onConflict: "profile_id,key" });
  return upserts.length;
}

// ─── Deciding ───────────────────────────────────────────────────────────────

type Me = { id: string; role: string; isExec: boolean };
export type DecideResult = { ok: true; learnings?: number; roleKey?: string; message?: string } | { ok: false; error: string };

async function takeawayFor(admin: Admin, id: string) {
  const { data } = await admin.from("youtube_takeaways").select("id, takeaway, why, lines, roles, status, at_seconds, video_row, youtube_videos(video_id, title, channel_title)").eq("id", id).maybeSingle();
  if (!data) return null;
  const v = data.youtube_videos as unknown as { video_id: string; title: string | null; channel_title: string | null } | null;
  return { ...data, lines: cleanLines(data.lines as string[]), roles: (data.roles as string[]) ?? [], video: v, link: v ? videoUrl(v.video_id, data.at_seconds as number | null) : "" };
}

const DECIDERS = "Only an executive or the head of this takeaway's line decides on it.";

/**
 * Accepted into the agents' learning: one learning per agent it teaches (filed to the role agent, read by every skill of
 * it), active at once (this is the approval), citing the video. Lessons for every client, never a client's own.
 */
export async function acceptTakeaway(admin: Admin, me: Me, id: string, edited?: string | null): Promise<DecideResult> {
  const t = await takeawayFor(admin, id);
  if (!t) return { ok: false, error: "That takeaway isn't there any more." };
  if (!canDecide(me, t.lines)) return { ok: false, error: DECIDERS };
  if (t.status === "accepted") return { ok: true, learnings: 0, message: "Already accepted." };
  const text = learningText({ takeaway: edited?.trim() || (t.takeaway as string), why: t.why as string | null }, { title: t.video?.title ?? null, channel: t.video?.channel_title ?? null, url: t.link });
  const roles = agentsForTakeaway({ lines: t.lines, roles: t.roles });
  if (!roles.length) return { ok: false, error: "It isn't tagged with a line, so no agent would learn it. Set its lines first." };
  const ids: string[] = [];
  for (const [i, role] of roles.entries()) {
    const { data, error } = await admin
      .from("agent_learnings")
      .insert({
        agent_key: `role:${role}`,
        source_table: "youtube_takeaways",
        // The source row is unique per learning: the first agent carries it, the others cite it in sources
        source_id: i === 0 ? id : null,
        scope: "everyone",
        proposed_scope: "everyone",
        kind: "lesson",
        lesson: text,
        confidence: 0.7,
        sources: [{ table: "youtube_takeaways", id, url: t.link }],
        classified_at: new Date().toISOString(),
        note: me.isExec ? "Accepted from YouTube by an exec" : "Accepted from YouTube by the head of its line",
        updated_by: me.id,
      })
      .select("id")
      .single();
    if (error && error.code !== "23505") return { ok: false, error: error.message };
    if (data?.id) ids.push(data.id as string);
  }
  await admin.from("youtube_takeaways").update({ status: "accepted", decided_by: me.id, decided_at: new Date().toISOString(), learning_ids: ids, ...(edited?.trim() ? { takeaway: edited.trim().slice(0, 500) } : {}) }).eq("id", id);
  return { ok: true, learnings: ids.length };
}

export async function dismissTakeaway(admin: Admin, me: Me, id: string): Promise<DecideResult> {
  const t = await takeawayFor(admin, id);
  if (!t) return { ok: false, error: "That takeaway isn't there any more." };
  if (!canDecide(me, t.lines)) return { ok: false, error: DECIDERS };
  await admin.from("youtube_takeaways").update({ status: "dismissed", decided_by: me.id, decided_at: new Date().toISOString() }).eq("id", id);
  return { ok: true };
}

/** The agent best placed to work a takeaway into its knowledge base or playbook, and the message that briefs it */
export async function callInBrief(admin: Admin, me: Me, id: string, roleKey?: string | null): Promise<{ ok: true; roleKey: string; message: string } | { ok: false; error: string }> {
  const t = await takeawayFor(admin, id);
  if (!t) return { ok: false, error: "That takeaway isn't there any more." };
  if (!canDecide(me, t.lines)) return { ok: false, error: DECIDERS };
  const agents = agentsForTakeaway({ lines: t.lines, roles: t.roles });
  const role = roleKey && agents.includes(roleKey) ? roleKey : agents[0];
  if (!role) return { ok: false, error: "It isn't tagged with a line, so there's no agent to call in." };
  const message = [
    `A takeaway from YouTube to work into what you know: ${t.video?.channel_title ?? "a channel we study"}, "${t.video?.title ?? "a video"}" (${t.link}).`,
    `Takeaway: ${t.takeaway}`,
    t.why ? `Why it matters: ${t.why}` : "",
    "Read it against your core and skills. If it adds something we don't already do, propose the exact edit where it belongs (a skill, a knowledge item or your core), worded as Kaizen's standard and crediting the source. If it contradicts how we work, say so and why, and propose nothing. Keep it to roles, never names.",
  ]
    .filter(Boolean)
    .join("\n\n");
  await admin.from("youtube_takeaways").update({ status: "called", called_role: role, decided_by: me.id, decided_at: new Date().toISOString() }).eq("id", id);
  return { ok: true, roleKey: role, message };
}

/** A transcript pasted by someone for a video YouTube wouldn't give one for: read like the rest */
export async function pasteTranscript(admin: Admin, id: string, text: string) {
  const transcript = text.replace(/\r/g, "").trim();
  if (transcript.length < 400) return { ok: false as const, error: "That's too short to be the transcript." };
  await update(admin, id, { transcript: transcript.slice(0, 200_000), status: "queued", next_at: new Date().toISOString(), attempts: 0, error: null });
  return { ok: true as const };
}

// ─── On demand ──────────────────────────────────────────────────────────────

/**
 * "Summarize this video": read and distilled now (kept, so asking again is instant). Not shared with the team: it's
 * for the person who asked, unless the video belongs to a channel we study.
 */
export async function summarizeVideo(admin: Admin, input: string, by: string | null) {
  const ref = parseYouTube(input);
  if (ref?.kind !== "video") return { ok: false as const, error: "That isn't a YouTube video link." };
  const { data: had } = await admin.from("youtube_videos").select("id, status, title, channel_title, summary, url").eq("video_id", ref.id).maybeSingle();
  if (had?.status === "done" || had?.status === "skipped") return { ok: true as const, ...(await videoView(admin, had.id as string)) };
  if (!had) await queueVideos(admin, [{ videoId: ref.id }], { onDemand: true, by });
  const { data: row } = await admin.from("youtube_videos").select("*").eq("video_id", ref.id).single();
  await admin.from("youtube_videos").update({ status: "reading", attempts: ((row?.attempts as number) ?? 0) + 1 }).eq("id", row!.id);
  await processVideo(admin, { ...(row as VideoRow), attempts: ((row?.attempts as number) ?? 0) + 1 });
  const v = await videoView(admin, row!.id as string);
  if (v.status !== "done" && v.status !== "skipped") return { ok: false as const, error: v.error ?? "Couldn't read it.", video: v };
  return { ok: true as const, ...v };
}

async function videoView(admin: Admin, id: string) {
  const { data: v } = await admin.from("youtube_videos").select("id, video_id, url, title, channel_title, summary, status, error").eq("id", id).single();
  const { data: t } = await admin.from("youtube_takeaways").select("id, takeaway, why, lines, roles, at_seconds, status").eq("video_row", id).order("created_at");
  return {
    id: v!.id as string,
    url: v!.url as string,
    title: (v!.title as string | null) ?? null,
    channel: (v!.channel_title as string | null) ?? null,
    summary: (v!.summary as string | null) ?? null,
    status: v!.status as string,
    error: (v!.error as string | null) ?? null,
    takeaways: (t ?? []).map((x) => ({ id: x.id as string, takeaway: x.takeaway as string, why: (x.why as string | null) ?? null, lines: x.lines as string[], link: videoUrl(v!.video_id as string, x.at_seconds as number | null), status: x.status as string })),
  };
}

/** What a channel (or every channel) said about a topic: its transcripts searched, the AI answering with citations */
export async function askChannels(admin: Admin, question: string, channel?: string | null) {
  let q = admin.from("youtube_videos").select("video_id, title, channel_title, summary, transcript, published_at").not("transcript", "is", null).order("published_at", { ascending: false }).limit(200);
  if (channel?.trim()) q = q.ilike("channel_title", `%${channel.trim().replace(/[%_]/g, "")}%`);
  const { data } = await q;
  const words = question.toLowerCase().match(/[a-z0-9:]{3,}/g) ?? [];
  const scored = (data ?? [])
    .map((v) => {
      const hay = `${v.title ?? ""} ${v.summary ?? ""} ${v.transcript ?? ""}`.toLowerCase();
      return { v, score: words.reduce((s, w) => s + (hay.split(w).length - 1), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  if (!scored.length) return { ok: true as const, answer: channel ? `Nothing in what we've read from ${channel} mentions that yet.` : "Nothing in the videos we've read mentions that yet.", videos: [] };
  // The passages around the question's words, not whole transcripts
  const excerpt = (t: string) => {
    const lower = t.toLowerCase();
    const hits = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b).slice(0, 4);
    return hits.map((i) => t.slice(Math.max(0, i - 1200), i + 1800)).join("\n…\n").slice(0, 9000);
  };
  const out = await askJson<{ answer: string }>({
    agent: "market",
    label: "youtube ask",
    bare: true,
    schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
    override: { model: "sonnet", effort: "low" },
    maxTokens: 2000,
    system: "You answer a question from the transcripts of marketing videos Kaizen studies. Use only what the excerpts say, attributed to the channel ('Per <channel>, …'), with the video's title and the [m:ss] mark where it's said. If they don't answer it, say so. Short: a few sentences or bullets.",
    prompt: `<question>${question}</question>\n${scored.map(({ v }) => `<video channel="${v.channel_title ?? ""}" title="${(v.title ?? "").replace(/"/g, "'")}" url="${videoUrl(v.video_id as string)}">\n${v.summary ?? ""}\n${excerpt(v.transcript as string)}\n</video>`).join("\n")}`,
  });
  return { ok: true as const, answer: out.answer, videos: scored.map(({ v }) => ({ title: v.title, channel: v.channel_title, url: videoUrl(v.video_id as string) })) };
}

// ─── The page ───────────────────────────────────────────────────────────────

export type SourceView = { id: string; kind: "channel" | "video"; url: string; title: string | null; handle: string | null; thumbnail: string | null; about: string | null; lines: YtLine[]; suggested: YtLine[]; active: boolean; lastChecked: string | null; error: string | null; videos: number; newVideos: number; takeaways: number; addedBy: string | null };
export type TakeawayView = { id: string; takeaway: string; why: string | null; lines: YtLine[]; roles: string[]; link: string; status: string; decidedBy: string | null; calledRole: string | null; mine: boolean; canDecide: boolean };
export type VideoView = { id: string; videoId: string; url: string; title: string | null; channel: string | null; thumbnail: string | null; publishedAt: string | null; summary: string | null; status: string; error: string | null; sourceId: string | null; onDemand: boolean; takeaways: TakeawayView[] };
export type YouTubePage = { sources: SourceView[]; videos: VideoView[]; waiting: number; forMe: number; canManage: boolean };

/** Everything the YouTube section shows, for this person (what's shared with them, what's theirs to decide) */
export async function loadYouTube(db: SupabaseClient, me: Me & { isLead?: boolean }): Promise<YouTubePage> {
  const { canManageSources } = await import("@/lib/youtube-core");
  const week = new Date(Date.now() - 7 * DAY).toISOString();
  const [{ data: src }, { data: vids }, { data: me2 }] = await Promise.all([
    db.from("youtube_sources").select("id, kind, url, title, handle, thumbnail_url, about, lines, suggested_lines, active, last_checked_at, error, video_count, profiles:added_by(full_name)").order("created_at", { ascending: false }),
    db.from("youtube_videos").select("id, video_id, url, title, channel_title, thumbnail_url, published_at, summary, status, error, source_id, on_demand, created_at, added_by").order("created_at", { ascending: false }).limit(120),
    db.from("profiles").select("exec_focus").eq("id", me.id).maybeSingle(),
  ]);
  const ids = (vids ?? []).map((v) => v.id as string);
  const { data: tk } = ids.length ? await db.from("youtube_takeaways").select("id, video_row, takeaway, why, lines, roles, at_seconds, status, called_role, profiles:decided_by(full_name)").in("video_row", ids).order("created_at") : { data: [] };
  const person: Person = { id: me.id, role: me.role, isExec: me.isExec, execFocus: (me2?.exec_focus as string[] | null) ?? [] };
  const byVideo = new Map<string, TakeawayView[]>();
  const videoIdOf = new Map((vids ?? []).map((v) => [v.id as string, v.video_id as string]));
  for (const t of tk ?? []) {
    const lines = cleanLines(t.lines as string[]);
    const r = routeTakeaway({ lines, roles: (t.roles as string[]) ?? [] }, [person]);
    const list = byVideo.get(t.video_row as string) ?? [];
    list.push({
      id: t.id as string,
      takeaway: t.takeaway as string,
      why: (t.why as string | null) ?? null,
      lines,
      roles: (t.roles as string[]) ?? [],
      link: videoUrl(videoIdOf.get(t.video_row as string) ?? "", t.at_seconds as number | null),
      status: t.status as string,
      decidedBy: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      calledRole: (t.called_role as string | null) ?? null,
      mine: r.team.length + r.execs.length > 0,
      canDecide: canDecide(me, lines),
    });
    byVideo.set(t.video_row as string, list);
  }
  // On-demand reads are the asker's own (and anyone deciding sees them all)
  const videos: VideoView[] = (vids ?? [])
    .filter((v) => !v.on_demand || v.added_by === me.id || me.isExec)
    .map((v) => ({
      id: v.id as string,
      videoId: v.video_id as string,
      url: v.url as string,
      title: (v.title as string | null) ?? null,
      channel: (v.channel_title as string | null) ?? null,
      thumbnail: (v.thumbnail_url as string | null) ?? null,
      publishedAt: (v.published_at as string | null) ?? null,
      summary: (v.summary as string | null) ?? null,
      status: v.status as string,
      error: (v.error as string | null) ?? null,
      sourceId: (v.source_id as string | null) ?? null,
      onDemand: Boolean(v.on_demand),
      takeaways: byVideo.get(v.id as string) ?? [],
    }));
  const sources: SourceView[] = (src ?? []).map((s) => {
    const mineV = (vids ?? []).filter((v) => v.source_id === s.id);
    return {
      id: s.id as string,
      kind: s.kind as "channel" | "video",
      url: s.url as string,
      title: (s.title as string | null) ?? (s.kind === "video" ? (mineV[0]?.title as string | null) ?? null : null),
      handle: (s.handle as string | null) ?? null,
      thumbnail: (s.thumbnail_url as string | null) ?? (mineV[0]?.thumbnail_url as string | null) ?? null,
      about: (s.about as string | null) ?? null,
      lines: cleanLines(s.lines as string[]),
      suggested: cleanLines(s.suggested_lines as string[]),
      active: Boolean(s.active),
      lastChecked: (s.last_checked_at as string | null) ?? null,
      error: (s.error as string | null) ?? null,
      videos: Math.max(Number(s.video_count) || 0, mineV.length),
      newVideos: mineV.filter((v) => (v.created_at as string) >= week).length,
      takeaways: mineV.reduce((n, v) => n + (byVideo.get(v.id as string)?.length ?? 0), 0),
      addedBy: (s.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    };
  });
  const all = videos.flatMap((v) => v.takeaways);
  return { sources, videos, waiting: all.filter((t) => t.status === "pending" && t.canDecide).length, forMe: all.filter((t) => t.mine && t.status !== "dismissed").length, canManage: canManageSources(me) };
}

/** For the day's recap: takeaways waiting for this person's call (a line head or exec) */
export async function youtubeWaiting(db: SupabaseClient, me: Me): Promise<number> {
  const { data } = await db.from("youtube_takeaways").select("lines").eq("status", "pending").limit(300);
  return (data ?? []).filter((t) => canDecide(me, cleanLines(t.lines as string[]))).length;
}
