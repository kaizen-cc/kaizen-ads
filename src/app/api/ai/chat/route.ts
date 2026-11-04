import { requireStaff } from "@/lib/auth";
import { isChatAgent } from "@/lib/kaizen-ai/agents";
import { runTurn } from "@/lib/kaizen-ai/chat";
import { kindOf, type Attachment } from "@/lib/kaizen-ai/types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Kaizen AI's chat, as a streaming request (not a server action, which can't stream and runs one at a time): the
// answer comes back as it's written, one JSON event per line (the thread, who answers, text, tool status, cards, done).
// Stopping in the browser aborts the request, which stops the model; what was written so far is kept.
export const maxDuration = 300;

type Body = {
  threadId?: string | null;
  text?: string;
  attachments?: Attachment[];
  model?: string;
  agent?: string | null;
  clientId?: string | null;
  mode?: "send" | "regenerate" | "edit";
};

export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return Response.json({ error: "Nothing to send." }, { status: 400 });
  const db = await createClient();
  const admin = createAdminClient();
  // Only files in the person's own folder, of a kind we read, with what the browser captured for videos
  const attachments: Attachment[] = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10).flatMap((a) => {
    const kind = kindOf(String(a.mime ?? ""), String(a.name ?? ""));
    if (!kind || typeof a.path !== "string" || !a.path.startsWith(`${me.id}/`)) return [];
    const frames = (Array.isArray(a.frames) ? a.frames : []).filter((f) => typeof f?.path === "string" && f.path.startsWith(`${me.id}/`)).slice(0, 400).map((f) => ({ ms: Number(f.ms) || 0, path: f.path }));
    const audio = typeof a.audio === "string" && a.audio.startsWith(`${me.id}/`) ? a.audio : null;
    return [{ path: a.path, name: String(a.name).slice(0, 200), mime: String(a.mime ?? ""), bytes: Number(a.bytes) || 0, kind, ...(kind === "video" ? { frames, audio } : {}) }];
  });
  const mode = body.mode === "regenerate" || body.mode === "edit" ? body.mode : "send";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (e: object) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runTurn({
          me,
          db,
          admin,
          threadId: typeof body.threadId === "string" ? body.threadId : null,
          text: String(body.text ?? "").slice(0, 60_000),
          attachments,
          model: body.model === "sonnet" ? "sonnet" : body.model === "opus" ? "opus" : null,
          agent: body.agent === undefined ? undefined : isChatAgent(body.agent) ? body.agent : null,
          clientId: body.clientId === undefined ? undefined : typeof body.clientId === "string" && /^[0-9a-f-]{36}$/.test(body.clientId) ? body.clientId : null,
          mode,
          signal: request.signal,
          emit,
        });
      } catch (e) {
        console.error("[kaizen ai] turn", e instanceof Error ? e.message : e);
        emit({ t: "error", message: "Something went wrong. Try again." });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed (the person stopped it)
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
