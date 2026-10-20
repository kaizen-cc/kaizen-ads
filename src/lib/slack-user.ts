import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Posting to Slack as a person, not the bot. Each team member connects their own Slack once
// (/api/slack/connect) and Kaizen Ads keeps their user token in slack_user_tokens (server-only,
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

type PostResult = { ok: true; ts: string; channel: string; permalink?: string } | { ok: false; error: string; needsConnect?: boolean };

/**
 * Post a message to a channel as this person. Text is Slack mrkdwn. With a PDF, the file and the
 * text go up together as one message (the text is the file's comment), using Slack's current upload flow.
 */
export async function postAsUser(
  profileId: string,
  { channel, text, pdf }: { channel: string; text: string; pdf?: { filename: string; title: string; bytes: Uint8Array } },
): Promise<PostResult> {
  const { data: row } = await createAdminClient().from("slack_user_tokens").select("token").eq("profile_id", profileId).maybeSingle();
  if (!row?.token) return { ok: false, error: "Connect your Slack first, so the report goes out from you.", needsConnect: true };
  const token = row.token as string;

  try {
    if (!pdf) {
      const sent = await call(token, "chat.postMessage", { channel, text, unfurl_links: "false", unfurl_media: "false" });
      if (!sent.ok) return explain(sent.error);
      const ts = String(sent.ts ?? "");
      const ch = String(sent.channel ?? channel);
      return { ok: true, ts, channel: ch, permalink: await permalink(token, ch, ts) };
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
    });
    if (!done.ok) return explain(done.error);

    // The share happens a moment after Slack answers, so the message's ts may not be known yet: look a few times
    const ts = await shareTs(token, fileId, channel);
    return { ok: true, ts, channel, permalink: ts ? await permalink(token, channel, ts) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `Couldn't reach Slack: ${e.message}` : "Couldn't reach Slack." };
  }
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
