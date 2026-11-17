import { after } from "next/server";
import { openCall, runCallTurn } from "@/lib/agent-call/server";
import type { CallEvent } from "@/lib/agent-call/core";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// One turn of a voice call with an agent: what the person said in, the agent's answer out as it's written (one JSON
// event per line), then anything it learned. Talking over the agent aborts the request, which stops the model; what it
// said so far is kept, and what it learned is still saved (finished after the response, see after()).
export const maxDuration = 120;

export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { callId?: unknown; text?: unknown } | null;
  const admin = createAdminClient();
  const call = await openCall(admin, me, body?.callId);
  // The person's own session: the tools read what they may see (taken here, while the request is still open)
  const db = await createClient();
  if (!call) return Response.json({ error: "This call has ended." }, { status: 410 });
  const text = String(body?.text ?? "").slice(0, 4000);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const emit = (e: CallEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      const work = runCallTurn({ me, admin, db, call, text, signal: request.signal, emit })
        .catch((e) => {
          console.error("[agent call] turn", e instanceof Error ? e.message : e);
          emit({ t: "error", message: "Sorry, something went wrong on my side. Say that again?" });
        })
        .finally(() => {
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed (the person talked over the agent)
          }
        });
      // Finished even when the browser stops listening, so the transcript and what was learned are always saved
      after(work);
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
