"use server";

import { requireStaff } from "@/lib/auth";
import { canAccessReport } from "@/lib/reports/access";
import { parseSlackLink, slackTargetOf, type SlackTarget } from "@/lib/reports/delivery-core";
import { slackReadAs } from "@/lib/slack-user";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The report send step's "where in Slack": the channels the person can post to, a channel's recent threads, and what a
// pasted thread link points at. Read only; what's picked is saved with the send (remembered per client and line).

type Thread = { ts: string; label: string; replies: number; at: string };

async function allowed(reportId: string) {
  const me = await requireStaff();
  const { data: r } = await createAdminClient().from("reports").select("owner_id, client_id, platform").eq("id", reportId).maybeSingle();
  if (!r || !(await canAccessReport(await createClient(), me, r as { owner_id: string | null; client_id: string; platform: string }))) return null;
  return me;
}

/** A message's first words, without Slack's markup: "Weekly email reports for Aldecoa" */
const labelOf = (text: unknown) =>
  String(text ?? "")
    .replace(/<!(?:here|channel|everyone)>/g, "")
    .replace(/<[@#][A-Z0-9]+(?:\|([^>]+))?>/g, (_m, n: string | undefined) => (n ? `@${n}` : ""))
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);

/** The channels this person can post to (theirs in Slack, not archived), by name */
export async function slackChannelsFor(reportId: string): Promise<{ ok: true; channels: { id: string; name: string }[] } | { ok: false; error: string }> {
  const me = await allowed(reportId);
  if (!me) return { ok: false, error: "Not found." };
  const out: { id: string; name: string }[] = [];
  let cursor = "";
  for (let i = 0; i < 5; i++) {
    const r = await slackReadAs(me.id, "users.conversations", { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) });
    if (!r?.ok) return out.length ? { ok: true, channels: out } : { ok: false, error: "Slack didn't list your channels. Connect your Slack again, or paste a link to the thread." };
    for (const c of (r.channels as { id: string; name: string }[] | undefined) ?? []) out.push({ id: c.id, name: c.name });
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
    if (!cursor) break;
  }
  return { ok: true, channels: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** A channel's recent threads (messages with replies, or any top-level message) from the last 60 days, newest first */
export async function slackThreadsIn(reportId: string, channel: string): Promise<{ ok: true; threads: Thread[] } | { ok: false; error: string }> {
  const me = await allowed(reportId);
  if (!me) return { ok: false, error: "Not found." };
  if (!/^[CG][A-Z0-9]{6,20}$/.test(channel)) return { ok: false, error: "That isn't a Slack channel." };
  const oldest = String(Math.floor(Date.now() / 1000) - 60 * 86_400);
  const r = await slackReadAs(me.id, "conversations.history", { channel, limit: "100", oldest });
  if (!r?.ok) return { ok: false, error: r?.error === "not_in_channel" ? "You're not in that channel in Slack." : "Slack didn't give that channel's messages. Paste a link to the thread instead." };
  const msgs = ((r.messages as { ts: string; text?: string; reply_count?: number; subtype?: string }[] | undefined) ?? []).filter((m) => !m.subtype || m.subtype === "thread_broadcast");
  // Threads first (a standing report thread has replies), then other messages
  const threads = msgs
    .map((m) => ({ ts: m.ts, label: labelOf(m.text) || "(a file or an attachment)", replies: m.reply_count ?? 0, at: new Date(Number(m.ts) * 1000).toISOString() }))
    .sort((a, b) => Number(b.replies > 0) - Number(a.replies > 0) || Number(b.ts) - Number(a.ts))
    .slice(0, 15);
  return { ok: true, threads };
}

/**
 * What a target points at, read from Slack: the channel's name and the thread's first words, and whether the thread is
 * still there. A pasted message link is read into its channel and thread first.
 */
export async function slackTargetDetails(reportId: string, input: { link?: string; target?: SlackTarget }): Promise<{ ok: true; target: SlackTarget; threadOk: boolean } | { ok: false; error: string }> {
  const me = await allowed(reportId);
  if (!me) return { ok: false, error: "Not found." };
  const fromLink = input.link ? parseSlackLink(input.link) : null;
  if (input.link && !fromLink) return { ok: false, error: "That isn't a Slack message link. In Slack, open the thread's first message › Copy link." };
  const t = slackTargetOf(fromLink ? { ...input.target, ...fromLink } : input.target);
  if (!t) return { ok: false, error: "Pick a channel or paste a thread link." };
  const channel = t.channel;
  let channelName = t.channelName ?? null;
  if (channel) {
    const info = await slackReadAs(me.id, "conversations.info", { channel });
    channelName = info?.ok ? String((info.channel as { name?: string } | undefined)?.name ?? channelName ?? "") || null : channelName;
  }
  let threadOk = true;
  let threadLabel = t.threadLabel ?? null;
  if (channel && t.thread) {
    const rep = await slackReadAs(me.id, "conversations.replies", { channel, ts: t.thread, limit: "1" });
    const first = rep?.ok ? ((rep.messages as { text?: string }[] | undefined) ?? [])[0] : null;
    threadOk = Boolean(first);
    if (first) threadLabel = labelOf(first.text) || threadLabel;
  }
  return { ok: true, target: { ...t, channelName, threadLabel }, threadOk };
}
