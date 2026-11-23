import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Posting to Slack as a person, not the bot. Each team member connects their own Slack once
// (/api/slack/connect) and Kaizen OS keeps their user token in slack_user_tokens (server-only,
// no RLS policies, read and written with the admin client). Client reports then land in the
// client channel under the buyer's own name and face, the way a message they typed would.
//
// What the admin must configure, once:
//   1. Slack: api.slack.com/apps → the Kaizen OS app
//      - OAuth & Permissions → Redirect URLs: add https://ads.kaizenmarketing.agency/api/slack/callback
//      - OAuth & Permissions → User Token Scopes: add chat:write, files:write, files:read
//      - Reinstall the app to the workspace (Slack asks for this after scopes change)
//   2. Vercel: set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET (Slack app → Basic Information → App Credentials),
//      then redeploy.
// Until both are set, the connect button sends people back with ?slack=not_configured.

export const SLACK_USER_SCOPES = "chat:write,files:write,files:read";

/**
 * Reading as the person (their assistant searching their own Slack, DMs included): asked for when they connect with
 * ?read=1 (/api/slack/connect?read=1). The admin adds these to the app's User Token Scopes first, once:
 * search:read, channels:history, groups:history, im:history, mpim:history.
 */
export const SLACK_READ_SCOPES = "search:read,channels:history,groups:history,im:history,mpim:history,im:read,mpim:read";

/** This person's own Slack token and what it may do (server only: never sent to the browser or the model) */
export async function slackUserToken(profileId: string): Promise<{ token: string; scopes: string[]; slackUserId: string } | null> {
  const { data } = await createAdminClient().from("slack_user_tokens").select("token, scopes, slack_user_id").eq("profile_id", profileId).maybeSingle();
  if (!data?.token) return null;
  return { token: data.token as string, scopes: String(data.scopes ?? "").split(/[\s,]+/).filter(Boolean), slackUserId: String(data.slack_user_id ?? "") };
}

/** A read-only Slack Web API call with a person's token (GET), with Slack's error kept */
export async function slackRead<T extends { ok: boolean; error?: string }>(token: string, method: string, params: Record<string, string>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Math.min(10, Number(res.headers.get("retry-after") ?? 2)) * 1000));
      continue;
    }
    return (await res.json()) as T;
  }
  return { ok: false, error: "ratelimited" } as T;
}

export const slackOAuthConfigured = () => Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);

type SlackBody = { ok: boolean; error?: string; [key: string]: unknown };

/** Whether this person has connected their Slack (and who they are there). */
export async function slackConnection(profileId: string): Promise<{ connected: boolean; slackUserId?: string }> {
  const { data } = await createAdminClient().from("slack_user_tokens").select("slack_user_id").eq("profile_id", profileId).maybeSingle();
  return data ? { connected: true, slackUserId: data.slack_user_id } : { connected: false };
}

/** Keep (or replace) the token Slack gave this person after they approved the app. */
export async function saveSlackConnection(profileId: string, conn: { slackUserId: string; teamId: string; token: string; scopes: string }) {
  const { error } = await createAdminClient()
    .from("slack_user_tokens")
    .upsert(
      { profile_id: profileId, slack_user_id: conn.slackUserId, team_id: conn.teamId, token: conn.token, scopes: conn.scopes, created_at: new Date().toISOString() },
      { onConflict: "profile_id" },
    );
  if (error) throw new Error(error.message);
}

/** Forget this person's Slack. Also tells Slack to revoke the token so it can't be used anywhere. */
export async function disconnect(profileId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("slack_user_tokens").select("token").eq("profile_id", profileId).maybeSingle();
  // Revoking is a courtesy: if Slack is down or the token is already dead, still forget it here
  if (data?.token) await call(data.token, "auth.revoke", {}).catch(() => undefined);
  await admin.from("slack_user_tokens").delete().eq("profile_id", profileId);
}

/**
 * A read-only Slack call as this person (their own connection, so it lists what they can post to), else as the Kaizen
 * app. For the report send step's channel and thread picker.
 */
export async function slackReadAs(profileId: string, method: "users.conversations" | "conversations.history" | "conversations.info" | "conversations.replies", params: Record<string, string>): Promise<SlackBody | null> {
  const { data: row } = await createAdminClient().from("slack_user_tokens").select("token").eq("profile_id", profileId).maybeSingle();
  const token = (row?.token as string | undefined) ?? process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  return call(token, method, params).catch(() => null);
}

async function call(token: string, method: string, params: Record<string, string>): Promise<SlackBody> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params),
      cache: "no-store",
    });
    if (res.status === 429) {
      // Rate limited: wait as long as Slack says, then try again
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 3) * 1000));
      continue;
    }
    return (await res.json()) as SlackBody;
  }
  return { ok: false, error: "ratelimited" };
}

