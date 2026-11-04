import "server-only";
import { makeVoiceover } from "@/lib/ai-media-jobs";
import { messageOf } from "@/lib/connector-http";
import { elevenlabsConfigured, listVoices, subscription } from "@/lib/elevenlabs";
import { canGenerateMedia, clampVoiceSettings, MAX_VO_CHARS, VO_MODELS, voModelOf } from "@/lib/media-models";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, type AiTool } from "./types";

// ElevenLabs for the Kaizen AI chat: find a voice, read a voiceover (saved and logged like the panel's), and see
// what's left on the plan. Also usable as a library: src/lib/elevenlabs.ts and src/lib/ai-media-jobs.ts.

export * from "@/lib/elevenlabs";

const off = { ok: false as const, error: "ElevenLabs isn't connected yet. An exec needs to add ELEVENLABS_API_KEY in Vercel." };

export const tools: AiTool[] = [
  {
    name: "elevenlabs_list_voices",
    description: "Lists the ElevenLabs voices on Kaizen's account (name, id, gender, accent, age, use case, preview link). Use before making a voiceover to pick a voice that fits the ad.",
    input_schema: { type: "object", properties: { search: { type: "string", description: "Optional words to match in the voice's name or description" } }, additionalProperties: false },
    run: async (_user, input) => {
      if (!elevenlabsConfigured()) return off;
      try {
        const voices = await listVoices({ search: str(input.search) ?? undefined });
        return {
          ok: true,
          summary: `${voices.length} voices`,
          data: voices.slice(0, 60).map((v) => ({ id: v.id, name: v.name, category: v.category, ...v.labels, preview: v.previewUrl })),
        };
      } catch (e) {
        return { ok: false, error: messageOf(e) };
      }
    },
  },
  {
    name: "elevenlabs_voiceover",
    description: `Reads a voiceover script aloud in an ElevenLabs voice and saves the MP3 (on the ticket when a ticket is given). Spends ElevenLabs characters: confirm the script and voice with the person first. Up to ${MAX_VO_CHARS} characters.`,
    spends: true,
    input_schema: {
      type: "object",
      properties: {
        voice_id: { type: "string" },
        text: { type: "string", description: "The words to read, exactly" },
        model: { type: "string", enum: VO_MODELS.map((m) => m.id) },
        stability: { type: "number", minimum: 0, maximum: 1 },
        similarity_boost: { type: "number", minimum: 0, maximum: 1 },
        style: { type: "number", minimum: 0, maximum: 1 },
        speed: { type: "number", minimum: 0.7, maximum: 1.2 },
        request_id: { type: "string", description: "The ticket it's for (optional)" },
        client_id: { type: "string", description: "The client it's for (optional when a ticket is given)" },
      },
      required: ["voice_id", "text"],
      additionalProperties: false,
    },
    run: async (user, input) => {
      if (!canGenerateMedia(user)) return { ok: false, error: "Only the creative team, leads and execs can generate voiceovers." };
      if (!elevenlabsConfigured()) return off;
      const db = await createClient();
      let clientId = str(input.client_id);
      const requestId = str(input.request_id);
      if (requestId) {
        const { data } = await db.from("board_requests").select("client_id").eq("id", requestId).maybeSingle();
        if (!data) return { ok: false, error: "Ticket not found." };
        clientId = data.client_id as string;
      } else if (clientId) {
        const { data } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
        if (!data) return { ok: false, error: "Client not found." };
      }
      const r = await makeVoiceover(createAdminClient(), user, {
        voiceId: String(input.voice_id ?? ""),
        text: String(input.text ?? ""),
        model: voModelOf(input.model),
        settings: clampVoiceSettings({ stability: input.stability, similarityBoost: input.similarity_boost, style: input.style, speed: input.speed }),
        clientId,
        requestId,
        attach: Boolean(requestId),
      });
      return r.ok ? { ok: true, summary: "Voiceover made", data: { job_id: r.id } } : { ok: false, error: r.error };
    },
  },
  {
    name: "elevenlabs_quota",
    description: "How many ElevenLabs characters are left this month, and when the count resets.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      if (!elevenlabsConfigured()) return off;
      try {
        const q = await subscription();
        return { ok: true, summary: `${q.left.toLocaleString("en-US")} characters left`, data: q };
      } catch (e) {
        return { ok: false, error: messageOf(e) };
      }
    },
  },
];
