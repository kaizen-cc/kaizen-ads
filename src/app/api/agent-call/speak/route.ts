import { CALL_TTS_MODEL, speakable, voiceFor } from "@/lib/agent-call/core";
import { openCall } from "@/lib/agent-call/server";
import { requireStaff } from "@/lib/auth";
import { ConnectorError } from "@/lib/connector-http";
import { elevenlabsConfigured, speechStream } from "@/lib/elevenlabs";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// One sentence of a call spoken in the agent's voice: ElevenLabs' low-latency model, streamed straight back to the
// browser as MP3. The key stays here; the characters it cost are added to the call.
export const maxDuration = 60;

export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  if (!elevenlabsConfigured()) return Response.json({ error: "ElevenLabs isn't connected." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { callId?: unknown; text?: unknown } | null;
  const admin = createAdminClient();
  const call = await openCall(admin, me, body?.callId);
  if (!call) return Response.json({ error: "This call has ended." }, { status: 410 });
  const text = speakable(String(body?.text ?? "")).slice(0, 600);
  if (!text) return new Response(null, { status: 204 });
  try {
    const speech = await speechStream({ voiceId: voiceFor(call.role_key, call.voice_id), text, model: CALL_TTS_MODEL, signal: request.signal });
    void admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: speech.characters }).then(({ error }) => error && console.error("[agent call] characters", error.message));
    return new Response(speech.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("[agent call] speak", e instanceof Error ? e.message : e);
    return Response.json({ error: e instanceof ConnectorError ? e.message : "Couldn't speak that." }, { status: 502 });
  }
}
