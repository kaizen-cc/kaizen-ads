import "server-only";
import { mediaFor, myMediaJobs, startGeneration, toJobs } from "@/lib/ai-media-jobs";
import { higgsfieldConfigured } from "@/lib/higgsfield";
import { canGenerateMedia, HF_MODELS } from "@/lib/media-models";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, type AiTool } from "./types";

// Higgsfield for the Kaizen AI chat: start an image or a video (it runs in the background and the person is told
// when it's ready, like the panel), and check on it. Also usable as a library: src/lib/higgsfield.ts and
// src/lib/ai-media-jobs.ts.

export * from "@/lib/higgsfield";

const off = { ok: false as const, error: "Higgsfield isn't connected yet. An exec needs to add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Vercel." };

const modelList = HF_MODELS.map((m) => `${m.key} (${m.kind}: ${m.about}; options ${m.fields.map((f) => `${f.key}${f.type === "enum" ? ` ${f.options.join("/")}` : f.type === "int" ? ` ${f.min}-${f.max}` : " true/false"}`).join(", ")})`).join("; ");

export const tools: AiTool[] = [
  {
    name: "higgsfield_generate",
    description: `Starts an AI image or video on Higgsfield from a prompt. It runs in the background (images about a minute, videos a few minutes); the person gets a toast and a bell notification when it's ready, and it's saved on the ticket when one is given. Spends Higgsfield credits: confirm the prompt and model first. Models: ${modelList}.`,
    spends: true,
    input_schema: {
      type: "object",
      properties: {
        model: { type: "string", enum: HF_MODELS.map((m) => m.key) },
        prompt: { type: "string" },
        options: { type: "object", description: "The model's options, e.g. {\"aspect_ratio\": \"9:16\", \"duration\": 5}" },
        request_id: { type: "string", description: "The ticket it's for (optional)" },
        client_id: { type: "string", description: "The client it's for (optional when a ticket is given)" },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
    run: async (user, input) => {
      if (!canGenerateMedia(user)) return { ok: false, error: "Only the creative team, leads and execs can generate images and videos." };
      if (!higgsfieldConfigured()) return off;
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
      const r = await startGeneration(createAdminClient(), user, {
        model: String(input.model ?? ""),
        prompt: String(input.prompt ?? ""),
        options: input.options && typeof input.options === "object" ? (input.options as Record<string, unknown>) : {},
        clientId,
        requestId,
      });
      return r.ok ? { ok: true, summary: "Started on Higgsfield; it'll say when it's ready", data: { job_id: r.id } } : r;
    },
  },
  {
    name: "higgsfield_jobs",
    description: "The person's Higgsfield images and videos still being made and the ones just finished (with links), or a ticket's AI media when a ticket is given.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, additionalProperties: false },
    run: async (user, input) => {
      const admin = createAdminClient();
      const requestId = str(input.request_id);
      if (requestId) {
        const { data } = await (await createClient()).from("board_requests").select("id").eq("id", requestId).maybeSingle();
        if (!data) return { ok: false, error: "Ticket not found." };
      }
      const list = requestId ? await mediaFor(admin, { requestId, kind: ["image", "video"] }, user.id) : await myMediaJobs(admin, user.id);
      return {
        ok: true,
        summary: `${list.length} jobs`,
        data: list.map((j) => ({ id: j.id, kind: j.kind, model: j.model, title: j.title, status: j.status, error: j.error, files: j.files.map((f) => f.url) })),
      };
    },
  },
  {
    name: "higgsfield_job",
    description: "One Higgsfield job by id: its status and, when ready, links to the files.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    run: async (user, input) => {
      const admin = createAdminClient();
      const { advance } = await import("@/lib/ai-media-jobs");
      const id = String(input.job_id ?? "");
      await advance(admin, id).catch(() => null);
      const { data } = await admin.from("ai_media_jobs").select("*").eq("id", id).maybeSingle();
      if (!data) return { ok: false, error: "Not found." };
      const [j] = await toJobs(admin, [data], user.id);
      return { ok: true, summary: j.status, data: { status: j.status, error: j.error, files: j.files.map((f) => f.url) } };
    },
  },
];
