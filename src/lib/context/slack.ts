import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact, getCursor, saveItems, setCursor, trimBody, type CollectResult, type ContextItem } from "./shared";

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

// Kaizen names channels "<client>-<Account Overview ID>" and "internal-<client>-<ID>" (white label: "wl-…", "wl-internal-…")
const idOf = (ch: { name: string }) => ch.name.match(/-(\d{2,6})$/)?.[1];
const isInternal = (ch: { name: string }) => /^(wl-)?internal-/.test(ch.name);

/**
 * Link channels to clients (by the Account Overview ID at the end of the name; for creative-package clients
 * also by name), join every public client channel the bot isn't in yet (any client, so it's already inside
 * when ops makes the channel private), and list private channels of creative clients it still needs an invite to.
 */
export async function matchSlackChannels(admin: SupabaseClient) {
  const [channels, { data: clients }] = await Promise.all([
    listChannels(),
    admin.from("clients").select("id, name, kaizen_id, creative_package, slack_channel_id, internal_slack_channel_id").neq("status", "offboarded"),
  ]);
  let matched = 0;
  for (const c of clients ?? []) {
    const key = compact(c.name);
    const byId = c.kaizen_id ? channels.filter((ch) => idOf(ch) === String(c.kaizen_id)) : [];
    // Without an ID match, fall back to the client's name in the channel name (creative clients only, to avoid look-alikes)
    const hits = byId.length
      ? byId
      : c.creative_package && key.length >= 4
        ? channels.filter((ch) => {
            const n = compact(ch.name);
            return n.includes(key) || (n.length >= 6 && key.includes(n));
          })
        : [];
    const external = hits.filter((ch) => !isInternal(ch));
    const internal = hits.filter((ch) => isInternal(ch));
    const patch: Record<string, string> = {};
    if (!c.slack_channel_id && external.length === 1) patch.slack_channel_id = external[0].id;
    if (!c.internal_slack_channel_id && internal.length === 1) patch.internal_slack_channel_id = internal[0].id;
    if (Object.keys(patch).length) {
      await admin.from("clients").update(patch).eq("id", c.id);
      Object.assign(c, patch);
      matched++;
    }
  }

  // Join every public client channel now; once ops makes it private the bot can no longer join by itself
  const joined: string[] = [];
  for (const ch of channels) {
    if (ch.is_member || ch.is_private || !idOf(ch)) continue;
    try {
      await slack("conversations.join", { channel: ch.id });
      ch.is_member = true;
      joined.push(`#${ch.name}`);
    } catch {
      // Some Slack Connect channels don't allow it; they show up under needsInvite below
    }
  }

  const creative = (clients ?? []).filter((c) => c.creative_package);
  const byChannel = new Map(channels.map((ch) => [ch.id, ch]));
  const needsInvite: string[] = [];
  for (const c of creative)
    for (const id of [c.internal_slack_channel_id, c.slack_channel_id]) {
      if (!id || byChannel.get(id)?.is_member) continue;
      const ch = byChannel.get(id);
      needsInvite.push(`${ch ? `#${ch.name}` : id} (${c.name})`);
    }
  // Names only, so we can see the naming and link the rest by hand or improve the matching
  const linked = new Set((clients ?? []).flatMap((c) => [c.slack_channel_id, c.internal_slack_channel_id]).filter(Boolean));
  const unlinkedChannels = channels.filter((ch) => !linked.has(ch.id)).map((ch) => `#${ch.name}${ch.is_ext_shared || ch.is_shared ? " (shared)" : ""}`).slice(0, 150);
  const noChannel = creative.filter((c) => !c.slack_channel_id && !c.internal_slack_channel_id).map((c) => c.name);
  return { matched, joined, needsInvite, channelsSeen: channels.length, unlinkedChannels, noChannel };
}

/** Zapier tells us a client channel was just created (still public): join it now and link it to its client. */
export async function linkNewChannel(admin: SupabaseClient, channelId: string) {
  const { channel } = await slack<{ channel: SlackChannel }>("conversations.info", { channel: channelId });
  let joined = Boolean(channel.is_member);
  if (!joined && !channel.is_private) {
    await slack("conversations.join", { channel: channelId });
    joined = true;
  }
  const id = idOf(channel);
  if (!id) return { ok: true, channel: `#${channel.name}`, joined, linked: null, note: "No client ID at the end of the channel name, so it wasn't linked" };
  const { data: client } = await admin.from("clients").select("id, name, slack_channel_id, internal_slack_channel_id").eq("kaizen_id", Number(id)).maybeSingle();
  if (!client) return { ok: true, channel: `#${channel.name}`, joined, linked: null, note: `No client with ID ${id} in Kaizen Ads yet; it links on the next run once they're added` };
  const field = isInternal(channel) ? "internal_slack_channel_id" : "slack_channel_id";
  if (!client[field]) await admin.from("clients").update({ [field]: channelId }).eq("id", client.id);
  return { ok: true, channel: `#${channel.name}`, joined, linked: client.name, as: field === "internal_slack_channel_id" ? "internal" : "client channel", alreadyLinked: Boolean(client[field]) };
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

export async function collectSlack(admin: SupabaseClient): Promise<CollectResult> {
  const access = await matchSlackChannels(admin);
  const { data: clients } = await admin
    .from("clients")
    .select("id, slack_channel_id, internal_slack_channel_id")
    .eq("creative_package", true);
  let saved = 0;
  const errors: string[] = [];
  for (const c of clients ?? []) {
    for (const [channel, source] of [
      [c.internal_slack_channel_id, "slack_internal"],
      [c.slack_channel_id, "slack_external"],
    ] as const) {
      if (!channel) continue;
      // Each channel keeps its own place, so a channel linked today (new client, upgrade) gets its last 30 days
      const key = `slack:${channel}`;
      const started = new Date();
      try {
        // Save before moving the channel's bookmark, so a failure never skips messages
        const read = await readChannel(channel, await getCursor(admin, key), c.id, source);
        await saveItems(admin, read);
        await setCursor(admin, key, new Date(started.getTime() - 5 * 60_000), { ok: true, items: read.length });
        saved += read.length;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e)); // e.g. not_in_channel: invite the bot
      }
    }
  }
  return {
    items: [], // already saved channel by channel
    notes: {
      saved,
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

/**
 * Add the bot to the private client channels a person is in, using their user token (SLACK_USER_TOKEN,
 * scopes groups:read and groups:write). Bots can't join private channels themselves. Only channels named
 * like a client channel ("…-<Account Overview ID>") are touched. Dry run unless go is true.
 */
export async function inviteBotToClientChannels(go: boolean) {
  const userToken = process.env.SLACK_USER_TOKEN;
  if (!userToken?.startsWith("xoxp-")) throw new Error("Add SLACK_USER_TOKEN (the xoxp- User OAuth Token) in Vercel, redeploy, then try again");
  const asUser = async <T>(method: string, params: Record<string, string>): Promise<{ ok: boolean; error?: string } & T> => {
    for (;;) {
      const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${userToken}` }, cache: "no-store" });
      if (res.status === 429) {
        // Inviting hundreds of channels hits Slack's limit; wait as told and carry on
        await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
        continue;
      }
      const body = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!body.ok && !(method === "conversations.invite" && body.error === "already_in_channel")) throw new Error(`Slack ${method}: ${body.error}`);
      return body;
    }
  };
  const { user_id: botUser } = await slack<{ user_id: string }>("auth.test", {});
  const { user: who } = await asUser<{ user: string }>("auth.test", {});

  const mine: SlackChannel[] = [];
  let cursor = "";
  do {
    const page = await asUser<{ channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>("users.conversations", {
      types: "private_channel",
      exclude_archived: "true",
      limit: "1000",
      ...(cursor ? { cursor } : {}),
    });
    mine.push(...page.channels);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);

  const targets = mine.filter((c) => idOf(c));
  const added: string[] = [];
  const already: string[] = [];
  const wouldAdd: string[] = [];
  const failed: string[] = [];
  for (const c of targets) {
    if (go) {
      // Invite straight away; "already in channel" just means it's done
      try {
        const r = await asUser("conversations.invite", { channel: c.id, users: botUser });
        (r.ok ? added : already).push(`#${c.name}`);
      } catch (e) {
        failed.push(`#${c.name}: ${e instanceof Error ? e.message : e}`);
      }
      continue;
    }
    const { members } = await asUser<{ members: string[] }>("conversations.members", { channel: c.id, limit: "1000" });
    (members.includes(botUser) ? already : wouldAdd).push(`#${c.name}`);
  }
  return {
    as: who,
    privateClientChannels: targets.length,
    ...(go ? { added, failed } : { wouldAdd, next: "Looks right? Add &go=1 to the URL to do it." }),
    alreadyHasBot: already.length,
  };
}
