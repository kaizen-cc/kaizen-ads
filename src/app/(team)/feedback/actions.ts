"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireExec, requireStaff } from "@/lib/auth";
import { CHAT_LABEL, chatReportMessage, sanitizeChatReport } from "@/lib/chat-report";
import { transcriptMarkdown } from "@/lib/chat-transcript";
import { loadTranscript } from "@/lib/chat-transcript-server";
import { FEEDBACK_BUCKET, approveMerge, askForChanges, logEvent, notifyFixed, notifyReporters, planOnRoadmap, recomputeGroup, startFix, triageFeedback } from "@/lib/feedback";
import { STATUSES, TYPES, areaFromRoute, routePattern, type FeedbackStatus, type FeedbackType } from "@/lib/feedback-logic";
import { roleLabel } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type FeedbackInput = {
  type: FeedbackType;
  message: string;
  pageUrl: string;
  path: string; // the address inside the app: path and query
  clientSlug: string | null;
  screenshot: string | null; // a data: URL (JPEG or PNG), already shrunk in the browser
  context: {
    userAgent: string;
    viewport: string;
    screen: string;
    pixelRatio: number;
    theme: string;
    online: boolean;
    language: string;
    version: string;
    consoleErrors: { at: string; message: string }[];
    failedRequests: { at: string; method: string; url: string; status: number | null; error?: string }[];
  };
};

const MAX_SHOT = 6 * 1024 * 1024;

/** Someone left feedback from the bubble: saved at once, then read and grouped after the response. */
export async function submitFeedback(input: FeedbackInput): Promise<{ ok: true; id: string } | { error: string }> {
  const me = await requireStaff();
  const message = String(input.message ?? "").trim().slice(0, 5000);
  if (!message) return { error: "Write a line about what happened or what you'd like." };
  const type = TYPES.some((t) => t.value === input.type) ? input.type : "bug";
  const db = await createClient();
  // Where they were: the address inside the app (path and query), and the page itself (path only)
  const route = String(input.path ?? "").slice(0, 500);
  const path = route.split("?")[0].slice(0, 300);

  // The client in view, if the page is a client's
  let clientId: string | null = null;
  if (input.clientSlug) {
    const { data } = await db.from("clients").select("id").eq("slug", input.clientSlug).maybeSingle();
    clientId = (data?.id as string | undefined) ?? null;
  }

  let screenshotPath: string | null = null;
  const shot = input.screenshot?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (shot && adminConfigured()) {
    const bytes = Buffer.from(shot[2], "base64");
    if (bytes.length <= MAX_SHOT) {
      const ext = shot[1] === "image/png" ? "png" : shot[1] === "image/webp" ? "webp" : "jpg";
      const key = `${me.id}/${randomUUID()}.${ext}`;
      const { error } = await createAdminClient().storage.from(FEEDBACK_BUCKET).upload(key, bytes, { contentType: shot[1] });
      if (!error) screenshotPath = key;
      else console.error("[feedback] screenshot upload failed:", error.message);
    }
  }

  const c = input.context ?? ({} as FeedbackInput["context"]);
  const context = {
    path,
    pattern: routePattern(path),
    area: areaFromRoute(route),
    person: me.fullName,
    role: roleLabel(me.role),
    userAgent: String(c.userAgent ?? "").slice(0, 400),
    viewport: String(c.viewport ?? "").slice(0, 40),
    screen: String(c.screen ?? "").slice(0, 40),
    pixelRatio: Number(c.pixelRatio) || null,
    theme: String(c.theme ?? "").slice(0, 20),
    online: Boolean(c.online),
    language: String(c.language ?? "").slice(0, 20),
    version: String(c.version ?? "").slice(0, 40),
    serverVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    consoleErrors: (Array.isArray(c.consoleErrors) ? c.consoleErrors : []).slice(-12).map((e) => ({ at: String(e.at), message: String(e.message).slice(0, 400) })),
    failedRequests: (Array.isArray(c.failedRequests) ? c.failedRequests : [])
      .slice(-12)
      .map((r) => ({ at: String(r.at), method: String(r.method).slice(0, 10), url: String(r.url).slice(0, 300), status: typeof r.status === "number" ? r.status : null, ...(r.error ? { error: String(r.error).slice(0, 200) } : {}) })),
  };

  const { data, error } = await db
    .from("app_feedback")
    .insert({ profile_id: me.id, type, message, page_url: String(input.pageUrl ?? "").slice(0, 1000), route, client_id: clientId, context, screenshot_path: screenshotPath })
    .select("id")
    .single();
  if (error || !data) return { error: "That didn't send. Try again in a moment." };
  const id = data.id as string;
  if (adminConfigured()) after(() => triageFeedback(createAdminClient(), id));
  revalidatePath("/feedback");
  return { ok: true, id };
}

