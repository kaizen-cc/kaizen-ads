import { CALL_TTS_MODEL, speakable, voiceFor } from "@/lib/agent-call/core";
import { forSpeech } from "@/lib/agent-call/speech-text";
import { openCall, type CallRow } from "@/lib/agent-call/server";
import { callTimer } from "@/lib/agent-call/timing";
import { specialistOf } from "@/lib/assistant/core";
import { requireStaff } from "@/lib/auth";
import { ConnectorError } from "@/lib/connector-http";
import { elevenlabsConfigured, speechStream } from "@/lib/elevenlabs";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// One sentence of a call spoken in the agent's voice: ElevenLabs' low-latency model, streamed straight back to the
// browser as MP3. The key stays here; the characters it cost are added to the call. The sentence is put into spoken
// words first (money, dates, short forms; links never read out), with the sentence before it for a smooth flow. On
// an assistant call the assistant speaks in the voice its person picked (set on the call when it starts); every agent
// brought onto a call speaks in its own.
export const maxDuration = 60;

/**
 * A call checked open a moment ago, and each agent's voice, kept briefly per server instance: every sentence of an
 * answer is its own request, and each used to read the call (and, for a specialist, its voice) again before the voice
 * could start.
 */
const OPEN = new Map<string, { at: number; call: CallRow }>();
const OPEN_TTL_MS = 20_000;
const VOICES = new Map<string, { at: number; id: string | null }>();
const VOICE_TTL_MS = 300_000;

export async function POST(request: Request) {
  const timer = callTimer();
  const me = await timer.time("auth", requireStaff());
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  if (!elevenlabsConfigured()) return Response.json({ error: "ElevenLabs isn't connected." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { callId?: unknown; text?: unknown; role?: unknown; previous?: unknown } | null;
  const admin = createAdminClient();
  const key = `${me.id}:${String(body?.callId ?? "")}`;
  const kept = OPEN.get(key);
  const call = kept && Date.now() - kept.at < OPEN_TTL_MS ? kept.call : await timer.time("open", openCall(admin, me, body?.callId));
  if (!call) return Response.json({ error: "This call has ended." }, { status: 410 });
  if (OPEN.size > 500) OPEN.clear();
  if (!kept || Date.now() - kept.at >= OPEN_TTL_MS) OPEN.set(key, { at: Date.now(), call });
  const text = forSpeech(speakable(String(body?.text ?? "").slice(0, 600))).slice(0, 900);
  const previous = typeof body?.previous === "string" ? forSpeech(speakable(body.previous.slice(0, 600))) : null;
  if (!text) return new Response(null, { status: 204 });
  try {
    // A specialist brought onto the call (by the assistant, or by the agent called directly) speaks in its own voice
    const role = typeof body?.role === "string" ? body.role : call.role_key;
    let voiceId = voiceFor(call.role_key, call.voice_id);
    if (role !== call.role_key && specialistOf(role)) {
      const v = VOICES.get(role);
      let picked = v && Date.now() - v.at < VOICE_TTL_MS ? v.id : undefined;
      if (picked === undefined) {
        const { data: r } = await timer.time("voice", Promise.resolve(admin.from("ai_roles").select("voice_id").eq("key", role).maybeSingle()));
        picked = (r?.voice_id as string | null) ?? null;
        VOICES.set(role, { at: Date.now(), id: picked });
      }
      voiceId = voiceFor(role, picked);
    }
    const model = process.env.ELEVENLABS_CALL_MODEL || CALL_TTS_MODEL;
    // Time to ElevenLabs' first byte (its response starts as the audio does)
    const speech = await timer.time("tts_first_byte", speechStream({ voiceId, text, previous, model, signal: request.signal }));
    const line = timer.line(`call=${call.id.slice(0, 8)} role=${role} model=${model} chars=${text.length}`);
    console.log(`[agent call timing] speak ${line}`);
    void admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: speech.characters }).then(({ error }) => error && console.error("[agent call] characters", error.message));
    return new Response(speech.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-call-timing": line } });
  } catch (e) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("[agent call] speak", e instanceof Error ? e.message : e);
    return Response.json({ error: e instanceof ConnectorError ? e.message : "Couldn't speak that." }, { status: 502 });
  }
}