// Slack's error codes, in words the person can act on. Token problems mean "connect again".
function explain(error: string | undefined): { ok: false; error: string; needsConnect?: boolean } {
  switch (error) {
    case "not_in_channel":
      return { ok: false, error: "You're not in that client channel in Slack yet. Join it, then send again." };
    case "channel_not_found":
      return { ok: false, error: "Slack can't find that client channel. It may have been renamed, archived or made private without you in it." };
    case "user_not_found":
    case "cannot_dm_bot":
    case "user_disabled":
      return { ok: false, error: "Slack can't find that person to message. They may have left the workspace." };
    case "is_archived":
      return { ok: false, error: "That client channel is archived in Slack." };
    case "missing_scope":
      return { ok: false, error: "Reconnect Slack to allow posting.", needsConnect: true };
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return { ok: false, error: "Your Slack connection has expired. Connect your Slack again.", needsConnect: true };
    case "ratelimited":
      return { ok: false, error: "Slack is busy right now. Try again in a minute." };
    default:
      return { ok: false, error: `Slack couldn't post it (${error ?? "no reason given"}).` };
  }
}

/** threadMissing: a thread was asked for but is gone (deleted, or the channel's history doesn't have it), so it posted in the channel */
type PostResult = { ok: true; ts: string; channel: string; permalink?: string; thread?: string; threadMissing?: boolean } | { ok: false; error: string; needsConnect?: boolean };

/**
 * Post a message to a channel as this person. Text is Slack mrkdwn. With a PDF, the file and the
 * text go up together as one message (the text is the file's comment), using Slack's current upload flow.
 */
export async function postAsUser(
  profileId: string,
  { channel, text, pdf, thread, broadcast }: { channel: string; text: string; pdf?: { filename: string; title: string; bytes: Uint8Array }; /** Reply in this thread */ thread?: string; /** The reply also shown in the channel */ broadcast?: boolean },
): Promise<PostResult> {
  const { data: row } = await createAdminClient().from("slack_user_tokens").select("token").eq("profile_id", profileId).maybeSingle();
  if (!row?.token) return { ok: false, error: "Connect your Slack first, so it goes out from you.", needsConnect: true };
  const token = row.token as string;
  // A person (U..., W...): the DM between them, opened as this person (im:write); without that scope Slack still takes
  // the user's ID and posts to the same DM
  const to = !thread && /^[UW][A-Z0-9]{6,}$/.test(channel.trim()) ? await openDm(token, channel.trim()) : channel;
  return postWith(token, { channel: to, text, pdf, thread, broadcast });
}

/** The DM channel (D...) between the token's person and this Slack user, else the user's ID as given */
async function openDm(token: string, user: string): Promise<string> {
  const r = await call(token, "conversations.open", { users: user, return_im: "false" }).catch(() => null);
  const id = (r?.channel as { id?: string } | undefined)?.id;
  return r?.ok && id ? id : user;
}

/**
 * Post to this person's own self-DM ("message to yourself"). Their self-DM's real channel (D...) first: opened as them
 * (im:write) or found among their DMs (im:read, which a read connection has). A post to their bare user ID without it
 * can land in their Slackbot DM instead, so that's the last resort only.
 */
export async function postToSelf(profileId: string, text: string): Promise<PostResult> {
  const { data: row } = await createAdminClient().from("slack_user_tokens").select("token, scopes, slack_user_id").eq("profile_id", profileId).maybeSingle();
  if (!row?.token || !row.slack_user_id) return { ok: false, error: "Connect your Slack first, so the draft lands in your own messages.", needsConnect: true };
  const token = row.token as string;
  const me = String(row.slack_user_id);
  const scopes = String(row.scopes ?? "").split(/[\s,]+/);
  const channel = (await selfDm(token, me, scopes)) ?? me;
  return postWith(token, { channel, text });
}

/** Their self-DM's channel (D...), or null when the token can neither open nor list DMs */
async function selfDm(token: string, me: string, scopes: string[]): Promise<string | null> {
  if (scopes.includes("im:write")) {
    const r = await call(token, "conversations.open", { users: me, return_im: "false" }).catch(() => null);
    const id = (r?.channel as { id?: string } | undefined)?.id;
    if (r?.ok && id) return id;
  }
  if (!scopes.includes("im:read")) return null;
  const { selfDmChannel } = await import("@/lib/assistant/platform-drafts-core");
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const r = await slackRead<{ ok: boolean; error?: string; channels?: { id?: string; user?: string }[]; response_metadata?: { next_cursor?: string } }>(token, "conversations.list", { types: "im", limit: "1000", ...(cursor ? { cursor } : {}) }).catch(() => null);
    if (!r?.ok) return null;
    const hit = selfDmChannel(r.channels ?? [], me);
    if (hit) return hit;
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) return null;
  }
  return null;
}

/** Post as the Kaizen app itself (its bot): a joint report, or when a person can't. Needs chat:write (files:write for a PDF). */
/** A Slack person or direct message rather than a channel */
export const isPersonChannel = (channel: string) => /^[UWD][A-Z0-9]{6,}$/.test(channel.trim());

export async function postAsApp(args: { channel: string; text: string; pdf?: { filename: string; title: string; bytes: Uint8Array }; thread?: string; broadcast?: boolean }): Promise<PostResult> {
  // Team members hear from Kaizen OS in Kaizen OS (bell, Overview, email), never as a Slack DM from the app. A person
  // (U..., W...) or a direct message (D...) is refused; client channels still get their client notices.
  if (isPersonChannel(args.channel)) return { ok: false, error: "Team messages stay in Kaizen OS." };
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "The Kaizen Slack app isn't connected." };
  return postWith(token, args);
}