/** Execs: move a group along (New, Planned, In progress, Fixed, Won't fix). Fixed tells everyone who reported it. */
export async function setFeedbackStatus(groupId: string, status: FeedbackStatus): Promise<{ ok: true; notified?: number } | { error: string }> {
  const me = await requireExec();
  if (!STATUSES.some((s) => s.value === status)) return { error: "Unknown status" };
  const db = await createClient();
  const fixed = status === "fixed";
  const { error } = await db
    .from("app_feedback_groups")
    .update({ status, fixed_at: fixed ? new Date().toISOString() : null, fixed_by: fixed ? me.id : null, updated_at: new Date().toISOString() })
    .eq("id", groupId);
  if (error) return { error: "That didn't save. Try again." };
  let notified: number | undefined;
  if (adminConfigured()) {
    const admin = createAdminClient();
    await logEvent(admin, groupId, fixed ? "fixed" : "status", fixed ? "Marked fixed" : `Status: ${STATUSES.find((s) => s.value === status)?.label}`, { actor: me.id, shared: fixed });
    await recomputeGroup(admin, groupId);
    if (fixed) notified = (await notifyFixed(admin, groupId, me.id)).notified;
  }
  revalidatePath("/feedback");
  return { ok: true, notified };
}

/** Execs: who's on it (or nobody). */
export async function setFeedbackAssignee(groupId: string, assigneeId: string | null): Promise<{ ok: true } | { error: string }> {
  const me = await requireExec();
  const db = await createClient();
  const { error } = await db.from("app_feedback_groups").update({ assignee_id: assigneeId || null, updated_at: new Date().toISOString() }).eq("id", groupId);
  if (error) return { error: "That didn't save. Try again." };
  if (adminConfigured()) {
    const admin = createAdminClient();
    const { data: p } = assigneeId ? await admin.from("profiles").select("full_name").eq("id", assigneeId).maybeSingle() : { data: null };
    await logEvent(admin, groupId, "assigned", p ? `Assigned to ${p.full_name}` : "Unassigned", { actor: me.id });
  }
  revalidatePath("/feedback");
  return { ok: true };
}

// ─── The review card: approve to build, ask for more, won't do ──────────────

/** The owner: build this Ask now. Claude opens a pull request from the plan (and the note); it waits for approval before it merges. */
export async function approveFeedback(groupId: string, note: string): Promise<{ ok: true; url?: string } | { error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const admin = createAdminClient();
  const text = note.trim().slice(0, 2000) || null;
  await admin.from("app_feedback_groups").update({ status: "planned", lane: "build", updated_at: new Date().toISOString() }).eq("id", groupId);
  await logEvent(admin, groupId, "approved", text ? `Approved to build: ${text}` : "Approved to build", { actor: me.id, shared: true });
  const r = await startFix(admin, groupId, false, { note: text, actor: me.id });
  await recomputeGroup(admin, groupId);
  revalidatePath("/feedback");
  if ("error" in r && r.error) return { error: `Approved, but it couldn't be sent to Claude: ${r.error}` };
  return { ok: true, url: r.url };
}

