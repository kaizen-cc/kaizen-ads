import "server-only";
import { ConnectorError, fetchJson, friendlyStatus, detailOf, timedFetch } from "@/lib/connector-http";
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

export type Voice = {
  id: string;
  name: string;
  category: string; // premade, cloned, generated, professional
  previewUrl: string | null;
  labels: Record<string, string>; // accent, age, gender, use case, description
  description: string | null;
};

type RawVoice = { voice_id: string; name: string; category?: string; preview_url?: string | null; labels?: Record<string, string> | null; description?: string | null };

const toVoice = (v: RawVoice): Voice => ({
  id: v.voice_id,
  name: v.name,
  category: v.category ?? "premade",
  previewUrl: v.preview_url ?? null,
  labels: v.labels ?? {},
  description: v.description ?? null,
});

// The account's voices change rarely: kept for 10 minutes per server instance
let voiceCache: { at: number; voices: Voice[] } | null = null;

/** Every voice on the account (its own clones first, then the library voices it added), up to 300 */
export async function listVoices(opts: { search?: string; fresh?: boolean } = {}): Promise<Voice[]> {
  if (!opts.search && !opts.fresh && voiceCache && Date.now() - voiceCache.at < 600_000) return voiceCache.voices;
  const out: Voice[] = [];
  let token: string | null = null;
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (opts.search) q.set("search", opts.search);
    if (token) q.set("next_page_token", token);
    const r: { voices?: RawVoice[]; has_more?: boolean; next_page_token?: string | null } = await fetchJson(NAME, `${BASE}/v2/voices?${q}`, { headers: { "xi-api-key": key() } }, 20_000);
    out.push(...(r.voices ?? []).map(toVoice));
    if (!r.has_more || !r.next_page_token) break;
    token = r.next_page_token;
  }
  const rank = (v: Voice) => (v.category === "cloned" || v.category === "professional" ? 0 : v.category === "generated" ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!opts.search) voiceCache = { at: Date.now(), voices: out };
  return out;
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
