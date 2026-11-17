import { after } from "next/server";
import { openCall, runCallTurn } from "@/lib/agent-call/server";
import { runAssistantTurn } from "@/lib/assistant/turn";
import type { CallEvent } from "@/lib/agent-call/core";
import { parseCallContext } from "@/lib/agent-call/call-context";
import { longTurnText } from "@/lib/agent-call/history";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// One turn of a voice call with an agent: what the person said in, the agent's answer out as it's written (one JSON
// event per line), then anything it learned. Talking over the agent aborts the request, which stops the model; what it
// said so far is kept, and what it learned is still saved (finished after the response, see after()).
// The assistant may keep checking on a report it started for a few minutes after the answer (after())
export const maxDuration = 300;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  // With the turn: where they called from (a client, a report, a Kaizen AI thread) and, on a look, the screenshot
  const body = (await request.json().catch(() => null)) as { callId?: unknown; text?: unknown; context?: unknown; frame?: unknown } | null;
  const admin = createAdminClient();
  const call = await openCall(admin, me, body?.callId);
  // The person's own session: the tools read what they may see (taken here, while the request is still open)
  const db = await createClient();
  if (!call) return Response.json({ error: "This call has ended." }, { status: 410 });
  // A long monologue (two to five minutes is a few thousand words) is taken whole; only a truly huge one is cut
  const text = longTurnText(String(body?.text ?? ""));
  const context = parseCallContext(body?.context);
  const frame = typeof body?.frame === "string" ? body.frame.slice(0, 300) : null;
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
      // A line every few seconds while the answer is being worked out (tools, a long think), so nothing in between
      // closes a quiet stream and the call knows it's still working
      const ping = setInterval(() => emit({ t: "ping" }), 5000);
      const work = (call.role_key === "assistant" ? runAssistantTurn : runCallTurn)({ me, admin, db, call, text, signal: request.signal, emit, context, frame, startedAt })
        .catch((e) => {
          console.error("[agent call] turn", e instanceof Error ? e.message : e);
          emit({ t: "error", message: "Sorry, something went wrong on my side. Say that again?" });
        })
        .finally(() => {
          clearInterval(ping);
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
