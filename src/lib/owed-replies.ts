import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { LIVE } from "@/lib/live";
import { getCursor, setCursor, trimBody } from "@/lib/context/shared";
import { listChannels, permalink, slack, slackConfigured, type SlackMessage } from "@/lib/context/slack";
import { addresses, gmailToken, google, googleConfigured, plainText, withoutQuotes, type GmailMessage } from "@/lib/context/google";
import { APPROVE_EMOJI, COMMIT, REQUESTISH, clearNotices, followPromises, recordPromises, type Candidate } from "@/lib/message-promises";

// Messages someone on the team owes a reply to. Slack: anyone tagged in a channel the Kaizen OS bot is in, and a
// client's message in their channel with nobody tagged (it's on the people on the account). Email: a client contact
// or a teammate writing to someone directly. Each is watched from when it's asked:
//   1. Still unanswered after a few working hours: the AI checks it really needs something from them, then they get
//      a notice and it's in their day, with a link straight to the message.
//   2. Still unanswered once they've seen that (or a working day after it if they never open it): their lead and the
//      execs are told, and the person gets a second notice saying so.
// A reply in the thread (or, when tagged, a reaction from them) closes it; "Doesn't need a reply" closes it by hand.
// Slack DMs can't be read by the bot, so only channels it's in count.

type Admin = SupabaseClient;
export type Msg = SlackMessage & { reactions?: { name: string; users?: string[] }[] };

const LOOKBACK_DAYS = 7;
const OPEN = ["watching", "nudged", "escalated"];
/** Working hours (weekdays 9–6, New York) before the first notice */
const NUDGE_AFTER = { slack: 3, gmail: 6 } as const;
/** After the first notice: working hours once seen, or in all, before the lead and execs hear */
const ESCALATE_SEEN = 4;
const ESCALATE_UNSEEN = 9;

/** The lead each role answers to (the execs always hear too) */
export const LEAD_OF: Record<string, string | null> = {
  media_buyer: "head_of_meta",
  google_buyer: "head_of_google",
  graphic_designer: "head_of_creative",
  video_editor: "head_of_creative",
  copywriter: "head_of_creative",
  customer_success: null,
  head_of_meta: null,
  head_of_google: null,
  head_of_creative: null,
  executive: null,
};

