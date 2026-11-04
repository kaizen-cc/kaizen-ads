import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slack, type SlackMessage } from "@/lib/context/slack";
import { siteUrl } from "@/lib/site";

// The client's Slack channel, inside their portal. Messages are copied from Slack into portal_chat_messages (read on
// demand while someone has the chat open, and pushed by Slack's events when those are switched on), so the portal
// reads its own table and Slack is asked at most every few seconds per channel. A client writing in the portal posts
// into the channel through the Kaizen app, under their own name and picture (chat:write.customize); without that
// scope the message starts with their name instead. Files go up through Slack's upload flow (files:write) and come
// back down through our own server, so Slack's token never reaches the browser.

export type ChatFile = { id: string; name: string; mime: string; size: number; kind: "image" | "video" | "file"; w: number | null; h: number | null };
export type ChatMessage = {
  ts: string;
  threadTs: string | null;
  author: string;
  avatar: string | null;
  /** Our team, or the client's side (a contact in the portal, or someone of theirs in the shared channel) */
  side: "team" | "client";
  fromPortal: boolean;
  /** Written by the person reading (their own portal messages) */
  mine: boolean;
  text: string;
  files: ChatFile[];
  replyCount: number;
  latestReply: string | null;
  edited: boolean;
  at: string;
};

type Admin = SupabaseClient;
type StoredFile = ChatFile & { url: string | null; thumb: string | null };
type Row = {
  client_id: string;
  channel: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  from_team: boolean;
  from_portal: boolean;
  contact_id: string | null;
  text: string;
  files: StoredFile[];
  reply_count: number;
  latest_reply: string | null;
  edited: boolean;
  deleted: boolean;
  sent_at: string;
};

type SlackFile = { id: string; name?: string; title?: string; mimetype?: string; size?: number; url_private?: string; thumb_720?: string; thumb_480?: string; original_w?: number; original_h?: number; mode?: string };
type FullMessage = SlackMessage & {
  username?: string;
  icons?: { image_48?: string; image_72?: string };
  files?: SlackFile[];
  edited?: { ts: string };
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
  bot_profile?: { name?: string; icons?: { image_72?: string } };
  user_profile?: { real_name?: string; display_name?: string; image_72?: string; team?: string };
};

const PORTAL_EVENT = "kaizen_portal";
const FIELDS = "ts, thread_ts, author_name, author_avatar, from_team, from_portal, contact_id, text, files, reply_count, latest_reply, edited, sent_at";

// ─── Who wrote it ───

type Person = { name: string; avatar: string | null; team: boolean };
const people = new Map<string, { at: number; p: Person }>();
let ourTeam: { at: number; id: string | null; bot: string | null } | null = null;

/** Our workspace, and the Kaizen app's own bot (its posts are ours, or a client's from the portal) */
async function workspace() {
  if (ourTeam && Date.now() - ourTeam.at < 3_600_000) return ourTeam;
  const r = await slack<{ team_id?: string; bot_id?: string }>("auth.test", {}).catch(() => null);
  ourTeam = { at: Date.now(), id: r?.team_id ?? null, bot: r?.bot_id ?? null };
  return ourTeam;
}
const workspaceId = async () => (await workspace()).id;

/** A Slack user's name and picture, and whether they're on our team (a full member of our workspace) or the client's */
async function person(id: string): Promise<Person> {
  const hit = people.get(id);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.p;
  const [team, info] = await Promise.all([
    workspaceId(),
    slack<{ user?: { team_id?: string; real_name?: string; is_bot?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; profile?: { display_name?: string; real_name?: string; image_72?: string; image_192?: string } } }>("users.info", { user: id }).catch(() => null),
  ]);
  const u = info?.user;
  const p: Person = {
    name: u?.profile?.display_name || u?.profile?.real_name || u?.real_name || "Someone",
    avatar: u?.profile?.image_192 || u?.profile?.image_72 || null,
    team: Boolean(u && !u.is_restricted && !u.is_ultra_restricted && (!team || !u.team_id || u.team_id === team)),
  };
  people.set(id, { at: Date.now(), p });
  return p;
}