/** How someone shows in Slack (their name and photo), for previewing a message as it will look. */
export async function slackIdentity(profileId: string): Promise<{ name: string; image: string | null } | null> {
  const { data } = await createAdminClient().from("slack_user_tokens").select("slack_user_id, token").eq("profile_id", profileId).maybeSingle();
  if (!data) return null;
  const token = process.env.SLACK_BOT_TOKEN || (data.token as string);
  const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(data.slack_user_id as string)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { ok?: boolean; user?: { real_name?: string; profile?: { display_name?: string; real_name?: string; image_72?: string; image_192?: string } } } | null) : null;
  if (!body?.ok || !body.user) return { name: "", image: null };
  const p = body.user.profile ?? {};
  return { name: p.display_name || p.real_name || body.user.real_name || "", image: p.image_192 || p.image_72 || null };
}

async function postWith(token: string, { channel, text, pdf, thread: asked, broadcast }: { channel: string; text: string; pdf?: { filename: string; title: string; bytes: Uint8Array }; thread?: string; broadcast?: boolean }): Promise<PostResult> {
  try {
    // A thread that's gone (deleted, or not in this channel) posts in the channel instead, and says so
    const live = asked ? await threadExists(token, channel, asked) : false;
    const thread = asked && live ? asked : undefined;
    const missing = Boolean(asked && !live);
    if (!pdf) {
      const sent = await call(token, "chat.postMessage", { channel, text, unfurl_links: "false", unfurl_media: "false", ...(thread ? { thread_ts: thread, ...(broadcast ? { reply_broadcast: "true" } : {}) } : {}) });
      if (!sent.ok) return explain(sent.error);
      const ts = String(sent.ts ?? "");
      const ch = String(sent.channel ?? channel);
      return { ok: true, ts, channel: ch, permalink: await permalink(token, ch, ts), ...(thread ? { thread } : {}), ...(missing ? { threadMissing: true } : {}) };
    }

    // 1. Ask Slack where to put the file
    const slot = await call(token, "files.getUploadURLExternal", { filename: pdf.filename, length: String(pdf.bytes.byteLength) });
    if (!slot.ok) return explain(slot.error);
    const fileId = String(slot.file_id);

    // 2. Send the bytes there (the upload URL itself is the credential, no token needed)
    const up = await fetch(String(slot.upload_url), {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: new Blob([pdf.bytes as BlobPart], { type: "application/pdf" }),
    });
    if (!up.ok) return { ok: false, error: `Slack didn't accept the PDF upload (${up.status}).` };

    // 3. Share it in the channel with the message as its comment, so both arrive as one post from the person
    const done = await call(token, "files.completeUploadExternal", {
      files: JSON.stringify([{ id: fileId, title: pdf.title }]),
      channel_id: channel,
      initial_comment: text,
      // The PDF and its message go into the thread too
      ...(thread ? { thread_ts: thread } : {}),
    });
    if (!done.ok) return explain(done.error);
    // A file reply can't be broadcast by itself: "also send to the channel" adds a short pointer to it there
    if (thread && broadcast) await call(token, "chat.postMessage", { channel, thread_ts: thread, reply_broadcast: "true", text: text.split("\n").find((l) => l.trim() && !/^<!here>\s*$/.test(l.trim()))?.slice(0, 300) ?? "The report is in the thread." }).catch(() => null);

    // The share happens a moment after Slack answers, so the message's ts may not be known yet: look a few times
    const ts = await shareTs(token, fileId, channel);
    return { ok: true, ts, channel, permalink: ts ? await permalink(token, channel, ts) : undefined, ...(thread ? { thread } : {}), ...(missing ? { threadMissing: true } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `Couldn't reach Slack: ${e.message}` : "Couldn't reach Slack." };
  }
}

/** Whether a thread's first message is still there in this channel (one quick read) */
async function threadExists(token: string, channel: string, ts: string): Promise<boolean> {
  const r = await call(token, "conversations.replies", { channel, ts, limit: "1" }).catch(() => null);
  return Boolean(r?.ok && Array.isArray(r.messages) && (r.messages as unknown[]).length);
}

type Shares = Record<string, { ts: string }[]>;

async function shareTs(token: string, fileId: string, channel: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 750 * attempt));
    const info = await call(token, "files.info", { file: fileId }).catch(() => null);
    const shares = (info?.file as { shares?: { public?: Shares; private?: Shares } } | undefined)?.shares;
    const ts = shares?.public?.[channel]?.[0]?.ts ?? shares?.private?.[channel]?.[0]?.ts;
    if (ts) return ts;
  }
  return "";
}

async function permalink(token: string, channel: string, ts: string): Promise<string | undefined> {
  if (!ts) return undefined;
  const res = await call(token, "chat.getPermalink", { channel, message_ts: ts }).catch(() => null);
  return res?.ok ? String(res.permalink) : undefined;
}
