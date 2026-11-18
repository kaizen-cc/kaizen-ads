import "server-only";
import { ConnectorError, fetchJson, friendlyStatus, detailOf, timedFetch } from "@/lib/connector-http";
import { mergeVoices, parseVoices, type Voice } from "@/lib/voices";
import { clampVoiceSettings, voModelOf, type VoiceSettings, type VoModel } from "@/lib/media-models";

// ElevenLabs over its REST API (https://elevenlabs.io/docs/api-reference): voices, text to speech and what's left
// on the plan. The key is ELEVENLABS_API_KEY in Vercel; it only goes in the xi-api-key header.

const BASE = "https://api.elevenlabs.io";
const NAME = "ElevenLabs";

export const elevenlabsConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

function key() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new ConnectorError("ElevenLabs isn't connected yet. An exec needs to add ELEVENLABS_API_KEY in Vercel.");
  return k;
}

export type { Voice };

// The account's voices change rarely: kept for 10 minutes per server instance
let voiceCache: { at: number; voices: Voice[] } | null = null;

type Page = { voices?: unknown; has_more?: boolean; next_page_token?: string | null };

/** One source of voices: the v2 list (every page, up to 300), optionally narrowed to a type of voice */
async function v2Voices(opts: { search?: string; type?: string }): Promise<Voice[]> {
  const out: Voice[] = [];
  let token: string | null = null;
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (opts.search) q.set("search", opts.search);
    if (opts.type) q.set("voice_type", opts.type);
    if (token) q.set("next_page_token", token);
    const r: Page = await fetchJson(NAME, `${BASE}/v2/voices?${q}`, { headers: { "xi-api-key": key() } }, 20_000);
    out.push(...parseVoices(r));
    if (!r.has_more || !r.next_page_token) break;
    token = r.next_page_token;
  }
  return out;
}

/**
 * Every voice the account can speak in. Why the list used to hold one voice: the v2 list with no filter only returns the
 * voices saved on the account (its own clones and what it added), and ElevenLabs' default voices only come back when
 * they're asked for as their own type (voice_type=default), so an account with a single clone listed that one. Now the
 * unfiltered list, the default voices and the older v1 list (which includes the premade voices) are read together and
 * merged; one source failing (a key without a permission) doesn't drop the others. The account's own voices come first.
 */
export async function listVoices(opts: { search?: string; fresh?: boolean } = {}): Promise<Voice[]> {
  if (!opts.search && !opts.fresh && voiceCache && Date.now() - voiceCache.at < 600_000) return voiceCache.voices;
  const sources = await Promise.allSettled([
    v2Voices({ search: opts.search }),
    v2Voices({ search: opts.search, type: "default" }),
    // The older list (every voice on the account, premade ones included), for when v2 answers thinly
    opts.search ? Promise.resolve([] as Voice[]) : fetchJson<unknown>(NAME, `${BASE}/v1/voices`, { headers: { "xi-api-key": key() } }, 20_000).then((r) => parseVoices(r)),
  ]);
  const lists = sources.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!lists.length) {
    const first = sources.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw first?.reason ?? new ConnectorError("Couldn't load the voices.");
  }
  const out = mergeVoices(lists);
  const rank = (v: Voice) => (v.category === "cloned" || v.category === "professional" ? 0 : v.category === "generated" ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!opts.search) voiceCache = { at: Date.now(), voices: out };
  return out;
}

/** A page of ElevenLabs' shared voice library (featured first): voices that can be added to the account and spoken in */
export async function listLibraryVoices(opts: { search?: string } = {}): Promise<Voice[]> {
  const q = new URLSearchParams({ page_size: "60", sort: "trending" });
  if (opts.search) q.set("search", opts.search);
  else q.set("featured", "true");
  const r = await fetchJson<unknown>(NAME, `${BASE}/v1/shared-voices?${q}`, { headers: { "xi-api-key": key() } }, 20_000);
  return parseVoices(r, "library").filter((v) => v.ownerId);
}

/** Puts a library voice on the account (its id stays the same), so it can speak. Needs a plan that allows library voices. */
export async function addLibraryVoice(ownerId: string, voiceId: string, name: string): Promise<void> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(ownerId) || !/^[A-Za-z0-9]{8,40}$/.test(voiceId)) throw new ConnectorError("Pick a voice.");
  await fetchJson(NAME, `${BASE}/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, { method: "POST", headers: { "xi-api-key": key(), "content-type": "application/json" }, body: JSON.stringify({ new_name: name.slice(0, 60) }) }, 20_000);
  voiceCache = null;
}

export type Speech = { audio: Buffer; mime: "audio/mpeg"; characters: number; requestId: string | null };

/** Reads the text in the voice: an MP3 (44.1kHz, 128kbps). Up to 2 minutes for long reads. */
export async function textToSpeech(input: { voiceId: string; text: string; model?: VoModel; settings?: Partial<VoiceSettings> }): Promise<Speech> {
  const s = clampVoiceSettings(input.settings);
  const model = voModelOf(input.model);
  if (!/^[A-Za-z0-9]{8,40}$/.test(input.voiceId)) throw new ConnectorError("Pick a voice.");
  const res = await timedFetch(
    NAME,
    `${BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key(), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: input.text,
        model_id: model,
        voice_settings: { stability: s.stability, similarity_boost: s.similarityBoost, style: s.style, use_speaker_boost: s.speakerBoost, speed: s.speed },
      }),
    },
    120_000,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectorError(friendlyStatus(NAME, res.status, detailOf(body)), res.status, res.status === 429 || res.status >= 500);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new ConnectorError("ElevenLabs sent back an empty file. Try again.", null, true);
  const used = Number(res.headers.get("character-cost") ?? res.headers.get("x-character-count") ?? NaN);
  return { audio, mime: "audio/mpeg", characters: Number.isFinite(used) ? used : input.text.length, requestId: res.headers.get("request-id") };
}

