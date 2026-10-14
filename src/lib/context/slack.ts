import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact, trimBody, type CollectResult, type ContextItem } from "./shared";

// Reads client channels through the Kaizen OS Slack app (its bot token, set as SLACK_BOT_TOKEN).
// The bot must be a member of a channel to read it. Needs channels:history, groups:history,
// channels:read, groups:read, users:read and channels:join.
// Public client channels are joined automatically on every run, so new ones are picked up by the next run.
// Private channels can't be joined by a bot (it can't even see them until invited); those are listed as needing an invite.

export const slackConfigured = () => Boolean(process.env.SLACK_BOT_TOKEN);

type SlackMessage = { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; latest_reply?: string; subtype?: string; bot_id?: string };
type SlackChannel = { id: string; name: string; is_private?: boolean; is_ext_shared?: boolean; is_shared?: boolean; is_member?: boolean; is_archived?: boolean };

async function slack<T>(method: string, params: Record<string, string>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      cache: "no-store",
    });
    if (res.status === 429) {
      // Slack's rate limits are per method; wait as told and try again
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
      continue;
    }
    const body = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
    return body;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

async function listChannels() {
  const out: SlackChannel[] = [];
  let cursor = "";
  do {
    const page = await slack<{ channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1000",
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.channels);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return out;
}

/**
 * Fill in channels for clients that don't have one yet (shared Slack Connect channels are external, the rest internal),
 * join the public ones the bot isn't in, and list the private ones someone needs to invite it to.
 */
export async function matchSlackChannels(admin: SupabaseClient) {
  const [channels, { data: clients }] = await Promise.all([
    listChannels(),
    admin.from("clients").select("id, name, slack_channel_id, internal_slack_channel_id").eq("creative_package", true),
  ]);
  let matched = 0;
  for (const c of clients ?? []) {
    const key = compact(c.name);
    if (key.length < 4) continue;
    const hits = channels.filter((ch) => {
      const n = compact(ch.name);
      return n.includes(key) || (n.length >= 6 && key.includes(n));
    });
    const external = hits.filter((ch) => ch.is_ext_shared || ch.is_shared);
    const internal = hits.filter((ch) => !ch.is_ext_shared && !ch.is_shared);
    const patch: Record<string, string> = {};
    if (!c.slack_channel_id && external.length === 1) patch.slack_channel_id = external[0].id;
    if (!c.internal_slack_channel_id && internal.length === 1) patch.internal_slack_channel_id = internal[0].id;
    if (Object.keys(patch).length) {
      await admin.from("clients").update(patch).eq("id", c.id);
      Object.assign(c, patch);
      matched++;
    }
  }

  const byId = new Map(channels.map((ch) => [ch.id, ch]));
  const joined: string[] = [];
  const needsInvite: string[] = [];
  for (const c of clients ?? []) {
    for (const id of [c.internal_slack_channel_id, c.slack_channel_id]) {
      if (!id) continue;
      const ch = byId.get(id);
      if (ch?.is_member) continue;
      if (ch && !ch.is_private) {
        try {
          await slack("conversations.join", { channel: id });
          ch.is_member = true;
          joined.push(`#${ch.name}`);
          continue;
        } catch {
          // Missing channels:join, or a Slack Connect channel that doesn't allow it: falls through to "needs invite"
        }
      }
      needsInvite.push(`${ch ? `#${ch.name}` : id} (${c.name})`);
    }
  }
  // Names only, so we can see the naming and link the rest by hand or improve the matching
  const linked = new Set((clients ?? []).flatMap((c) => [c.slack_channel_id, c.internal_slack_channel_id]).filter(Boolean));
  const unlinkedChannels = channels.filter((ch) => !linked.has(ch.id)).map((ch) => `#${ch.name}${ch.is_ext_shared || ch.is_shared ? " (shared)" : ""}`).slice(0, 150);
  const noChannel = (clients ?? []).filter((c) => !c.slack_channel_id && !c.internal_slack_channel_id).map((c) => c.name);
  return { matched, joined, needsInvite, channelsSeen: channels.length, unlinkedChannels, noChannel };
}

const names = new Map<string, string>();
async function personName(id: string | undefined) {
  if (!id) return null;
  if (!names.has(id)) {
    try {
      const r = await slack<{ user: { real_name?: string; profile?: { display_name?: string } } }>("users.info", { user: id });
      names.set(id, r.user.real_name || r.user.profile?.display_name || id);
    } catch {
      names.set(id, id);
    }
  }
  return names.get(id)!;
}

const permalink = (channel: string, ts: string) => `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;

async function readChannel(channel: string, since: Date, clientId: string, source: ContextItem["source"]) {
  const oldest = (since.getTime() / 1000).toFixed(6);
  const items: ContextItem[] = [];
  const { messages } = await slack<{ messages: SlackMessage[] }>("conversations.history", { channel, oldest, limit: "200" });
  const add = async (m: SlackMessage) => {
    if (!m.text?.trim() || m.subtype === "channel_join" || m.subtype === "channel_leave") return;
    items.push({
      client_id: clientId,
      source,
      external_id: `${channel}:${m.ts}`,
      thread_id: m.thread_ts ? `${channel}:${m.thread_ts}` : null,
      occurred_at: new Date(Number(m.ts) * 1000).toISOString(),
      author: m.bot_id ? "bot" : await personName(m.user),
      title: null,
      body: trimBody(m.text),
      url: permalink(channel, m.ts),
      meta: {},
    });
  };
  for (const m of messages) {
    await add(m);
    // Threads can get new replies long after the parent message
    if (m.reply_count && m.latest_reply && Number(m.latest_reply) > Number(oldest)) {
      const { messages: replies } = await slack<{ messages: SlackMessage[] }>("conversations.replies", { channel, ts: m.ts, oldest, limit: "200" });
      for (const r of replies) if (r.ts !== m.ts) await add(r);
    }
  }
  return items;
}

export async function collectSlack(admin: SupabaseClient, since: Date): Promise<CollectResult> {
  const access = await matchSlackChannels(admin);
  const { data: clients } = await admin
    .from("clients")
    .select("id, slack_channel_id, internal_slack_channel_id")
    .eq("creative_package", true);
  const items: ContextItem[] = [];
  const errors: string[] = [];
  for (const c of clients ?? []) {
    for (const [channel, source] of [
      [c.internal_slack_channel_id, "slack_internal"],
      [c.slack_channel_id, "slack_external"],
    ] as const) {
      if (!channel) continue;
      try {
        items.push(...(await readChannel(channel, since, c.id, source)));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e)); // e.g. not_in_channel: invite the bot
      }
    }
  }
  return {
    items,
    notes: {
      channelsSeen: access.channelsSeen,
      channelsMatched: access.matched,
      joined: access.joined,
      needsInvite: access.needsInvite,
      clientsWithoutChannel: access.noChannel,
      unlinkedChannels: access.unlinkedChannels,
      errors: errors.slice(0, 10),
    },
  };
}

const NEEDED_SCOPES = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "channels:join"];

/** Setup check: is the token valid, does it have every scope, and how many channels is the bot in. */
export async function checkSlack() {
  if (!slackConfigured()) throw new Error("SLACK_BOT_TOKEN is missing");
  const res = await fetch("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, cache: "no-store" });
  const body = (await res.json()) as { ok: boolean; error?: string; team?: string; user?: string };
  if (!body.ok) throw new Error(`Slack token rejected: ${body.error}`);
  const header = res.headers.get("x-oauth-scopes");
  const scopes = (header ?? "").split(",").map((s) => s.trim());
  const missing = header ? NEEDED_SCOPES.filter((s) => !scopes.includes(s)) : [];
  if (missing.length) throw new Error(`Connected to ${body.team} as @${body.user}, but missing scopes: ${missing.join(", ")}. Add them under Bot Token Scopes and reinstall the app.`);
  const channels = await listChannels();
  return `Connected to ${body.team} as @${body.user}${header ? ", all scopes in place" : ""}. Sees ${channels.length} channels and is a member of ${channels.filter((c) => c.is_member).length}.`;
}