const EMOJI: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", heart: "❤️", smile: "😄", slightly_smiling_face: "🙂", grinning: "😀", joy: "😂", tada: "🎉", fire: "🔥",
  white_check_mark: "✅", heavy_check_mark: "✔️", raised_hands: "🙌", pray: "🙏", eyes: "👀", rocket: "🚀", "100": "💯", clap: "👏", wave: "👋",
  ok_hand: "👌", muscle: "💪", star: "⭐", sparkles: "✨", point_right: "👉", point_down: "👇", warning: "⚠️", x: "❌", thinking_face: "🤔",
  sweat_smile: "😅", blush: "😊", heart_eyes: "😍", sob: "😭", partying_face: "🥳", money_with_wings: "💸", chart_with_upwards_trend: "📈",
  calendar: "📅", memo: "📝", bulb: "💡", camera: "📷", movie_camera: "🎥", link: "🔗", phone: "📞", email: "📧", gift: "🎁", shrimp: "🦐", fish: "🐟",
};

/** Slack's markup made readable: people and channels by name, emoji as emoji (links stay as <url|label> for the page to draw) */
async function readable(text: string) {
  let out = text;
  for (const m of [...new Set([...out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((x) => x[1]))]) out = out.replaceAll(new RegExp(`<@${m}(?:\\|[^>]*)?>`, "g"), `@${(await person(m)).name}`);
  out = out.replace(/<#C[A-Z0-9]+\|([^>]*)>/g, "#$1").replace(/<!(here|channel|everyone)>/g, "@$1").replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, "$1");
  return out.replace(/:([a-z0-9_+-]+):/g, (all, code: string) => EMOJI[code] ?? all);
}

function fileOf(f: SlackFile): StoredFile {
  const mime = f.mimetype ?? "application/octet-stream";
  return {
    id: f.id,
    name: f.title || f.name || "file",
    mime,
    size: f.size ?? 0,
    kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
    w: f.original_w ?? null,
    h: f.original_h ?? null,
    url: f.url_private ?? null,
    thumb: f.thumb_720 ?? f.thumb_480 ?? null,
  };
}

/** One Slack message as a row: who (the portal's own posts by the name they carry), the text, files and thread */
async function toRow(clientId: string, channel: string, m: FullMessage): Promise<Row | null> {
  if (m.subtype && !["thread_broadcast", "bot_message", "file_share", "me_message"].includes(m.subtype)) return null;
  // A thread's replies sent back to the channel show once, in the thread
  if (m.subtype === "thread_broadcast") m = { ...m, subtype: undefined };
  let portal = m.metadata?.event_type === PORTAL_EVENT ? (m.metadata.event_payload ?? {}) : null;
  // Files from the portal go up through Slack's upload flow, which can't carry our mark: our own app's post that
  // starts with "*Name* (via the portal)" is that client's (only ever the app's own posts, never a person's)
  const said = !portal && m.bot_id && m.bot_id === (await workspace()).bot ? (m.text ?? "").match(/^\*([^*]+)\* \(via the portal\)/) : null;
  if (said) portal = { name: said[1] };
  let author: string;
  let avatar: string | null;
  let team: boolean;
  if (portal) {
    author = String(portal.name ?? m.username ?? "Client");
    avatar = (portal.avatar as string | undefined) ?? m.icons?.image_72 ?? null;
    team = Boolean(portal.team);
  } else if (m.user) {
    const p = await person(m.user);
    author = p.name;
    avatar = p.avatar;
    team = p.team;
  } else {
    // The Kaizen app's own posts (welcomes, reports) and other integrations: on our side
    author = m.username || m.bot_profile?.name || "Kaizen";
    avatar = m.icons?.image_72 ?? m.bot_profile?.icons?.image_72 ?? null;
    team = true;
  }
  let text = await readable(m.text ?? "");
  // Posted without the name-and-picture permission: the text starts with their name, which the portal doesn't need
  if (portal) text = text.replace(/^\*[^*]+\* \(via the portal\):?\s*/, "");
  const files = (m.files ?? []).filter((f) => f.mode !== "tombstone" && f.id).map(fileOf);
  if (!text.trim() && !files.length) return null;
  return {
    client_id: clientId,
    channel,
    ts: m.ts,
    thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
    user_id: m.user ?? null,
    author_name: author,
    author_avatar: avatar,
    from_team: team,
    from_portal: Boolean(portal),
    contact_id: portal && typeof portal.contact_id === "string" && /^[0-9a-f-]{36}$/.test(portal.contact_id) ? portal.contact_id : null,
    text,
    files,
    reply_count: m.reply_count ?? 0,
    latest_reply: m.latest_reply ?? null,
    edited: Boolean(m.edited),
    deleted: false,
    sent_at: new Date(Number(m.ts) * 1000).toISOString(),
  };
}

async function save(admin: Admin, rows: Row[]) {
  if (!rows.length) return;
  // A portal post read back from Slack without its mark (files) keeps who sent it, as saved when it was sent
  const blind = rows.filter((r) => r.from_portal && !r.contact_id);
  if (blind.length) {
    const { data: had } = await admin.from("portal_chat_messages").select("ts, contact_id, author_avatar, from_team").eq("channel", blind[0]!.channel).in("ts", blind.map((r) => r.ts));
    for (const r of blind) {
      const h = (had ?? []).find((x) => x.ts === r.ts);
      if (!h) continue;
      r.contact_id = (h.contact_id as string | null) ?? null;
      r.author_avatar = r.author_avatar ?? ((h.author_avatar as string | null) ?? null);
      r.from_team = Boolean(h.from_team);
    }
  }
  await admin.from("portal_chat_messages").upsert(rows, { onConflict: "channel,ts" });
}

// ─── Reading Slack ───

/** How often a channel is read again while someone has the chat open: often, unless Slack's events are pushing them */
async function pause(admin: Admin) {
  const { data } = await admin.from("app_settings").select("value").eq("key", "slack_events").maybeSingle();
  const at = (data?.value as { at?: string } | null)?.at;
  return at && Date.now() - Date.parse(at) < 10 * 60_000 ? 60_000 : 5_000;
}

/** Bring the channel up to date: new messages, recent edits and deletions, and threads with new replies */
export async function syncChannel(admin: Admin, clientId: string, channel: string, force = false) {
  const { data: state } = await admin.from("portal_chat_state").select("synced_at, channel").eq("client_id", clientId).maybeSingle();
  const wait = force ? 0 : await pause(admin);
  if (state?.channel === channel && state.synced_at && Date.now() - Date.parse(state.synced_at) < wait) return;
  const now = new Date().toISOString();
  await admin.from("portal_chat_state").upsert({ client_id: clientId, channel, synced_at: now, updated_at: now, ...(state?.channel && state.channel !== channel ? { oldest_ts: null, has_more: true } : {}) });

  const { data: newest } = await admin.from("portal_chat_messages").select("ts").eq("channel", channel).is("thread_ts", null).order("ts", { ascending: false }).limit(1).maybeSingle();
  // The last three days again (edits, deletions, new replies on recent threads), or the latest page the first time
  const oldest = newest ? (Number(newest.ts) - 3 * 86_400).toFixed(6) : null;
  const page = await slack<{ messages: FullMessage[]; has_more?: boolean }>("conversations.history", { channel, limit: oldest ? "200" : "50", include_all_metadata: "true", ...(oldest ? { oldest } : {}) });
  const rows: Row[] = [];
  for (const m of page.messages) {
    const r = await toRow(clientId, channel, m);
    if (r) rows.push(r);
  }
  // Threads with replies we haven't seen yet
  const { data: known } = rows.length ? await admin.from("portal_chat_messages").select("ts, latest_reply").eq("channel", channel).in("ts", rows.map((r) => r.ts)) : { data: [] };
  const seen = new Map((known ?? []).map((k) => [k.ts as string, (k.latest_reply as string | null) ?? null]));
  for (const r of rows.filter((x) => x.reply_count && x.latest_reply && x.latest_reply !== seen.get(x.ts)).slice(0, 8)) await syncThread(admin, clientId, channel, r.ts);
  await save(admin, rows);
  // Gone from Slack inside the window we just read: deleted there
  if (oldest && !page.has_more) {
    const kept = new Set(page.messages.map((m) => m.ts));
    const { data: window } = await admin.from("portal_chat_messages").select("ts").eq("channel", channel).is("thread_ts", null).eq("deleted", false).gte("ts", oldest);
    const gone = (window ?? []).map((w) => w.ts as string).filter((ts) => !kept.has(ts));
    if (gone.length) await admin.from("portal_chat_messages").update({ deleted: true }).eq("channel", channel).in("ts", gone);
  }
  if (!newest) await admin.from("portal_chat_state").update({ oldest_ts: page.messages.at(-1)?.ts ?? null, has_more: Boolean(page.has_more) }).eq("client_id", clientId);
}

/** A thread's replies */
export async function syncThread(admin: Admin, clientId: string, channel: string, ts: string) {
  const { messages } = await slack<{ messages: FullMessage[] }>("conversations.replies", { channel, ts, limit: "200", include_all_metadata: "true" });
  const rows: Row[] = [];
  for (const m of messages) {
    const r = await toRow(clientId, channel, m);
    if (r) rows.push(r);
  }
  await save(admin, rows);
}

/** Older history, a page at a time, as the reader scrolls up */
export async function loadOlder(admin: Admin, clientId: string, channel: string) {
  const { data: state } = await admin.from("portal_chat_state").select("oldest_ts, has_more").eq("client_id", clientId).maybeSingle();
  if (state && !state.has_more) return false;
  const latest = (state?.oldest_ts as string | null) ?? undefined;
  const page = await slack<{ messages: FullMessage[]; has_more?: boolean }>("conversations.history", { channel, limit: "50", include_all_metadata: "true", ...(latest ? { latest } : {}) });
  const rows: Row[] = [];
  for (const m of page.messages) {
    const r = await toRow(clientId, channel, m);
    if (r) rows.push(r);
  }
  await save(admin, rows);
  await admin.from("portal_chat_state").upsert({ client_id: clientId, channel, oldest_ts: page.messages.at(-1)?.ts ?? latest ?? null, has_more: Boolean(page.has_more), updated_at: new Date().toISOString() });
  return Boolean(page.has_more);
}

// ─── What the portal reads ───

type Stored = { ts: string; thread_ts: string | null; author_name: string | null; author_avatar: string | null; from_team: boolean; from_portal: boolean; contact_id: string | null; text: string; files: StoredFile[]; reply_count: number; latest_reply: string | null; edited: boolean; sent_at: string };

function view(r: Stored, readerId: string | null): ChatMessage {
  return {
    ts: r.ts,
    threadTs: r.thread_ts,
    author: r.author_name ?? "Someone",
    avatar: r.author_avatar,
    side: r.from_team ? "team" : "client",
    fromPortal: r.from_portal,
    mine: Boolean(readerId && r.contact_id === readerId),
    text: r.text,
    // The Slack links stay on the server: the page gets ours
    files: (r.files ?? []).map(({ id, name, mime, size, kind, w, h }) => ({ id, name, mime, size, kind, w, h })),
    replyCount: r.reply_count,
    latestReply: r.latest_reply,
    edited: r.edited,
    at: r.sent_at,
  };
}

/** The channel's top-level messages (newest page, newer than a point, or older than one), oldest first */
export async function listMessages(db: Admin, clientId: string, o: { after?: string | null; before?: string | null; readerId: string | null; limit?: number }) {
  let q = db.from("portal_chat_messages").select(FIELDS).eq("client_id", clientId).is("thread_ts", null).eq("deleted", false);
  if (o.after) q = q.gt("ts", o.after);
  if (o.before) q = q.lt("ts", o.before);
  const { data } = await q.order("ts", { ascending: false }).limit(o.limit ?? 50);
  return ((data ?? []) as Stored[]).reverse().map((r) => view(r, o.readerId));
}

/** A thread: the message and its replies, oldest first */
export async function listThread(db: Admin, clientId: string, ts: string, readerId: string | null) {
  const { data } = await db.from("portal_chat_messages").select(FIELDS).eq("client_id", clientId).eq("deleted", false).or(`ts.eq.${ts},thread_ts.eq.${ts}`).order("ts", { ascending: true }).limit(300);
  return ((data ?? []) as Stored[]).map((r) => view(r, readerId));
}

/** Messages from our team the reader hasn't seen (the badge) */
export async function unreadCount(db: Admin, clientId: string, readerId: string) {
  const { data: read } = await db.from("portal_chat_reads").select("last_read_ts").eq("client_id", clientId).eq("reader_id", readerId).maybeSingle();
  let q = db.from("portal_chat_messages").select("ts", { count: "exact", head: true }).eq("client_id", clientId).eq("deleted", false).eq("from_team", true);
  // Never opened: only the last two weeks count, not the channel's whole history
  q = read?.last_read_ts ? q.gt("ts", read.last_read_ts as string) : q.gte("sent_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
  const { count } = await q;
  return count ?? 0;
}

export async function markRead(db: Admin, clientId: string, readerId: string, ts: string) {
  const { data: read } = await db.from("portal_chat_reads").select("last_read_ts").eq("client_id", clientId).eq("reader_id", readerId).maybeSingle();
  if (read?.last_read_ts && read.last_read_ts >= ts) return;
  await db.from("portal_chat_reads").upsert({ client_id: clientId, reader_id: readerId, last_read_ts: ts, updated_at: new Date().toISOString() });
}

/** Our link for a file in this client's chat, after checking it's theirs (the page never sees Slack's) */
export async function chatFile(db: Admin, clientId: string, fileId: string) {
  const { data } = await db.from("portal_chat_messages").select("files").eq("client_id", clientId).contains("files", [{ id: fileId }]).limit(1).maybeSingle();
  return ((data?.files ?? []) as StoredFile[]).find((f) => f.id === fileId) ?? null;
}

// ─── Writing from the portal ───

let scopes: { at: number; list: string[] } | null = null;
/** The Kaizen app's Slack permissions (read from any call's headers), to know whether posts can carry a name and picture */
export async function botScopes() {
  if (scopes && Date.now() - scopes.at < 600_000) return scopes.list;
  const res = await fetch("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, cache: "no-store" }).catch(() => null);
  const list = (res?.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  scopes = { at: Date.now(), list };
  return list;
}
export const PORTAL_SCOPES = ["chat:write", "chat:write.customize", "files:write", "files:read", "channels:history", "groups:history", "users:read"];

async function post(method: string, body: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 2) * 1000));
      continue;
    }
    return (await res.json()) as { ok: boolean; error?: string; ts?: string; files?: { id: string }[] };
  }
  return { ok: false, error: "ratelimited" };
}