export type Quota = { tier: string; used: number; limit: number; left: number; resetsAt: string | null };

/** What's left on the plan this month */
export async function subscription(): Promise<Quota> {
  const r = await fetchJson<{ tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number | null }>(
    NAME,
    `${BASE}/v1/user/subscription`,
    { headers: { "xi-api-key": key() } },
    15_000,
  );
  const used = r.character_count ?? 0;
  const limit = r.character_limit ?? 0;
  return { tier: r.tier ?? "unknown", used, limit, left: Math.max(0, limit - used), resetsAt: r.next_character_count_reset_unix ? new Date(r.next_character_count_reset_unix * 1000).toISOString() : null };
}

/** For Settings › Connections: is the key there, does ElevenLabs take it, and what's left */
export async function elevenlabsStatus(): Promise<{ configured: boolean; reachable: boolean; quota: Quota | null; error: string | null }> {
  if (!elevenlabsConfigured()) return { configured: false, reachable: false, quota: null, error: null };
  try {
    return { configured: true, reachable: true, quota: await subscription(), error: null };
  } catch (e) {
    return { configured: true, reachable: false, quota: null, error: e instanceof ConnectorError ? e.message : "Couldn't reach ElevenLabs." };
  }
}

// ─── Voice calls with the agents ────────────────────────────────────────────

/**
 * How a call's voice is tuned (see speechStream). Stability 0.62: at 0.45 the same word came out differently from one
 * sentence to the next ("dollars" said three ways on one call); a little steadier keeps it consistent and still sounds
 * like a person, not a reader.
 */
export const CALL_VOICE_SETTINGS = { stability: 0.62, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 };

/**
 * A fixed seed per voice, so the same words in the same voice come out the same way every time (ElevenLabs takes a
 * whole number up to 4294967295; FNV-1a of the voice id).
 */
export function voiceSeed(voiceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < voiceId.length; i++) {
    h ^= voiceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The sentence before, as context for the next one's flow: whole words only (a cut mid-word was read as a strange
 * fragment), the last sentence or two, and nothing when it's too short to help.
 */
export function previousContext(previous: string | null | undefined, max = 300): string | null {
  const t = String(previous ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  let out = t;
  if (out.length > max) {
    const cut = out.slice(-max);
    // From the start of a sentence inside the window, else from the first whole word
    const sentence = cut.search(/[.!?]\s+[A-Z0-9"']/);
    out = sentence !== -1 ? cut.slice(sentence + 1).trim() : cut.slice(cut.indexOf(" ") + 1).trim();
  }
  return out.split(" ").length >= 3 ? out : null;
}

/**
 * A short sentence spoken for a call, streamed as it's made (MP3, 44.1kHz at 64kbps: small and quick to start). The
 * call's low-latency model; the body is passed straight on to the browser. Characters are what the text costs.
 */
export async function speechStream(input: { voiceId: string; text: string; model: string; previous?: string | null; signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; characters: number }> {
  if (!/^[A-Za-z0-9]{8,40}$/.test(input.voiceId)) throw new ConnectorError("Pick a voice.");
  const previous = previousContext(input.previous);
  const res = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key(), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: input.text,
      model_id: input.model,
      // Natural rather than flat: a little looser stability, a touch less similarity (it brings out artifacts), no
      // added style (slower, wobblier), speaker boost on, normal speed (faster sounded clipped)
      voice_settings: CALL_VOICE_SETTINGS,
      // The same words sound the same each time in this voice
      seed: voiceSeed(input.voiceId),
      // The text already comes in spoken words (forSpeech: money, numbers, dates, short forms), so the voice reads it
      // as written rather than guessing at it again (auto, on or off; see the text to speech API reference)
      apply_text_normalization: "off",
      // The sentence before, so sentences sent one by one keep their flow instead of each starting cold
      ...(previous ? { previous_text: previous } : {}),
    }),
    signal: input.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new ConnectorError(friendlyStatus(NAME, res.status, detailOf(body)), res.status, res.status === 429 || res.status >= 500);
  }
  const used = Number(res.headers.get("character-cost") ?? res.headers.get("x-character-count") ?? NaN);
  return { body: res.body, characters: Number.isFinite(used) ? used : input.text.length };
}

/**
 * A single-use token for ElevenLabs' realtime speech to text (Scribe), so the browser streams the microphone straight
 * to ElevenLabs without ever seeing the key. Good for one session, used within 15 minutes; the session lasts up to
 * `seconds`.
 */
export async function realtimeSttToken(seconds: number): Promise<string> {
  const r = await fetchJson<{ token?: string }>(
    NAME,
    `${BASE}/v1/single-use-token/realtime_scribe?max_session_duration_seconds=${Math.max(60, Math.round(seconds))}`,
    { method: "POST", headers: { "xi-api-key": key() } },
    10_000,
  );
  if (!r.token) throw new ConnectorError("ElevenLabs didn't send a speech token.");
  return r.token;
}
