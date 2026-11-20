import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
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
  // Everything we know about the client, current to the minute, so the draft answers from it (never contradicts it)
  const ctx = o.client_id ? await clientContext(admin, o.client_id as string, { fresh: true }).catch(() => null) : null;
  try {
    const out = await askJson<{ reply: string }>({
      agent: "calls",
      label: "draft owed reply",
      clientId: (o.client_id as string | null) ?? null,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 1200,
      system: `You draft the next reply for a teammate at Kaizen, a paid ads and creative agency, to a message that's waiting on them. Write it as them, in their voice: match how they write in their own messages below (length, greeting or none, punctuation, emoji, how casual). ${email ? "It's an email: the body only (no subject), with the greeting and sign-off they'd use." : "It's a Slack reply in the thread: short and plain, no greeting line or sign-off unless they write that way, no markdown headings."}
Answer what's actually asked, using only what the conversation and the client context show. Never invent dates, numbers, prices, results or commitments: where the reply needs something only they know or decide, put a short placeholder in square brackets, e.g. [the new launch date]. If it's work shared for feedback and there's nothing to judge from the text, acknowledge it and say when they'll look, with a bracketed placeholder for the time. Keep it to what a busy person would send.`,
      schema: SCHEMA,
      prompt: [
        ctx ? contextBlock(ctx, undefined, { allotment: false }) : client ? `<client>${client}</client>` : "",
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

const UPDATE_SCHEMA = { type: "object", properties: { reply: { type: "string" }, delivered: { type: "boolean", description: "True only when the conversation shows the promised thing is done and this message hands it over" } }, required: ["reply", "delivered"], additionalProperties: false };

/**
 * An update on something the person said yes to in Slack or email, drafted in the same thread in their voice: when the
 * thread shows it's done, the "here it is" message; otherwise an honest status with a concrete new time (a bracketed
 * placeholder they fill in, never an invented date). Kept on the row until the thread moves on.
 */
export async function draftPromiseUpdate(admin: SupabaseClient, id: string, opts: { force?: boolean } = {}): Promise<{ ok: true; draft: string; delivered: boolean } | { ok: false; error: string }> {
  const { data: p } = await admin.from("message_promises").select("*, clients(name)").eq("id", id).maybeSingle();
  if (!p) return { ok: false, error: "That promise isn't open any more." };
  if (p.source === "slack" && !slackConfigured()) return { ok: false, error: "Slack isn't connected." };
  if (p.source === "gmail" && !googleConfigured()) return { ok: false, error: "Google isn't connected." };
  const { data: me } = await admin.from("profiles").select("slack_user_id").eq("id", p.owner_id).maybeSingle();
  let thread: { basis: string; lines: string[]; voice: string[]; subject?: string };
  try {
    thread = p.source === "gmail" ? await gmailThread(p) : await slackThread(p, (me?.slack_user_id as string | null) ?? null);
  } catch (e) {
    return { ok: false, error: `Couldn't read the conversation: ${e instanceof Error ? e.message : e}` };
  }
  if (!opts.force && p.draft && p.draft_basis === thread.basis) return { ok: true, draft: p.draft as string, delivered: false };
  const email = p.source === "gmail";
  const ctx = p.client_id ? await clientContext(admin, p.client_id as string, { fresh: true }).catch(() => null) : null;
  try {
    const out = await askJson<{ reply: string; delivered: boolean }>({
      agent: "calls",
      label: "draft promise update",
      clientId: (p.client_id as string | null) ?? null,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 1200,
      system: `You draft an update for a teammate at Kaizen, a paid ads and creative agency, on something they said they'd do in this conversation and that's now due. Write it as them, in their voice: match how they write in their own messages below. ${email ? "It's an email reply: the body only (no subject), with the greeting and sign-off they'd use." : "It's a Slack reply in the same thread: short and plain, no headings."}
If the conversation shows it's done (a link, a file, a confirmation), write the short "here it is" message and set delivered true. Otherwise set delivered false and write an honest status: own the delay in one short clause (no grovelling), say what's left, and give a concrete new time as a bracketed placeholder, e.g. [Tuesday 3pm]. Never invent dates, numbers, links, results or reasons; anything only they know goes in [brackets]. Keep it to what a busy person would send.`,
      schema: UPDATE_SCHEMA,
      prompt: [
        ctx ? contextBlock(ctx, undefined, { allotment: false }) : "",
        thread.subject ? `<subject>${thread.subject}</subject>` : "",
        `<conversation>\n${thread.lines.join("\n")}\n</conversation>`,
        `<their_promise>${p.ask ? `They were asked: ${p.ask}. ` : ""}They said: "${String(p.said ?? "").slice(0, 500)}". It was due ${String(p.due_at).slice(0, 10)}.</their_promise>`,
        thread.voice.length ? `<how_they_write>\n${thread.voice.map((v) => `- ${v.replace(/\s+/g, " ")}`).join("\n")}\n</how_they_write>` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const draft = out.reply.trim().slice(0, 4000);
    if (!draft) return { ok: false, error: "The draft came back empty. Try again." };
    await admin.from("message_promises").update({ draft, draft_basis: thread.basis, drafted_at: new Date().toISOString() }).eq("id", id);
    return { ok: true, draft, delivered: Boolean(out.delivered) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't write a draft." };
  }
}

/**
 * An update to the client on something promised on a call, for the person it was routed to: where it stands and when
 * it lands, for the client's Slack channel (or an email, for a client that works by email only). They send it
 * themselves; nothing is posted for them. Kept on the row until redrafted.
 */
export async function draftCallUpdate(admin: SupabaseClient, id: string, profileId: string, opts: { force?: boolean } = {}): Promise<{ ok: true; draft: string } | { ok: false; error: string }> {
  const { data: c } = await admin
    .from("call_commitments")
    .select("id, client_id, what, why, due_at, status, draft, routed_to, clients(name, slack_channel_id, services, services_extra, services_removed), client_calls(title, occurred_at)")
    .eq("id", id)
    .maybeSingle();
  if (!c) return { ok: false, error: "That promise isn't open any more." };
  if (!((c.routed_to as string[] | null) ?? []).includes(profileId)) return { ok: false, error: "Only the person it's on can draft the update." };
  if (!opts.force && c.draft) return { ok: true, draft: c.draft as string };
  const client = c.clients as unknown as { name: string; slack_channel_id: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null } | null;
  const call = c.client_calls as unknown as { title: string; occurred_at: string } | null;
  const { servicesOf } = await import("@/lib/services");
  const { callDestination } = await import("@/lib/promise-today-core");
  const dest = callDestination({ slackChannelId: client?.slack_channel_id ?? null, services: client ? (servicesOf(client) as string[]) : [], contactEmail: "-", subject: "" });
  const email = dest?.source !== "slack";
  const ctx = c.client_id ? await clientContext(admin, c.client_id as string, { fresh: true }).catch(() => null) : null;
  const { data: me } = await admin.from("profiles").select("role").eq("id", profileId).maybeSingle();
  try {
    const out = await askJson<{ reply: string }>({
      agent: "calls",
      label: "draft call promise update",
      clientId: c.client_id as string,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 1000,
      system: `You draft a short update to a client from their account team at Kaizen, a paid ads and creative agency, on something the team promised on a call. It comes from the person responsible (${me?.role ? String(me.role).replace(/_/g, " ") : "the account owner"}), to the client. ${email ? "It's an email: the body only, a short greeting and sign-off." : "It's a Slack message in the client's channel: short, warm and plain, no headings."}
Say what was promised, where it stands and when it lands. Use only what the client context shows; never invent dates, numbers, links or results: put anything only they know in [brackets], e.g. [Thursday]. Never mention fees, invoices or internal people problems. Positive; own any delay in a clause, no grovelling.`,
      schema: SCHEMA,
      prompt: [
        ctx ? contextBlock(ctx, undefined, { allotment: false }) : client ? `<client>${client.name}</client>` : "",
        `<promise>On the call "${call?.title ?? "a call"}" (${String(call?.occurred_at ?? "").slice(0, 10)}) the team promised: ${c.what}${c.why ? ` (why: ${c.why})` : ""}. It was due ${String(c.due_at).slice(0, 10)}.</promise>`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const draft = out.reply.trim().slice(0, 3000);
    if (!draft) return { ok: false, error: "The draft came back empty. Try again." };
    await admin.from("call_commitments").update({ draft, drafted_at: new Date().toISOString() }).eq("id", id);
    return { ok: true, draft };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't write a draft." };
  }
}