/** A picture for someone with no photo: their initials on our red, drawn by our own route (Slack fetches it) */
export const initialsAvatar = (name: string) =>
  `${siteUrl()}/api/portal-chat/avatar?i=${encodeURIComponent(
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?",
  )}`;

export type Upload = { name: string; mime: string; bytes: Uint8Array };

/**
 * A message from the portal, into the channel: as the Kaizen app under the writer's name and picture, marked as the
 * portal's (so it shows as theirs here and the team's chasing treats it as the client's). Files go up together with
 * the text as one post. Returns the message as the portal shows it.
 */
export async function postFromPortal(
  admin: Admin,
  c: { id: string; channel: string },
  who: { contactId: string | null; name: string; avatar: string | null; team: boolean },
  m: { text: string; thread: string | null; files: Upload[] },
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false, error: "Chat isn't connected yet." };
  const custom = (await botScopes()).includes("chat:write.customize");
  const avatar = who.avatar ?? initialsAvatar(who.name);
  const text = m.text.trim();
  const shown = custom ? text : `*${who.name}* (via the portal): ${text}`;
  const metadata = { event_type: PORTAL_EVENT, event_payload: { contact_id: who.contactId ?? "", name: who.name, avatar, team: who.team } };
  let ts = "";
  if (!m.files.length) {
    const r = await post("chat.postMessage", { channel: c.channel, text: shown, unfurl_links: false, unfurl_media: false, ...(m.thread ? { thread_ts: m.thread } : {}), ...(custom ? { username: who.name, icon_url: avatar } : {}), metadata });
    if (!r.ok) return { ok: false, error: explain(r.error) };
    ts = r.ts ?? "";
  } else {
    // Each file up, then shared in the channel together with the text as its comment
    const ids: { id: string; title: string }[] = [];
    for (const f of m.files) {
      const res = await fetch(`https://slack.com/api/files.getUploadURLExternal?${new URLSearchParams({ filename: f.name, length: String(f.bytes.byteLength) })}`, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, cache: "no-store" });
      const s = (await res.json()) as { ok: boolean; error?: string; upload_url?: string; file_id?: string };
      if (!s.ok || !s.upload_url || !s.file_id) return { ok: false, error: explain(s.error) };
      const up = await fetch(s.upload_url, { method: "POST", headers: { "content-type": f.mime || "application/octet-stream" }, body: new Blob([f.bytes as BlobPart], { type: f.mime }) });
      if (!up.ok) return { ok: false, error: "Slack didn't take the file. Try again." };
      ids.push({ id: s.file_id, title: f.name });
    }
    // The upload's comment can't carry a name and picture, so it always says who it's from
    const comment = `*${who.name}* (via the portal)${text ? `: ${text}` : ""}`;
    const done = await post("files.completeUploadExternal", { files: ids, channel_id: c.channel, initial_comment: comment, ...(m.thread ? { thread_ts: m.thread } : {}) });
    if (!done.ok) return { ok: false, error: explain(done.error) };
    ts = await sharedTs(c.channel, ids[0]!.id);
  }
  // Shown at once in the portal, as theirs; the next read of the channel fills in the rest (files, exact text)
  if (ts) {
    const now = new Date(Number(ts) * 1000).toISOString();
    await admin.from("portal_chat_messages").upsert(
      {
        client_id: c.id,
        channel: c.channel,
        ts,
        thread_ts: m.thread,
        user_id: null,
        author_name: who.name,
        author_avatar: avatar,
        from_team: who.team,
        from_portal: true,
        contact_id: who.contactId,
        text,
        files: [],
        reply_count: 0,
        latest_reply: null,
        edited: false,
        deleted: false,
        sent_at: now,
      },
      { onConflict: "channel,ts" },
    );
    if (m.thread) await syncThread(admin, c.id, c.channel, m.thread).catch(() => null);
  }
  // Files: read back so they show with their real names and previews
  if (m.files.length) await syncChannel(admin, c.id, c.channel, true).catch(() => null);
  return { ok: true, ts };
}