/** Execs: a question or next step for the people who reported it (they get it as a notification and on My feedback). */
export async function commentFeedback(groupId: string, comment: string): Promise<{ ok: true; notified: number } | { error: string }> {
  const me = await requireExec();
  const text = comment.trim().slice(0, 2000);
  if (!text) return { error: "Write the comment first." };
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const admin = createAdminClient();
  const eventId = await logEvent(admin, groupId, "comment", text, { actor: me.id, shared: true });
  const { data: g } = await admin.from("app_feedback_groups").select("title").eq("id", groupId).maybeSingle();
  const notified = await notifyReporters(admin, groupId, { key: `feedback-reply:${eventId}`, title: `About your feedback: ${g?.title ?? ""}`, body: `${me.fullName}: ${text}`, actor: me.id });
  revalidatePath("/feedback");
  return { ok: true, notified };
}

/** Execs: not doing it, and why (the people who reported it hear the reason). */
export async function wontDoFeedback(groupId: string, reason: string): Promise<{ ok: true; notified: number } | { error: string }> {
  const me = await requireExec();
  const text = reason.trim().slice(0, 2000);
  if (!text) return { error: "Say why, so the people who asked understand." };
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const admin = createAdminClient();
  await admin.from("app_feedback_groups").update({ status: "wont_fix", fixed_at: null, updated_at: new Date().toISOString() }).eq("id", groupId);
  const eventId = await logEvent(admin, groupId, "wont_fix", text, { actor: me.id, shared: true });
  await recomputeGroup(admin, groupId);
  const { data: g } = await admin.from("app_feedback_groups").select("title").eq("id", groupId).maybeSingle();
  const notified = await notifyReporters(admin, groupId, { key: `feedback-reply:${eventId}`, title: `Won't do: ${g?.title ?? ""}`, body: text, actor: me.id });
  revalidatePath("/feedback");
  return { ok: true, notified };
}

/** Someone who reported it answers a question about it (execs hear). */
export async function replyFeedback(groupId: string, reply: string): Promise<{ ok: true } | { error: string }> {
  const me = await requireStaff();
  const text = reply.trim().slice(0, 2000);
  if (!text) return { error: "Write your reply first." };
  const db = await createClient();
  // Only on something they reported (RLS shows them their own reports)
  const { count } = await db.from("app_feedback").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("profile_id", me.id);
  if (!count) return { error: "That isn't one of yours." };
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const admin = createAdminClient();
  const eventId = await logEvent(admin, groupId, "reply", text, { actor: me.id, shared: true });
  const { data: g } = await admin.from("app_feedback_groups").select("title").eq("id", groupId).maybeSingle();
  const { data: execs } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null);
  for (const e of execs ?? [])
    if (e.id !== me.id)
      await admin.from("notifications").upsert(
        { profile_id: e.id, kind: "feedback", title: `${me.fullName} replied: ${g?.title ?? ""}`.slice(0, 300), body: text.slice(0, 1000), href: `/feedback?g=${groupId}`, key: `feedback-reply:${eventId}`, priority: "normal", actor_id: me.id },
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  revalidatePath("/feedback");
  return { ok: true };
}

// ─── From a chat: "Report this" and "Ask for this" ──────────────────────────

/**
 * A message in a chat fell short: filed like the bubble's reports (grouped, repeats counted, the reporters kept up to
 * date), with the whole conversation read from where the chat is stored (the browser's copy for chats that aren't),
 * kept as JSON and Markdown in the feedback bucket. The same message reported twice answers with the first report.
 */
