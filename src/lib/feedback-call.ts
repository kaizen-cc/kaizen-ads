import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { buildTranscript, transcriptMarkdown, type TranscriptEntry } from "@/lib/chat-transcript";
import { FEEDBACK_BUCKET, triageFeedback } from "@/lib/feedback";
import { areaFromRoute, feedbackPath, routePattern, type FeedbackType } from "@/lib/feedback-logic";
import { roleLabel } from "@/lib/roles";

// Feedback said on a call or in an agent's chat ("submit feedback", "report a bug", "I have an idea for…"), filed down
// the same path as the in-app report form and "Report this" in a chat: saved as the person, with the call's recent
// lines (as a transcript in the feedback bucket) and the screen they were on, then read, grouped and routed by the
// same loop (lib/feedback.ts): a bug to the fix pipeline, an idea to the owner as an Ask (the owner's own straight to a build).

export async function fileFeedbackFromCall(
  db: SupabaseClient,
  admin: SupabaseClient,
  me: Staff,
  input: { type: FeedbackType; message: string; callId: string | null; roleKey: string; label: string; path: string | null; screen: string | null; clientId: string | null },
): Promise<{ ok: true; id: string; says: string } | { ok: false; error: string }> {
  const message = input.message.trim().slice(0, 5000);
  if (!message) return { ok: false, error: "What's the feedback? Say it in a line." };
  const route = (input.path ?? "").slice(0, 500);
  const path = route.split("?")[0].slice(0, 300);

  // The call's recent lines, oldest first (the triage and the fix read what happened)
  let transcript: { json: string; md: string; source: string; entries: number; cut: number } | null = null;
  if (input.callId) {
    const { data: rows } = await admin.from("ai_role_chats").select("role, content, role_key, created_at").eq("call_id", input.callId).order("created_at", { ascending: false }).limit(30);
    const entries: TranscriptEntry[] = ((rows ?? []) as { role: string; content: string; role_key: string | null; created_at: string }[])
      .reverse()
      .map((r) => ({ role: r.role === "user" ? "user" : "ai", at: r.created_at, text: String(r.content ?? ""), name: r.role === "user" ? me.fullName : (r.role_key ?? input.label) }));
    const t = buildTranscript({ chat: "agent-call", source: "server", threadId: input.callId, state: { screen: input.screen, path: route || null, agent: input.label }, entries });
    const base = `${me.id}/call/${randomUUID()}`;
    const [j, m] = await Promise.all([
      admin.storage.from(FEEDBACK_BUCKET).upload(`${base}.json`, Buffer.from(JSON.stringify(t), "utf8"), { contentType: "application/json" }),
      admin.storage.from(FEEDBACK_BUCKET).upload(`${base}.md`, Buffer.from(transcriptMarkdown(t, `Call transcript: ${input.label}`), "utf8"), { contentType: "text/markdown" }),
    ]);
    if (!j.error && !m.error) transcript = { json: `${base}.json`, md: `${base}.md`, source: "server", entries: t.entries.length, cut: t.cut };
    else console.error("[feedback call] transcript upload", j.error?.message ?? m.error?.message);
  }

  const way = feedbackPath(input.type, me.isExec);
  const context = {
    path,
    pattern: routePattern(path),
    area: areaFromRoute(route),
    person: me.fullName,
    role: roleLabel(me.role),
    serverVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    consoleErrors: [],
    failedRequests: [],
    screen: input.screen,
    chat: { key: `agent-call:${input.callId ?? "chat"}:${randomUUID().slice(0, 8)}`, kind: "agent-call", label: `a call with the ${input.label}`, mode: way.mode, threadId: input.callId, messageId: null, turns: [], error: null, note: null, transcript },
  };
  const { data, error } = await db
    .from("app_feedback")
    .insert({ profile_id: me.id, type: input.type, message, page_url: route, route, client_id: input.clientId, context })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "It didn't save. Try again in a moment." };
  const id = data.id as string;
  after(() => triageFeedback(admin, id));
  return { ok: true, id, says: way.says };
}