async function sharedTs(channel: string, fileId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
    const info = await slack<{ file?: { shares?: { public?: Record<string, { ts: string }[]>; private?: Record<string, { ts: string }[]> } } }>("files.info", { file: fileId }).catch(() => null);
    const ts = info?.file?.shares?.public?.[channel]?.[0]?.ts ?? info?.file?.shares?.private?.[channel]?.[0]?.ts;
    if (ts) return ts;
  }
  return "";
}

function explain(error?: string) {
  switch (error) {
    case "not_in_channel":
    case "channel_not_found":
      return "The chat isn't connected to your channel right now. Your team has been told.";
    case "is_archived":
      return "This chat's channel was archived. Your team can set up a new one.";
    case "missing_scope":
      return "The chat can't send yet: your team needs to finish connecting it.";
    case "ratelimited":
      return "Slow down a little: try again in a moment.";
    default:
      return "Couldn't send that. Try again in a moment.";
  }
}

// ─── Slack's events (when switched on) ───

/** A message event from Slack: saved straight away, so the portal shows it without waiting for the next read */
export async function onSlackEvent(admin: Admin, e: { type: string; subtype?: string; channel?: string; ts?: string; message?: FullMessage; previous_message?: FullMessage; deleted_ts?: string } & FullMessage) {
  if (e.type !== "message" || !e.channel) return;
  const { data: c } = await admin.from("clients").select("id").eq("slack_channel_id", e.channel).maybeSingle();
  if (!c) return;
  const now = new Date().toISOString();
  await admin.from("app_settings").upsert({ key: "slack_events", value: { at: now }, updated_at: now });
  if (e.subtype === "message_deleted" && e.deleted_ts) {
    await admin.from("portal_chat_messages").update({ deleted: true }).eq("channel", e.channel).eq("ts", e.deleted_ts);
    return;
  }
  const m = e.subtype === "message_changed" ? e.message : e;
  if (!m?.ts) return;
  const row = await toRow(c.id as string, e.channel, m);
  if (row) await save(admin, [row]);
  // A reply: the thread's count and latest reply on its first message
  if (row?.thread_ts) await syncThread(admin, c.id as string, e.channel, row.thread_ts).catch(() => null);
}

