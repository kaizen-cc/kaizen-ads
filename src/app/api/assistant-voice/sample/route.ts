import { requireStaff } from "@/lib/auth";
import { isVoiceId } from "@/lib/agent-call/core";
import { ConnectorError } from "@/lib/connector-http";
import { elevenlabsConfigured, textToSpeech } from "@/lib/elevenlabs";
import { SAMPLE_LINE } from "@/lib/voices";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A short sample of a voice, for the play button beside it on the assistant's settings, when ElevenLabs has no
// sample of its own for the voice. Made once per voice and kept in storage, so it costs once however many people
// listen. Staff only (the same people who can pick a voice).
export const maxDuration = 30;

const BUCKET = "voice-samples";
// A new line means new samples: the file is named by the line it says
const lineKey = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36);

const audio = (body: BodyInit) => new Response(body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });

export async function GET(request: Request) {
  await requireStaff();
  const voice = new URL(request.url).searchParams.get("voice");
  if (!isVoiceId(voice)) return Response.json({ error: "Pick a voice." }, { status: 400 });
  if (!adminConfigured() || !elevenlabsConfigured()) return Response.json({ error: "ElevenLabs isn't connected." }, { status: 503 });
  const admin = createAdminClient();
  const path = `${voice}-${lineKey(SAMPLE_LINE)}.mp3`;
  const kept = await admin.storage.from(BUCKET).download(path);
  if (kept.data) return audio(await kept.data.arrayBuffer());
  try {
    const speech = await textToSpeech({ voiceId: voice, text: SAMPLE_LINE });
    // Kept for the next listener; a failed save still plays this one
    await admin.storage.from(BUCKET).upload(path, speech.audio, { contentType: "audio/mpeg", upsert: true });
    return audio(new Uint8Array(speech.audio));
  } catch (e) {
    return Response.json({ error: e instanceof ConnectorError ? e.message : "Couldn't make the sample." }, { status: 502 });
  }
}
