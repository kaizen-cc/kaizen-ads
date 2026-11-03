import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { slack, slackConfigured } from "@/lib/context/slack";
import { addresses, gmailToken, google, googleConfigured, plainText, withoutQuotes, type GmailMessage } from "@/lib/context/google";

// The reply someone owes, drafted for them: the whole thread (or email conversation) read, written the way they
// write (from their own recent messages), so answering takes one look and a send instead of the context going
// stale for two days. A draft is kept until the thread moves on; then it's written again.

type Row = Record<string, unknown>;
type SlackMsg = { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string };

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const names = new Map<string, string>();
async function nameOf(id: string | undefined) {
  if (!id) return "Someone";
  if (!names.has(id)) {
    const r = await slack<{ user: { real_name?: string; profile?: { display_name?: string } } }>("users.info", { user: id }).catch(() => null);
    names.set(id, r?.user.real_name || r?.user.profile?.display_name || "Someone");
  }
  return names.get(id)!;
}
async function readable(text: string) {
  let out = text;
  for (const [, id] of text.matchAll(MENTION)) out = out.replace(new RegExp(`<@${id}(\\|[^>]*)?>`, "g"), `@${await nameOf(id)}`);
  return out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1").replace(/<!(here|channel|everyone)>/g, "@$1");
}

/** The Slack thread (or the channel after a top-level message), and how this person writes in Slack. */
async function slackThread(o: Row, mine: string | null) {
  const channel = o.channel_id as string;
  const ts = o.message_ts as string;
  const thread = (o.thread_ts as string | null) ?? ts;
  const { messages } = await slack<{ messages: SlackMsg[] }>("conversations.replies", { channel, ts: thread, limit: "60" });
  const convo = [...messages];
  if (!o.thread_ts && messages.length <= 1) {
    const { messages: later } = await slack<{ messages: SlackMsg[] }>("conversations.history", { channel, oldest: ts, limit: "15" });
    convo.push(...later.filter((x) => Number(x.ts) > Number(ts)).reverse());
  }
  const lines: string[] = [];
  for (const m of convo.filter((x) => x.text?.trim() && !x.subtype).slice(-30)) lines.push(`${m.bot_id ? "A bot" : await nameOf(m.user)}${m.ts === ts ? " (the message waiting on a reply)" : ""}: ${(await readable(m.text!)).slice(0, 700)}`);
  // Their own voice: what they've written in this channel lately, else in the thread
  let voice: string[] = [];
  if (mine) {
    const { messages: recent } = await slack<{ messages: SlackMsg[] }>("conversations.history", { channel, limit: "200" }).catch(() => ({ messages: [] as SlackMsg[] }));
    voice = await Promise.all([...recent, ...convo].filter((m) => m.user === mine && m.text?.trim()).slice(0, 10).map(async (m) => (await readable(m.text!)).slice(0, 300)));
  }
  return { basis: convo.at(-1)?.ts ?? ts, lines, voice };
}

/** The email conversation, and how this person writes email. */
async function gmailThread(o: Row) {
  const mailbox = o.mailbox as string;
  const token = await gmailToken(mailbox);
  const t = await google<{ messages: GmailMessage[] }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${o.gmail_thread_id}`, { format: "full" });
  const header = (m: GmailMessage, n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const lines = t.messages.slice(-8).map((m) => {
    const from = header(m, "from");
    const who = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || addresses(from)[0] || "Someone";
    return `${who}${addresses(from)[0] === mailbox ? " (them)" : ""}: ${withoutQuotes(plainText(m.payload) ?? m.snippet ?? "").replace(/\s+/g, " ").slice(0, 900)}`;
  });
  const sent = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: "in:sent", maxResults: "6" }).catch(() => ({ messages: [] }));
  const voice: string[] = [];
  for (const { id } of sent.messages ?? []) {
    const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" }).catch(() => null);
    const body = m ? withoutQuotes(plainText(m.payload) ?? m.snippet ?? "").trim() : "";
    if (body) voice.push(body.slice(0, 500));
  }
  return { basis: t.messages.at(-1)?.id ?? String(o.gmail_thread_id), lines, voice, subject: header(t.messages[0], "subject") };
}

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false };

/**
 * The reply drafted for one waiting message, from the thread as it is now. Kept on the row and reused until someone
 * writes in the thread again (or `force` asks for a fresh one).
 */
export async function draftOwedReply(admin: SupabaseClient, id: string, opts: { force?: boolean } = {}): Promise<{ ok: true; draft: string } | { ok: false; error: string }> {
  const { data: o } = await admin.from("owed_replies").select("*, clients(name)").eq("id", id).maybeSingle();
  if (!o) return { ok: false, error: "That message isn't waiting on anyone any more." };
  if (o.source === "slack" && !slackConfigured()) return { ok: false, error: "Slack isn't connected." };
  if (o.source === "gmail" && !googleConfigured()) return { ok: false, error: "Google isn't connected." };
  const { data: me } = await admin.from("profiles").select("full_name, role, slack_user_id").eq("id", o.target_id).maybeSingle();
  let thread: { basis: string; lines: string[]; voice: string[]; subject?: string };
  try {
    thread = o.source === "gmail" ? await gmailThread(o) : await slackThread(o, (me?.slack_user_id as string | null) ?? null);
  } catch (e) {
    return { ok: false, error: `Couldn't read the conversation: ${e instanceof Error ? e.message : e}` };
  }
  if (!opts.force && o.draft && o.draft_basis === thread.basis) return { ok: true, draft: o.draft as string };
  const email = o.source === "gmail";
  const client = (o.clients as { name: string } | null)?.name ?? null;
  try {
    const out = await askJson<{ reply: string }>({
      agent: "calls",
      label: "draft owed reply",
      bare: true,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 1200,
      system: `You draft the next reply for a teammate at Kaizen, a paid ads and creative agency, to a message that's waiting on them. Write it as them, in their voice: match how they write in their own messages below (length, greeting or none, punctuation, emoji, how casual). ${email ? "It's an email: the body only (no subject), with the greeting and sign-off they'd use." : "It's a Slack reply in the thread: short and plain, no greeting line or sign-off unless they write that way, no markdown headings."}
Answer what's actually asked, using only what the conversation shows. Never invent dates, numbers, prices, results or commitments: where the reply needs something only they know or decide, put a short placeholder in square brackets, e.g. [the new launch date]. If it's work shared for feedback and there's nothing to judge from the text, acknowledge it and say when they'll look, with a bracketed placeholder for the time. Keep it to what a busy person would send.`,
      schema: SCHEMA,
      prompt: [
        client ? `<client>${client}</client>` : "",
        thread.subject ? `<subject>${thread.subject}</subject>` : "",
        `<conversation>\n${thread.lines.join("\n")}\n</conversation>`,
        `<waiting>${o.from_name}${o.from_team ? " (a teammate)" : " (a client or someone outside the team)"} is waiting on them: ${o.gist ?? String(o.body ?? "").slice(0, 300)}</waiting>`,
        thread.voice.length ? `<how_they_write>\n${thread.voice.map((v) => `- ${v.replace(/\s+/g, " ")}`).join("\n")}\n</how_they_write>` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const draft = out.reply.trim().slice(0, 4000);
    if (!draft) return { ok: false, error: "The draft came back empty. Try again." };
    await admin.from("owed_replies").update({ draft, draft_basis: thread.basis, drafted_at: new Date().toISOString() }).eq("id", id);
    return { ok: true, draft };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't write a draft." };
  }
}