/**
 * An email when our team wrote in their chat and they haven't looked: hourly, for messages that have sat unread
 * between one and two hours (so each burst emails once). Off until switched on (app_settings portal_chat_digest),
 * and never to a real client before client outreach is launched to them.
 */
export async function chatDigest(admin: Admin) {
  const { data: s } = await admin.from("app_settings").select("value").eq("key", "portal_chat_digest").maybeSingle();
  if (!(s?.value as { on?: boolean } | null)?.on) return "off";
  const from = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const to = new Date(Date.now() - 3_600_000).toISOString();
  const { data: fresh } = await admin.from("portal_chat_messages").select("client_id").eq("from_team", true).eq("deleted", false).gte("sent_at", from).lt("sent_at", to);
  const ids = [...new Set((fresh ?? []).map((r) => r.client_id as string))];
  const { autoOutreach } = await import("@/lib/client-outreach");
  const { sendEmail } = await import("@/lib/email");
  const { emailHtml, emailText } = await import("@/lib/email-layout");
  let sent = 0;
  for (const clientId of ids) {
    if (!(await autoOutreach(admin, clientId))) continue;
    const [{ data: c }, { data: links }] = await Promise.all([
      admin.from("clients").select("name, slug, portal_live").eq("id", clientId).single(),
      admin.from("contact_clients").select("contacts(id, email, full_name, is_active)").eq("client_id", clientId),
    ]);
    if (!c?.portal_live) continue;
    for (const l of links ?? []) {
      const p = l.contacts as unknown as { id: string; email: string; full_name: string | null; is_active: boolean } | null;
      if (!p?.is_active || !p.email) continue;
      const n = await unreadCount(admin, clientId, p.id);
      if (!n) continue;
      const parts = { title: `${n} new ${n === 1 ? "message" : "messages"} from your Kaizen team`, hello: p.full_name ? `Hi ${p.full_name.split(" ")[0]},` : undefined, lines: ["Your team wrote to you in your Kaizen portal."], cta: { label: "Open your chat →", url: `${siteUrl()}/c/${c.slug}/chat` } };
      const r = await sendEmail({ to: p.email, subject: parts.title, html: emailHtml(parts), text: emailText(parts) }).catch(() => null);
      if (r?.ok) sent++;
    }
  }
  return `sent ${sent}`;
}

/** Portal-written messages in a channel by ts, for the team's reply chasing (they're posted by the app, not a person) */
export async function portalMessagesIn(admin: Admin, channel: string, since: Date) {
  const { data } = await admin.from("portal_chat_messages").select("ts, author_name").eq("channel", channel).eq("from_portal", true).eq("from_team", false).gte("sent_at", since.toISOString());
  return new Map((data ?? []).map((r) => [r.ts as string, (r.author_name as string | null) ?? "Client"]));
}