export async function reportFromChat(raw: unknown): Promise<{ ok: true; id: string } | { error: string }> {
  const me = await requireStaff();
  const r = sanitizeChatReport(raw);
  if (!r) return { error: "That report was missing what it needs. Try again." };
  const db = await createClient();
  const key = `${r.chat}:${r.threadId ?? ""}:${r.messageId}`;
  const { data: prior } = await db.from("app_feedback").select("id").eq("profile_id", me.id).eq("context->chat->>key", key).limit(1).maybeSingle();
  if (prior) return { ok: true, id: prior.id as string };

  let clientId: string | null = null;
  if (r.clientSlug) {
    const { data } = await db.from("clients").select("id").eq("slug", r.clientSlug).maybeSingle();
    clientId = (data?.id as string | undefined) ?? null;
  }

  // The whole chat, from the server's copy where there is one; the error on the message goes in if it wasn't stored
  let transcript: { json: string; md: string; source: string; entries: number; cut: number } | null = null;
  if (adminConfigured()) {
    const admin = createAdminClient();
    const t = await loadTranscript(admin, r, { id: me.id, isExec: me.isExec });
    if (r.error && !t.entries.some((e) => e.error?.text && r.error?.text && e.error.text.includes(r.error.text.slice(0, 60))))
      t.entries.push({ role: "ai", at: new Date().toISOString(), text: "", error: r.error });
    const base = `${me.id}/chat/${randomUUID()}`;
    const [j, m] = await Promise.all([
      admin.storage.from(FEEDBACK_BUCKET).upload(`${base}.json`, Buffer.from(JSON.stringify(t), "utf8"), { contentType: "application/json" }),
      admin.storage.from(FEEDBACK_BUCKET).upload(`${base}.md`, Buffer.from(transcriptMarkdown(t, `Chat transcript: ${CHAT_LABEL[r.chat]}`), "utf8"), { contentType: "text/markdown" }),
    ]);
    if (!j.error && !m.error) transcript = { json: `${base}.json`, md: `${base}.md`, source: t.source, entries: t.entries.length, cut: t.cut };
    else console.error("[feedback] transcript upload failed:", j.error?.message ?? m.error?.message);
  }

  const route = r.path.slice(0, 500);
  const path = route.split("?")[0].slice(0, 300);
  const context = {
    path,
    pattern: routePattern(path),
    area: areaFromRoute(route),
    person: me.fullName,
    role: roleLabel(me.role),
    serverVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    consoleErrors: [],
    failedRequests: [],
    chat: { key, kind: r.chat, label: CHAT_LABEL[r.chat], mode: r.mode, threadId: r.threadId, messageId: r.messageId, turns: r.turns, error: r.error, note: r.note || null, transcript },
  };
  const { data, error } = await db
    .from("app_feedback")
    .insert({ profile_id: me.id, type: r.mode === "error" ? "bug" : "idea", message: chatReportMessage(r), page_url: r.pageUrl, route, client_id: clientId, context })
    .select("id")
    .single();
  if (error || !data) return { error: "That didn't send. Try again in a moment." };
  const id = data.id as string;
  if (adminConfigured()) after(() => triageFeedback(createAdminClient(), id));
  revalidatePath("/feedback");
  return { ok: true, id };
}

// ─── The owner's approval card: Approve and merge, Ask for changes ──────────

/** The owner: merge this fix (the workflow runs every check again first). */
export async function approveFixMerge(groupId: string): Promise<{ ok: true } | { error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const r = await approveMerge(createAdminClient(), groupId, me.id);
  revalidatePath("/feedback");
  return r;
}

/** The owner: not this fix; Claude builds it again with the note (it waits for approval again). */
export async function askFixChanges(groupId: string, note: string): Promise<{ ok: true; url?: string } | { error: string }> {
  const me = await requireExec();
  const text = note.trim().slice(0, 2000);
  if (!text) return { error: "Say what to change, so Claude knows." };
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const r = await askForChanges(createAdminClient(), groupId, text, me.id);
  revalidatePath("/feedback");
  return "error" in r && r.error ? { error: r.error } : { ok: true, url: "url" in r ? r.url : undefined };
}

/** The owner: plan this Ask (a line on the roadmap under Requested by the team). */
export async function planAsk(groupId: string): Promise<{ ok: true } | { error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { error: "The server isn't set up for this yet." };
  const r = await planOnRoadmap(createAdminClient(), groupId, me.id);
  revalidatePath("/feedback");
  return r;
}
