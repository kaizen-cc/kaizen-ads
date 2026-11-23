import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// What a hand-off and a send leave behind: the teammate told (a bell, and a Slack direct message when their Slack is
// connected), and on the call's row (its `watches` list, so nothing needs a new column) the drafts made on the call
// and a yes that a failure on our side shouldn't use up.

/** The teammate hears about a task, ask or FYI: in the app's bell, and in Slack when they've connected it */
export async function tellTeammate(admin: SupabaseClient, n: { ownerId: string; askId: string; title: string; body: string }) {
  await admin
    .from("notifications")
    .upsert({ profile_id: n.ownerId, kind: "agent", title: n.title.slice(0, 300), body: n.body.slice(0, 1000), href: "/pipeline#next", key: `agent-ask:${n.askId}`, priority: "normal", read_at: null }, { onConflict: "profile_id,key" })
    .then(({ error }) => error && console.error("[handoff] notice", error.message));
  let slack = false;
  try {
    const { slackConnection, postAsApp } = await import("@/lib/slack-user");
    const s = await slackConnection(n.ownerId);
    if (s.connected && s.slackUserId) {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const r = await postAsApp({ channel: s.slackUserId, text: `${n.title}\n${n.body}${base ? `\n${base}/pipeline#next` : ""}` });
      slack = r.ok;
    }
  } catch (e) {
    console.error("[handoff] slack dm", e instanceof Error ? e.message : e);
  }
  return { slack };
}

// ─── The call's own memo (drafts, a carried yes) ────────────────────────────

export type Draft = {
  kind: "draft";
  id: string;
  done: true;
  channel: "slack" | "email";
  /** Slack: the channel and thread; email: the mailbox, thread and who it goes to */
  slack?: { channel: string; thread: string | null; where: string };
  email?: { mailbox: string; threadId: string | null; to: string; cc?: string | null; subject: string; inReplyTo?: string | null; references?: string | null };
  text: string;
  client: string | null;
  owedId?: string | null;
  /** Kaizen documents attached to an email (their PDFs go with it) */
  attachments?: { documentId: string; name: string }[];
  /** The client email draft it's also kept as (Overview's "Emails ready to send") */
  clientDraftId?: string | null;
  sent?: "slack" | "gmail" | "gmail_draft" | null;
  /** Where it was put for the person to send themselves (their Gmail drafts, their Slack self-DM) and its link */
  saved?: { to: "gmail" | "slack"; href: string | null } | null;
  at: string;
};
type YesMemo = { kind: "yes"; id: string; done: true; tool: string; at: string };
type Memo = { kind: string; id: string; done?: boolean; [k: string]: unknown };

async function memo(admin: SupabaseClient, callId: string): Promise<Memo[]> {
  const { data } = await admin.from("ai_role_calls").select("watches").eq("id", callId).maybeSingle();
  return ((data?.watches ?? []) as Memo[]).slice();
}
const save = (admin: SupabaseClient, callId: string, watches: Memo[]) => admin.from("ai_role_calls").update({ watches }).eq("id", callId);

/** A draft made on the call (new or changed) */
export async function putDraft(admin: SupabaseClient, callId: string, d: Draft) {
  const list = (await memo(admin, callId)).filter((w) => !(w.kind === "draft" && w.id === d.id));
  await save(admin, callId, [...list, d].slice(-40));
}

export async function getDraft(admin: SupabaseClient, callId: string, id: string): Promise<Draft | null> {
  return ((await memo(admin, callId)).find((w) => w.kind === "draft" && w.id === id) as Draft | undefined) ?? null;
}

/** Every draft on the call, oldest first */
export async function allDrafts(admin: SupabaseClient, callId: string): Promise<Draft[]> {
  return (await memo(admin, callId)).filter((w): w is Draft => w.kind === "draft");
}

/** The newest draft on the call that hasn't gone out */
export async function latestDraft(admin: SupabaseClient, callId: string): Promise<Draft | null> {
  const drafts = (await memo(admin, callId)).filter((w): w is Draft => w.kind === "draft" && !(w as Draft).sent);
  return drafts.at(-1) ?? null;
}

/** The person edited a draft on the call's card: what goes out is their text */
export async function editDraft(admin: SupabaseClient, callId: string, id: string, text: string) {
  const d = await getDraft(admin, callId, id);
  if (!d || d.sent) return false;
  await putDraft(admin, callId, { ...d, text: text.replace(/\r\n/g, "\n").trim().slice(0, 4000) });
  return true;
}

/** How long a yes stays good after an action failed for a reason the person didn't cause */
const CARRY_MS = 5 * 60_000;

/** A yes was given and the action failed on our side: the next try of that action needs no second yes */
export async function carryYes(admin: SupabaseClient, callId: string, tool: string) {
  const list = (await memo(admin, callId)).filter((w) => !(w.kind === "yes" && (w as YesMemo).tool === tool));
  await save(admin, callId, [...list, { kind: "yes", id: crypto.randomUUID(), done: true, tool, at: new Date().toISOString() } satisfies YesMemo]);
}

/** The actions with a carried yes still good on this call */
export async function carriedYes(admin: SupabaseClient, callId: string): Promise<Set<string>> {
  const now = Date.now();
  return new Set(
    (await memo(admin, callId))
      .filter((w): w is YesMemo => w.kind === "yes")
      .filter((w) => now - Date.parse(w.at) < CARRY_MS)
      .map((w) => w.tool),
  );
}

/** The carried yes used up (the action went through) */
export async function dropYes(admin: SupabaseClient, callId: string, tool: string) {
  const list = await memo(admin, callId);
  const next = list.filter((w) => !(w.kind === "yes" && (w as YesMemo).tool === tool));
  if (next.length !== list.length) await save(admin, callId, next);
}
