import "server-only";
import { JWT } from "google-auth-library";
import { googleConfigured } from "@/lib/context/google";

// A video's audio as words with timings, for the AI review (voiceover, spoken claims, what the music covers). The
// browser sends 16 kHz mono WAV; Google Speech-to-Text reads it with the Workspace service account (the Speech-to-Text
// API must be on in that Google Cloud project).

export type Line = { ms: number; endMs: number; text: string };

const secs = (s: string | undefined) => Math.round(parseFloat(String(s ?? "0").replace("s", "")) * 1000) || 0;

async function token() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  const t = await new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getAccessToken();
  return t.token!;
}

type Word = { startTime?: string; endTime?: string; word: string };
type Result = { alternatives?: { transcript?: string; words?: Word[] }[] };

/** The words in a WAV, grouped into lines of a few seconds. Empty when nothing is said. */
export async function transcribe(wav: Buffer): Promise<Line[]> {
  if (!googleConfigured()) throw new Error("Google isn't connected");
  if (wav.byteLength > 10_000_000) throw new Error("The audio is too long to transcribe (over about 5 minutes)");
  const auth = { authorization: `Bearer ${await token()}`, "content-type": "application/json" };
  const start = await fetch("https://speech.googleapis.com/v1/speech:longrunningrecognize", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      config: { encoding: "LINEAR16", sampleRateHertz: 16000, audioChannelCount: 1, languageCode: "en-US", enableWordTimeOffsets: true, enableAutomaticPunctuation: true, model: "video", useEnhanced: true },
      audio: { content: wav.toString("base64") },
    }),
  });
  const op = (await start.json()) as { name?: string; error?: { message: string } };
  if (!start.ok || !op.name) throw new Error(op.error?.message?.includes("has not been used") || op.error?.message?.includes("disabled") ? "Turn on the Speech-to-Text API in the Google Cloud project of the service account" : (op.error?.message ?? `Speech-to-Text ${start.status}`));
  // Ads are short: a few seconds; give it up to two minutes
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
    const res = await fetch(`https://speech.googleapis.com/v1/operations/${op.name}`, { headers: auth });
    const body = (await res.json()) as { done?: boolean; error?: { message: string }; response?: { results?: Result[] } };
    if (body.error) throw new Error(body.error.message);
    if (!body.done) continue;
    const words = (body.response?.results ?? []).flatMap((r) => r.alternatives?.[0]?.words ?? []);
    const lines: Line[] = [];
    for (const w of words) {
      const ms = secs(w.startTime);
      const end = secs(w.endTime);
      const last = lines[lines.length - 1];
      // A new line after a pause or every ~4 seconds, so a note can point at a moment
      if (!last || ms - last.endMs > 700 || ms - last.ms > 4000) lines.push({ ms, endMs: end, text: w.word });
      else {
        last.text += ` ${w.word}`;
        last.endMs = end;
      }
    }
    return lines;
  }
  throw new Error("Speech-to-Text took too long");
}
