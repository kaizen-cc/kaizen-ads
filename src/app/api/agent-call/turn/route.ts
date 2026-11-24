import { after } from "next/server";
import { openCall, runCallTurn } from "@/lib/agent-call/server";
import { runAssistantTurn } from "@/lib/assistant/turn";
import type { CallEvent } from "@/lib/agent-call/core";
import { parseCallContext } from "@/lib/agent-call/call-context";
import { talkModeOf } from "@/lib/agent-call/modality";
import { PASTE_CHARS } from "@/lib/assistant/long-text";
import { callTimer } from "@/lib/agent-call/timing";
import { isRepeatTurn, repeatKey, REPEAT_WINDOW_MS, supersededLines } from "@/lib/agent-call/transcript";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// One turn of a conversation with an agent (a voice call or a typed chat, the same pipeline): what the person said in, the agent's answer out as it's written (one JSON
// event per line), then anything it learned. Talking over the agent aborts the request, which stops the model; what it
// said so far is kept, and what it learned is still saved (finished after the response, see after()).
// The assistant may keep checking on a report it started for a few minutes after the answer (after())
export const maxDuration = 300;

/** The most a single message keeps (four times what the model reads whole: read_pasted_text pages through it) */
const STORED_CHARS = PASTE_CHARS * 4;

/** The last words each call sent (this server's memory, best effort; the call's chat covers another instance) */
const LAST_SAID = new Map<string, { text: string; at: number }>();

/** The person's last line on the call, from its chat (when it reached a different server instance) */
async function lastSaid(admin: ReturnType<typeof createAdminClient>, callId: unknown): Promise<{ text: string; at: number } | null> {
  if (typeof callId !== "string" || !/^[0-9a-f-]{36}$/.test(callId)) return null;
  const mem = LAST_SAID.get(callId);
  if (mem) return mem;
  const { data } = await admin.from("ai_role_chats").select("content, created_at").eq("call_id", callId).eq("role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? { text: String(data.content ?? ""), at: Date.parse(String(data.created_at)) } : null;
}

/**
 * Claims this turn's words on the call, atomically: false when the very same words were claimed moments ago (a
 * transcript sent twice, a double send). The database checks and sets in one statement, so it holds across servers.
 */
async function claimTurn(admin: ReturnType<typeof createAdminClient>, callId: string, text: string, now: number): Promise<boolean> {
  const key = repeatKey(text);
  if (!key) return true;
  const cutoff = new Date(now - REPEAT_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("ai_role_calls")
    .update({ last_said_key: key, last_said_at: new Date(now).toISOString() })
    .eq("id", callId)
    .or(`last_said_key.is.null,last_said_key.neq.${key},last_said_at.lt.${cutoff}`)
    .select("id");
  // Before the migration (no such columns): this server's own check above is all there is
  if (error) return true;
  return (data ?? []).length > 0;
}

/** The person's earlier lines this turn replaces (a cut-off turn sent again in full), taken out of the transcript */
async function dropSuperseded(admin: ReturnType<typeof createAdminClient>, callId: string, text: string, saidAt: number) {
  const since = new Date(saidAt - REPEAT_WINDOW_MS * 2).toISOString();
  const { data } = await admin.from("ai_role_chats").select("id, content, created_at").eq("call_id", callId).eq("role", "user").gte("created_at", since).order("created_at");
  const ids = supersededLines((data ?? []).map((r) => ({ id: r.id as string, content: String(r.content ?? ""), at: Date.parse(r.created_at as string) })), text, saidAt);
  if (ids.length) await admin.from("ai_role_chats").delete().in("id", ids);
}

/** A turn that didn't go through can be said again right away: its claim is let go */
async function releaseTurn(admin: ReturnType<typeof createAdminClient>, callId: string, text: string) {
  const key = repeatKey(text);
  if (key) await admin.from("ai_role_calls").update({ last_said_key: null }).eq("id", callId).eq("last_said_key", key);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const timer = callTimer(startedAt);
  const me = await timer.time("auth", requireStaff());
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  // With the turn: where they called from (a client, a report, a Kaizen AI thread) and, on a look, the screenshot
  const body = (await request.json().catch(() => null)) as { callId?: unknown; text?: unknown; context?: unknown; frame?: unknown; path?: unknown; mode?: unknown } | null;
  const admin = createAdminClient();
  // The call, the person's own session (the tools read what they may see; taken here, while the request is still open)
  // and their last line, all at once
  const [call, db, last] = await Promise.all([timer.time("open", openCall(admin, me, body?.callId)), timer.time("session", createClient()), timer.time("last", lastSaid(admin, body?.callId).catch(() => null))]);
  if (!call) return Response.json({ error: "This call has ended." }, { status: 410 });
  // A long monologue or a pasted document is taken whole (up to STORED_CHARS, kept whole in the conversation); each
  // turn runner decides what the model reads (longTurnText: whole up to sixty thousand characters)
  const text = String(body?.text ?? "").trim().slice(0, STORED_CHARS);
  // The same words again moments later (the transcriber sent a turn twice, or a resend): answered once, not twice
  // Claimed on the call at the start (not after the answer): two copies in flight at once, on any server, answer once
  if (isRepeatTurn(text, last, startedAt) || !(await claimTurn(admin, call.id, text, startedAt))) {
    console.log(`[agent call timing] call=${call.id} role=${call.role_key} repeat dropped`);
    return new Response(`${JSON.stringify({ t: "done" })}\n`, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
  }

  const context = parseCallContext(body?.context);
  const frame = typeof body?.frame === "string" ? body.frame.slice(0, 300) : null;
  // The screen they're on right now (a path inside the app), for feedback filed from the call
  const path = typeof body?.path === "string" && body.path.startsWith("/") && !body.path.startsWith("//") ? body.path.slice(0, 500) : null;
  // A call or a chat: the same turn, written to be spoken or to be read (modality.ts)
  const mode = talkModeOf(body?.mode ?? call.mode);
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
      const work = (call.role_key === "assistant" ? runAssistantTurn : runCallTurn)({ me, admin, db, call, text, signal: request.signal, emit, context, frame, startedAt, path, timer, mode })
        .then(() => {
          // Answered: the same words again in a moment are a repeat (a turn that failed may be said again)
          if (request.signal.aborted) return;
          // One line per utterance: earlier saves of a cut-off turn this one finished are dropped from the transcript
          void dropSuperseded(admin, call.id, text, startedAt).catch(() => undefined);
          if (LAST_SAID.size > 500) LAST_SAID.clear();
          LAST_SAID.set(call.id, { text, at: startedAt });
        })
        .catch((e) => {
          console.error("[agent call] turn", e instanceof Error ? e.message : e);
          void releaseTurn(admin, call.id, text).catch(() => undefined);
          emit({ t: "error", message: "Sorry, something went wrong on my side. Say that again?" });
        })
        .finally(() => {
          clearInterval(ping);
          // Where the time went: one line in the logs, and to the call's debug overlay
          const line = timer.line(`call=${call.id.slice(0, 8)} role=${call.role_key} words=${text.split(/\s+/).length}`);
          console.log(`[agent call timing] ${line}`);
          emit({ t: "timing", line });
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