const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false });
/** Working hours (weekdays 9am–6pm New York) between two moments, to the quarter hour. */
export function workingHours(from: Date, to = new Date()) {
  let n = 0;
  const step = 15 * 60_000;
  // Two weeks is plenty to decide anything here
  const end = Math.min(to.getTime(), from.getTime() + 14 * 86_400_000);
  for (let t = from.getTime(); t < end; t += step) {
    const parts = ny.formatToParts(new Date(t));
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    if (wd !== "Sat" && wd !== "Sun" && h >= 9 && h < 18) n += 0.25;
  }
  return n;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

// ─── Who's who in Slack ─────────────────────────────────────────────────────

type SlackUser = { id: string; deleted?: boolean; is_bot?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; real_name?: string; profile?: { email?: string; real_name?: string; display_name?: string } };

/** Our workspace's people (not guests: those are clients), and each teammate in Kaizen Ads matched to their Slack. */
export type SlackWho = Awaited<ReturnType<typeof slackPeople>>;
async function slackPeople(admin: Admin) {
  const users: SlackUser[] = [];
  let cursor = "";
  do {
    const page = await slack<{ members: SlackUser[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: "500", ...(cursor ? { cursor } : {}) });
    users.push(...page.members);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  const team = new Set(users.filter((u) => !u.deleted && !u.is_bot && !u.is_restricted && !u.is_ultra_restricted).map((u) => u.id));
  const nameOf = new Map(users.map((u) => [u.id, u.real_name || u.profile?.real_name || u.profile?.display_name || "Someone"]));

  const [{ data: people }, { data: tokens }] = await Promise.all([
    admin.from("profiles").select("id, email, full_name, slack_user_id").eq("is_active", true),
    admin.from("slack_user_tokens").select("profile_id, slack_user_id"),
  ]);
  const connected = new Map((tokens ?? []).map((t) => [t.profile_id as string, t.slack_user_id as string]));
  const profileOf = new Map<string, string>();
  for (const p of people ?? []) {
    // Their own Slack connection first, then the email Slack shows (when the app may read it), then the name
    let id = connected.get(p.id) ?? (p.slack_user_id as string | null) ?? null;
    if (!id) id = users.find((u) => !u.deleted && u.profile?.email && u.profile.email.toLowerCase() === String(p.email ?? "").toLowerCase())?.id ?? null;
    if (!id) {
      const same = users.filter((u) => !u.deleted && !u.is_bot && team.has(u.id) && norm(u.real_name || u.profile?.real_name || "") === norm(p.full_name ?? ""));
      if (same.length === 1) id = same[0].id;
    }
    if (!id) continue;
    profileOf.set(id, p.id as string);
    if (id !== p.slack_user_id) await admin.from("profiles").update({ slack_user_id: id }).eq("id", p.id);
  }
  return { team, nameOf, profileOf };
}

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
/** Slack's markup in plain words: tags as names, links as their text */
export const plain = (text: string, nameOf: Map<string, string>) =>
  text
    .replace(MENTION, (_, id: string) => `@${nameOf.get(id) ?? "someone"}`)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1");

// ─── Slack ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Read every channel the bot is in for new tags and client messages; close what's been answered in passing. */
async function scanSlack(admin: Admin) {
  const [who, channels, { data: clients }, { data: assigned }] = await Promise.all([
    slackPeople(admin),
    listChannels(),
    admin.from("clients").select("id, slack_channel_id, internal_slack_channel_id").is("archived_at", null).in("status", LIVE),
    admin.from("client_assignments").select("client_id, profile_id, role").in("role", ["meta_buyer", "google_buyer", "coordinator"]),
  ]);
  const clientOf = new Map<string, { id: string; external: boolean }>();
  for (const c of clients ?? []) {
    if (c.slack_channel_id) clientOf.set(c.slack_channel_id as string, { id: c.id as string, external: true });
    if (c.internal_slack_channel_id) clientOf.set(c.internal_slack_channel_id as string, { id: c.id as string, external: false });
  }
  // A client's message with nobody tagged is on their buyers (or the coordinator when there's no buyer)
  const onAccount = (clientId: string) => {
    const mine = (assigned ?? []).filter((a) => a.client_id === clientId);
    const buyers = mine.filter((a) => a.role !== "coordinator");
    return [...new Set((buyers.length ? buyers : mine).map((a) => a.profile_id as string))];
  };

  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  let found = 0;
  let read = 0;
  const errors: string[] = [];
  const said: Candidate[] = [];
  const line = (x: Msg) => `${who.nameOf.get(x.user ?? "") ?? "Someone"}${x.user && who.team.has(x.user) ? " (team)" : ""}: ${plain(x.text ?? "", who.nameOf).replace(/\s+/g, " ").slice(0, 400)}`;
  for (const ch of channels.filter((c) => c.is_member && !c.is_archived)) {
    const key = `owed:slack:${ch.id}`;
    const started = new Date();
    try {
      const cursor = Math.max((await getCursor(admin, key, 1)).getTime(), since) / 1000;
      // A week of top-level messages: new ones, and older threads with new replies in them
      const { messages } = await slack<{ messages: Msg[] }>("conversations.history", { channel: ch.id, oldest: (since / 1000).toFixed(6), limit: "200" });
      const fresh: Msg[] = messages.filter((m) => Number(m.ts) > cursor);
      // Whole threads with something new in them, so what was asked is there to read alongside the answer
      const threads = new Map<string, Msg[]>();
      for (const m of messages) {
        if (!m.reply_count || !m.latest_reply || Number(m.latest_reply) <= cursor) continue;
        const { messages: replies } = await slack<{ messages: Msg[] }>("conversations.replies", { channel: ch.id, ts: m.ts, limit: "200" });
        threads.set(m.ts, replies);
        fresh.push(...replies.filter((r) => r.ts !== m.ts && Number(r.ts) > cursor));
      }
      fresh.sort((a, b) => Number(a.ts) - Number(b.ts));
      read += fresh.length;
      const client = clientOf.get(ch.id) ?? null;
      const rows: Row[] = [];
      const { data: waiting } = fresh.length ? await admin.from("owed_replies").select("id, status, target_id, from_name, client_id, url, thread_ts, message_ts, mentioned").eq("source", "slack").eq("channel_id", ch.id).in("status", OPEN) : { data: [] };
      const stillOpen = (waiting ?? []) as Row[];
      for (const m of fresh) {
        if (!m.user || m.bot_id || (m.subtype && m.subtype !== "thread_broadcast") || !m.text?.trim()) continue;
        const fromTeam = who.team.has(m.user);
        // Someone speaking in a thread (or the channel) answers what was asked of them there before
        const authorProfile = who.profileOf.get(m.user);
        if (fromTeam) await answeredBy(admin, stillOpen, m, authorProfile ?? null);
        // Something taken on ("I'll get that over", "love it, let's run it"): handed to the promise reader with what came before
        if (fromTeam && authorProfile && COMMIT.test(m.text)) {
          const before = (m.thread_ts ? (threads.get(m.thread_ts) ?? []) : [...messages].reverse()).filter((x) => Number(x.ts) < Number(m.ts) && x.text?.trim()).slice(-6);
          if (before.length)
            said.push({
              source: "slack",
              message_key: `${ch.id}:${m.ts}`,
              owner_id: authorProfile,
              client_id: client?.id ?? null,
              channel_id: ch.id,
              channel_name: ch.name,
              thread_ts: m.thread_ts ?? null,
              message_ts: m.ts,
              url: permalink(ch.id, m.ts),
              channel_url: `https://slack.com/app_redirect?channel=${ch.id}`,
              said_at: new Date(Number(m.ts) * 1000).toISOString(),
              said: plain(m.text, who.nameOf).slice(0, 1500),
              before: before.map(line).join("\n"),
            });
        }
        const tagged = [...new Set([...m.text.matchAll(MENTION)].map((x) => who.profileOf.get(x[1])).filter((p): p is string => Boolean(p) && p !== authorProfile))];
        const targets = tagged.length ? tagged : !fromTeam && client?.external ? onAccount(client.id) : [];
        for (const target of targets)
          rows.push({
            source: "slack",
            message_key: `${ch.id}:${m.ts}`,
            target_id: target,
            client_id: client?.id ?? null,
            channel_id: ch.id,
            channel_name: ch.name,
            thread_ts: m.thread_ts ?? null,
            message_ts: m.ts,
            from_name: who.nameOf.get(m.user) ?? "Someone",
            from_team: fromTeam,
            mentioned: tagged.length > 0,
            asked_at: new Date(Number(m.ts) * 1000).toISOString(),
            body: trimBody(plain(m.text, who.nameOf), 1500),
            url: permalink(ch.id, m.ts),
            channel_url: `https://slack.com/app_redirect?channel=${ch.id}`,
          });
      }
      // A thumbs-up (or a check, an ok hand, "on it") from a teammate on someone else's ask, in the last few days
      const recent = Date.now() / 1000 - 3 * 86_400;
      for (const x of [...messages, ...[...threads.values()].flat()]) {
        if (Number(x.ts) < recent || !x.user || !x.text || !REQUESTISH.test(x.text)) continue;
        for (const r of x.reactions ?? []) {
          if (!APPROVE_EMOJI.has(r.name.split("::")[0])) continue;
          for (const u of r.users ?? []) {
            const owner = who.profileOf.get(u);
            if (!owner || u === x.user) continue;
            const thread = x.thread_ts ? (threads.get(x.thread_ts) ?? []) : [...messages].reverse();
            said.push({
              source: "slack",
              message_key: `${ch.id}:${x.ts}:r:${u}`,
              owner_id: owner,
              client_id: client?.id ?? null,
              channel_id: ch.id,
              channel_name: ch.name,
              thread_ts: x.thread_ts ?? null,
              message_ts: x.ts,
              url: permalink(ch.id, x.ts),
              channel_url: `https://slack.com/app_redirect?channel=${ch.id}`,
              said_at: new Date(Math.max(Number(x.ts) * 1000, Date.now() - 3_600_000)).toISOString(),
              said: `(reacted :${r.name}: to ${who.nameOf.get(x.user) ?? "their"} message)`,
              before: [...thread.filter((y) => Number(y.ts) < Number(x.ts) && y.text?.trim()).slice(-4), x].map(line).join("\n"),
            });
          }
        }
      }
      if (rows.length) {
        const { error } = await admin.from("owed_replies").upsert(rows, { onConflict: "source,message_key,target_id", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        found += rows.length;
      }
      await setCursor(admin, key, new Date(started.getTime() - 2 * 60_000), { ok: true, read: fresh.length });
    } catch (e) {
      errors.push(`#${ch.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { who, said, notes: { channels: channels.filter((c) => c.is_member).length, read, found, said: said.length, errors: errors.slice(0, 5) } };
}

/** A teammate's message closes what was open for them in the same place: the thread, or the channel for top-level asks. */
async function answeredBy(admin: Admin, open: Row[], m: Msg, profileId: string | null) {
  const now = new Date().toISOString();
  for (const o of [...open]) {
    if (Number(o.message_ts) >= Number(m.ts)) continue;
    const thread = (o.thread_ts as string | null) ?? (o.message_ts as string);
    const here = m.thread_ts ? m.thread_ts === thread : !o.thread_ts;
    // Tagged: they have to answer themselves. A client's untagged message: anyone on the team answering will do
    const them = o.mentioned ? o.target_id === profileId : true;
    if (!here || !them) continue;
    await closeAnswered(admin, o, now);
    open.splice(open.indexOf(o), 1);
  }
}

/**
 * Answered: off the person's list and their unread notices off the bell. If it had gone to their lead and the
 * execs, they hear it's been answered.
 */
async function closeAnswered(admin: Admin, o: Row, now = new Date().toISOString()) {
  await admin.from("owed_replies").update({ status: "answered", answered_at: now, checked_at: now }).eq("id", o.id);
  await clearNotices(admin, "owed", String(o.id));
  if (o.status !== "escalated") return;
  const { data: sent } = await admin.from("notifications").select("profile_id").eq("key", `owed-lead:${o.id}`);
  const { data: person } = await admin.from("profiles").select("full_name").eq("id", o.target_id).maybeSingle();
  await notify(admin, (sent ?? []).map((s) => s.profile_id as string), {
    key: `owed-done:${o.id}`,
    title: `${person?.full_name ?? "They"} replied to ${o.from_name}`,
    body: "The message that went unanswered has an answer now.",
    href: (o.url as string | null) ?? null,
    clientId: (o.client_id as string | null) ?? null,
    priority: "normal",
  });
}

/** The definitive look before a notice: everything said after it in its thread (or the channel), and reactions on it. */
async function slackSince(o: Row) {
  const channel = o.channel_id as string;
  const ts = o.message_ts as string;
  const thread = (o.thread_ts as string | null) ?? ts;
  const { messages } = await slack<{ messages: Msg[] }>("conversations.replies", { channel, ts: thread, limit: "200" });
  const asked = messages.find((x) => x.ts === ts);
  const after = messages.filter((x) => Number(x.ts) > Number(ts));
  // A top-level message with no thread: people often answer in the channel
  if (!o.thread_ts && !after.length) {
    const { messages: later } = await slack<{ messages: Msg[] }>("conversations.history", { channel, oldest: ts, limit: "50" });
    after.push(...later.filter((x) => Number(x.ts) > Number(ts)));
  }
  return { after, reactors: new Set((asked?.reactions ?? []).flatMap((r) => r.users ?? [])) };
}

// ─── Email ──────────────────────────────────────────────────────────────────

/** Each teammate's inbox: new emails written to them by a client contact or a teammate. */
async function scanGmail(admin: Admin) {
  const [{ data: people }, { data: links }] = await Promise.all([
    admin.from("profiles").select("id, email, full_name").eq("is_active", true).not("email", "is", null),
    admin.from("contact_clients").select("client_id, contacts(email, name), clients!inner(archived_at, status)").is("clients.archived_at", null).in("clients.status", LIVE),
  ]);
  const team = new Map((people ?? []).map((p) => [String(p.email).toLowerCase(), p]));
  const contacts = new Map<string, { clientId: string; name: string | null }>();
  for (const l of links ?? []) {
    const c = l.contacts as unknown as { email: string | null; name: string | null } | null;
    if (c?.email) contacts.set(c.email.toLowerCase(), { clientId: l.client_id as string, name: c.name });
  }
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  let found = 0;
  const errors: string[] = [];
  const said: Candidate[] = [];
  for (const [mailbox, person] of team) {
    const key = `owed:gmail:${mailbox}`;
    const started = new Date();
    try {
      const token = await gmailToken(mailbox);
      const after = Math.floor(Math.max((await getCursor(admin, key, 1)).getTime(), since) / 1000);
      const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: `to:me -from:me after:${after} -category:promotions -category:social -category:updates -category:forums`, maxResults: "60" });
      const rows: Row[] = [];
      for (const { id } of list.messages ?? []) {
        const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
        const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
        const from = addresses(header("from"))[0];
        // Written to them (not a copy), by a client contact or a teammate; mailing lists and tools don't count
        if (!from || header("list-id") || !(addresses(header("to")) as string[]).includes(mailbox)) continue;
        const contact = contacts.get(from);
        const mate = team.get(from);
        if (!contact && !mate) continue;
        const name = (header("from") ?? "").replace(/<[^>]+>/, "").replace(/"/g, "").trim() || contact?.name || mate?.full_name || from;
        rows.push({
          source: "gmail",
          message_key: `${mailbox}:${m.id}`,
          target_id: person.id,
          client_id: contact?.clientId ?? null,
          mailbox,
          gmail_thread_id: m.threadId,
          from_name: name,
          from_team: Boolean(mate),
          mentioned: true,
          asked_at: new Date(Number(m.internalDate)).toISOString(),
          subject: header("subject"),
          body: trimBody(withoutQuotes(plainText(m.payload) ?? m.snippet ?? ""), 1500),
          url: `https://mail.google.com/mail/u/${mailbox}/#all/${m.id}`,
        });
      }
      if (rows.length) {
        const { error } = await admin.from("owed_replies").upsert(rows, { onConflict: "source,message_key,target_id", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        found += rows.length;
      }
      await setCursor(admin, key, new Date(started.getTime() - 2 * 60_000), { ok: true, found: rows.length });
      await sentMail(admin, token, mailbox, person.id as string, after, team, contacts, said);
    } catch (e) {
      // Someone without a Workspace mailbox (or one the service account can't open) is skipped
      errors.push(`${mailbox}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }
  return { said, notes: { mailboxes: team.size, found, said: said.length, errors: errors.slice(0, 5) } };
}

/**
 * What someone sent: a reply in a thread answers what was waiting on them there (closed straight away), and a reply
 * to a client or teammate that takes something on goes to the promise reader with the email it answers.
 */
async function sentMail(admin: Admin, token: string, mailbox: string, me: string, after: number, team: Map<string, unknown>, contacts: Map<string, { clientId: string }>, said: Candidate[]) {
  const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: `in:sent after:${after}`, maxResults: "40" });
  for (const { id } of list.messages ?? []) {
    const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
    const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
    const sentAt = new Date(Number(m.internalDate)).toISOString();
    // Anything waiting on them in this thread is answered
    const { data: waiting } = await admin.from("owed_replies").select("id, status, target_id, from_name, client_id, url").eq("source", "gmail").eq("mailbox", mailbox).eq("gmail_thread_id", m.threadId).in("status", OPEN).lt("asked_at", sentAt);
    for (const o of waiting ?? []) await closeAnswered(admin, o);
    if (!header("in-reply-to")) continue;
    const body = withoutQuotes(plainText(m.payload) ?? m.snippet ?? "");
    const to = [...addresses(header("to")), ...addresses(header("cc"))] as string[];
    const client = to.map((a) => contacts.get(a)).find(Boolean);
    if (!COMMIT.test(body) || (!client && !to.some((a) => a !== mailbox && team.has(a)))) continue;
    const thread = await google<{ messages: GmailMessage[] }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${m.threadId}`, { format: "full" });
    const before = thread.messages
      .filter((x) => Number(x.internalDate) < Number(m.internalDate))
      .slice(-3)
      .map((x) => {
        const from = x.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
        const a = (addresses(from) as string[])[0] ?? "";
        return `${from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || a}${team.has(a) ? " (team)" : ""}: ${withoutQuotes(plainText(x.payload) ?? x.snippet ?? "").replace(/\s+/g, " ").slice(0, 600)}`;
      });
    if (!before.length) continue;
    said.push({
      source: "gmail",
      message_key: `${mailbox}:${m.id}`,
      owner_id: me,
      client_id: client?.clientId ?? null,
      mailbox,
      gmail_thread_id: m.threadId,
      url: `https://mail.google.com/mail/u/${mailbox}/#all/${m.id}`,
      said_at: sentAt,
      said: `(email "${header("subject") ?? ""}") ${body.replace(/\s+/g, " ").slice(0, 1200)}`,
      before: before.join("\n"),
    });
  }
}

/** Whether the thread has an answer from our side after the email: from them, or anyone on the team for a client. */
async function gmailAnswered(o: Row, teamEmails: Set<string>) {
  const token = await gmailToken(o.mailbox as string);
  const t = await google<{ messages: { id: string; internalDate: string; labelIds?: string[]; payload: { headers: { name: string; value: string }[] } }[] }>(
    token,
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${o.gmail_thread_id}`,
    { format: "metadata", metadataHeaders: "From" },
  );
  const at = new Date(o.asked_at as string).getTime();
  return t.messages.some((m) => {
    if (Number(m.internalDate) <= at) return false;
    const from = addresses(m.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? null)[0];
    return m.labelIds?.includes("SENT") || from === o.mailbox || (!o.from_team && from && teamEmails.has(from));
  });
}

// ─── Deciding ───────────────────────────────────────────────────────────────

/** Whether it's been answered, looking at the source itself. Unknown (the source can't be read) counts as not. */
async function isAnswered(o: Row, who: Awaited<ReturnType<typeof slackPeople>> | null, teamEmails: Set<string>, context: Map<string, string>) {
  try {
    if (o.source === "gmail") return await gmailAnswered(o, teamEmails);
    if (!who) return false;
    const { after, reactors } = await slackSince(o);
    const mine = [...who.profileOf].filter(([, p]) => p === o.target_id).map(([s]) => s);
    context.set(o.id as string, after.slice(0, 6).map((x) => `${who.nameOf.get(x.user ?? "") ?? "Someone"}: ${plain(x.text ?? "", who.nameOf).slice(0, 300)}`).join("\n"));
    if (o.mentioned) return after.some((x) => x.user && mine.includes(x.user)) || mine.some((s) => reactors.has(s));
    return after.some((x) => x.user && who.team.has(x.user));
  } catch {
    return false;
  }
}

type Verdict = { n: number; needsReply: boolean; gist: string };

/** The AI's read of each one: is something really owed (a question, a request, work shared for feedback), and what. */
async function judge(items: Row[], context: Map<string, string>, names: Map<string, string>): Promise<Map<string, Verdict>> {
  if (!items.length) return new Map();
  try {
    const out = await askJson<{ items: Verdict[] }>({
      agent: "calls",
      label: "owed replies",
      bare: true,
      maxTokens: 4000,
      system:
        "You read messages sent to someone at Kaizen, a paid ads and creative agency, and decide if that person owes a reply or an action. needsReply is true when they're asked a question, asked to check, review, approve, send or do something, when someone shares work for their feedback (a landing page, a design, a doc), or when a client raises something with them. It's false for an FYI that needs nothing, a thank-you or sign-off, an announcement, something automated, or when what follows already answers it. gist: what they're waiting on, in a few words a person would say (\"feedback on the landing page concept\", \"the March invoice question\"), no names, at most 70 characters.",
      schema: {
        type: "object",
        properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, needsReply: { type: "boolean" }, gist: { type: "string" } }, required: ["n", "needsReply", "gist"], additionalProperties: false } } },
        required: ["items"],
        additionalProperties: false,
      },
      prompt: items
        .map((o, i) => {
          const where = o.source === "gmail" ? `Email "${o.subject ?? ""}"` : `Slack #${o.channel_name}`;
          const said = context.get(o.id as string);
          return `${i + 1}. ${where}, from ${o.from_name}${o.from_team ? " (a teammate)" : " (a client or someone outside the team)"} to ${names.get(o.target_id as string) ?? "them"}${o.mentioned ? "" : " (on their account, nobody tagged)"}:\n${String(o.body ?? "").slice(0, 1200)}${said ? `\nSaid after it:\n${said}` : ""}`;
        })
        .join("\n\n"),
    });
    return new Map(out.items.filter((v) => items[v.n - 1]).map((v) => [items[v.n - 1].id as string, v]));
  } catch {
    return new Map();
  }
}

const whereOf = (o: Row) => (o.source === "gmail" ? `by email${o.subject ? ` ("${String(o.subject).slice(0, 60)}")` : ""}` : `in #${o.channel_name}`);
const gistOf = (o: Row) => (o.gist as string | null) || String(o.body ?? "").replace(/\s+/g, " ").slice(0, 90);

export async function notify(admin: Admin, ids: string[], n: { key: string; kind?: string; title: string; body: string; href: string | null; clientId: string | null; priority: "critical" | "normal" }) {
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({ profile_id: id, kind: n.kind ?? "reply", title: n.title.slice(0, 200), body: n.body.slice(0, 1000), href: n.href, client_id: n.clientId, key: n.key, priority: n.priority })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** The step: read what's new, close what's answered, send first notices, and tell leads about what's still ignored. */
export async function runOwedReplies(admin: Admin) {
  const slackOn = slackConfigured();
  const gmailOn = googleConfigured();
  const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  const slackRun = slackOn ? await scanSlack(admin).catch(fail) : null;
  const gmailRun = gmailOn ? await scanGmail(admin).catch(fail) : null;
  const scanned = {
    slack: !slackRun ? { skipped: "Slack isn't connected" } : "error" in slackRun ? slackRun : slackRun.notes,
    gmail: !gmailRun ? { skipped: "Google isn't connected" } : "error" in gmailRun ? gmailRun : gmailRun.notes,
  };

  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const [{ data: open }, { data: people }] = await Promise.all([
    admin.from("owed_replies").select("*").in("status", OPEN).gte("asked_at", cutoff).order("asked_at").limit(300),
    admin.from("profiles").select("id, full_name, email, role, is_active"),
  ]);
  const byId = new Map((people ?? []).map((p) => [p.id as string, p]));
  const teamEmails = new Set((people ?? []).filter((p) => p.is_active && p.email).map((p) => String(p.email).toLowerCase()));
  const names = new Map((people ?? []).map((p) => [p.id as string, String(p.full_name ?? "").split(" ")[0] || "them"]));
  const who = slackRun && !("error" in slackRun) ? slackRun.who : slackOn ? await slackPeople(admin).catch(() => null) : null;
  const context = new Map<string, string>();
  const now = new Date();
  const stamp = now.toISOString();
  const tally = { answered: 0, notNeeded: 0, nudged: 0, escalated: 0 };

  // Due a first notice: unanswered after the wait, then the AI's read
  const due: NonNullable<typeof open> = [];
  for (const o of (open ?? []).filter((x) => x.status === "watching")) {
    if (workingHours(new Date(o.asked_at)) < NUDGE_AFTER[o.source as "slack" | "gmail"]) continue;
    if (!byId.get(o.target_id)?.is_active) continue;
    if (await isAnswered(o, who, teamEmails, context)) {
      await closeAnswered(admin, o, stamp);
      tally.answered++;
    } else due.push(o);
  }
  const verdicts = new Map<string, Verdict>();
  for (let i = 0; i < due.length; i += 15) for (const [k, v] of await judge(due.slice(i, i + 15), context, names)) verdicts.set(k, v);
  for (const o of due) {
    const v = verdicts.get(o.id);
    if (v && !v.needsReply) {
      await admin.from("owed_replies").update({ status: "not_needed", gist: v.gist.slice(0, 120), checked_at: stamp }).eq("id", o.id);
      tally.notNeeded++;
      continue;
    }
    const gist = v?.gist?.slice(0, 120) || null;
    await admin.from("owed_replies").update({ status: "nudged", nudged_at: stamp, checked_at: stamp, gist }).eq("id", o.id);
    await notify(admin, [o.target_id], {
      key: `owed:${o.id}`,
      title: `You haven't replied to ${o.from_name}`,
      body: `${gist ?? gistOf(o)}, ${whereOf(o)}. Reply there, or mark it as not needing a reply in your day.`,
      href: o.url,
      clientId: o.client_id,
      priority: "normal",
    });
    tally.nudged++;
  }

  // First notice out, still no answer: after they've seen it (or a working day if they never open it), escalate
  const nudged = (open ?? []).filter((x) => x.status === "nudged");
  const keys = nudged.map((o) => `owed:${o.id}`);
  const [{ data: reads }, { data: views }] = keys.length
    ? await Promise.all([
        admin.from("notifications").select("profile_id, key, read_at").in("key", keys).not("read_at", "is", null),
        admin.from("daily_items").select("profile_id, key, updated_at").in("key", keys),
      ])
    : [{ data: [] }, { data: [] }];
  const seenAt = new Map<string, string>();
  for (const r of [...(reads ?? []).map((x) => ({ key: x.key, at: x.read_at })), ...(views ?? []).map((x) => ({ key: x.key, at: x.updated_at }))]) {
    const cur = seenAt.get(r.key as string);
    if (!cur || String(r.at) < cur) seenAt.set(r.key as string, String(r.at));
  }
  const { data: execs } = await admin.from("profiles").select("id, role").eq("is_active", true).eq("role", "executive");
  for (const o of nudged) {
    // Looked at every run, so a reply closes it (and its notice) within the hour, not only when it's about to escalate
    if (await isAnswered(o, who, teamEmails, context)) {
      await closeAnswered(admin, o, stamp);
      tally.answered++;
      continue;
    }
    const seen = seenAt.get(`owed:${o.id}`);
    const ready = seen ? workingHours(new Date(seen)) >= ESCALATE_SEEN : workingHours(new Date(o.nudged_at)) >= ESCALATE_UNSEEN;
    if (!ready) {
      await admin.from("owed_replies").update({ checked_at: stamp }).eq("id", o.id);
      continue;
    }
    const person = byId.get(o.target_id);
    const lead = LEAD_OF[String(person?.role ?? "")];
    const { data: leads } = lead ? await admin.from("profiles").select("id").eq("is_active", true).eq("role", lead) : { data: [] };
    const above = [...new Set([...(leads ?? []), ...(execs ?? [])].map((p) => p.id as string))].filter((id) => id !== o.target_id);
    await admin.from("owed_replies").update({ status: "escalated", escalated_at: stamp, checked_at: stamp }).eq("id", o.id);
    const gist = gistOf(o);
    await notify(admin, [o.target_id], {
      key: `owed2:${o.id}`,
      title: `Second notice: still no reply to ${o.from_name}`,
      body: `${gist}, ${whereOf(o)}. ${above.length ? "Your lead and the exec team have been told it's waiting." : "The exec team has been told it's waiting."} Reply there, or mark it as not needing a reply in your day.`,
      href: o.url,
      clientId: o.client_id,
      priority: "critical",
    });
    await notify(admin, above, {
      key: `owed-lead:${o.id}`,
      title: `${person?.full_name ?? "Someone"} hasn't replied to ${o.from_name}`,
      body: `${gist}, ${whereOf(o)}, since ${new Date(o.asked_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })}. They had a notice and it's still unanswered.`,
      href: o.url,
      clientId: o.client_id,
      priority: "critical",
    });
    tally.escalated++;
  }

  // Escalated ones: closed once answered, and the lead and execs told
  for (const o of (open ?? []).filter((x) => x.status === "escalated").slice(0, 40)) {
    if (await isAnswered(o, who, teamEmails, context)) {
      await closeAnswered(admin, o, stamp);
      tally.answered++;
    } else await admin.from("owed_replies").update({ checked_at: stamp }).eq("id", o.id);
  }
  // Too old to chase any more: two weeks on, it's let go quietly
  await admin.from("owed_replies").update({ status: "not_needed", dismiss_reason: "Two weeks old" }).eq("status", "watching").lt("asked_at", cutoff);

  // What the team said yes to: new ones read, due ones followed through
  const candidates = [...(slackRun && !("error" in slackRun) ? slackRun.said : []), ...(gmailRun && !("error" in gmailRun) ? gmailRun.said : [])];
  const promises = await recordPromises(admin, candidates, names).catch(fail);
  // A new one about something already promised (on a call, in another thread) joins it
  const { groupPromises, settleGroups } = await import("@/lib/promise-groups");
  const grouped = await groupPromises(admin).catch(fail);
  const following = await followPromises(admin, who).catch(fail);
  await settleGroups(admin).catch(() => 0);
  return { scanned, ...tally, promises, grouped, following };
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type OwedReply = {
  id: string;
  source: "slack" | "gmail";
  status: "nudged" | "escalated";
  targetId: string;
  target: string;
  from: string;
  fromTeam: boolean;
  where: string;
  gist: string;
  body: string;
  askedAt: string;
  url: string | null;
  channelUrl: string | null;
  client: string | null;
  clientSlug: string | null;
  clientId: string | null;
};

/**
 * What's owed after a first notice: your own, plus (for leads and execs) other people's that were escalated. RLS
 * shows people only their own and leads and execs everyone's; `others` picks which of those.
 */
export async function loadOwedReplies(db: SupabaseClient, me: { id: string; role: string; isExec: boolean; isLead: boolean }, others = me.isExec || me.isLead): Promise<OwedReply[]> {
  const { data } = await db
    .from("owed_replies")
    .select("id, source, status, target_id, from_name, from_team, channel_name, subject, gist, body, asked_at, url, channel_url, client_id, clients(name, slug), target:profiles!owed_replies_target_id_fkey(full_name, role)")
    .in("status", ["nudged", "escalated"])
    .order("asked_at")
    .limit(80);
  return (data ?? [])
    .filter((o) => {
      if (o.target_id === me.id) return true;
      if (!others || o.status !== "escalated") return false;
      if (me.isExec) return true;
      // A lead sees their own team's
      const role = (o.target as unknown as { role: string } | null)?.role ?? "";
      return LEAD_OF[role] === me.role;
    })
    .map((o) => {
      const c = o.clients as unknown as { name: string; slug: string } | null;
      return {
        id: o.id as string,
        source: o.source as OwedReply["source"],
        status: o.status as OwedReply["status"],
        targetId: o.target_id as string,
        target: (o.target as unknown as { full_name: string } | null)?.full_name ?? "Someone",
        from: o.from_name as string,
        fromTeam: Boolean(o.from_team),
        where: whereOf(o),
        gist: gistOf(o),
        body: String(o.body ?? ""),
        askedAt: o.asked_at as string,
        url: (o.url as string | null) ?? null,
        channelUrl: (o.channel_url as string | null) ?? null,
        client: c?.name ?? null,
        clientSlug: c?.slug ?? null,
        clientId: (o.client_id as string | null) ?? null,
      };
    });
}
