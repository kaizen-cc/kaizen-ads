import "server-only";
import { emailWritingKind } from "@/lib/copy-docs/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientNamedOrNull } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import type { CallDraft, CallEvent } from "@/lib/agent-call/core";
import { firstNameOf } from "@/lib/agent-call/core";
import type { ChatTool } from "@/lib/kaizen-ai/tools";
import { feedbackPath, spokenFeedbackType, type FeedbackType } from "@/lib/feedback-logic";
import { riskNote, RISK_PREFIX } from "@/lib/client-risk";
import { saidYes } from "./core";
import { clientTeam, recipientFor } from "./routing-server";
import { carriedYes, getDraft, latestDraft, putDraft, tellTeammate, type Draft } from "./handoff-server";
import { addressOf, reSubject, rawEmail, replyTo, slackPlace } from "./messages";
import { attachNote, draftFiles, fileViews, mailFiles } from "@/lib/documents/attach";
import { composeLinks } from "@/lib/email-drafts/core";
import { teammateTitle, type TeammateKind } from "./teammates";

// What the assistant and every agent can do for the person with the team and their messages, on a call or in a chat:
// send a task, an ask or an FYI to any teammate by name or role (send_to_teammate); draft a Slack reply or an email as
// them, shown on the call to edit (draft_message), and send it in the exact thread on a spoken yes (send_message);
// note a client may be leaving (flag_client_risk); and file feedback about the app down the in-app form's path
// (submit_feedback). Nothing here goes to a client except a message the person approved, as themselves.

export type CommsCtx = {
  me: Staff;
  db: SupabaseClient;
  admin: SupabaseClient;
  callId: string | null;
  /** What the person said this turn (a send runs only on their yes) */
  said: () => string;
  emit?: (e: CallEvent) => void;
  roleKey: string;
  /** "assistant", or the agent's role label ("Media Buyer") */
  label: string;
  /** The screen they're on (a path) and where they called from, for feedback */
  path?: string | null;
  screen?: string | null;
  /** The client the call is about, when it was started from one */
  clientId?: string | null;
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const body = (s: unknown, n: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nyDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to sending this exact draft" };
const OPEN = ["watching", "nudged", "escalated"];

async function clientNamed(db: SupabaseClient, name: unknown): Promise<{ id: string; name: string; slug: string } | null> {
  return clientNamedOrNull(db, clip(name, 120));
}

/** The client a tool means: the one named, else the one the call is about */
async function clientOf(ctx: CommsCtx, name: unknown) {
  const named = await clientNamed(ctx.db, name);
  if (named) return named;
  if (!ctx.clientId) return null;
  const { data } = await ctx.db.from("clients").select("id, name, slug").eq("id", ctx.clientId).maybeSingle();
  return (data as { id: string; name: string; slug: string } | null) ?? null;
}

// ─── Threads the person can reply in ────────────────────────────────────────

type Found = {
  ref: string;
  channel: "slack" | "email";
  who: string;
  when: string;
  gist: string;
  client: string | null;
  owedId: string | null;
  slack?: { channel: string; thread: string; where: string };
  email?: { mailbox: string; threadId: string; subject: string };
};

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);

/** The threads waiting on them (owed replies), then the client's recent ones, matching who and what when given */
async function findThreads(ctx: CommsCtx, input: { channel: "slack" | "email"; client: { id: string; name: string } | null; from: string; about: string }): Promise<Found[]> {
  const out: Found[] = [];
  const { data: owed } = await ctx.db
    .from("owed_replies")
    .select("id, source, channel_id, channel_name, thread_ts, message_ts, mailbox, gmail_thread_id, from_name, subject, gist, body, asked_at, client_id, clients(name)")
    .eq("target_id", ctx.me.id)
    .in("status", OPEN)
    .eq("source", input.channel === "slack" ? "slack" : "gmail")
    .order("asked_at", { ascending: false })
    .limit(30);
  type Owed = { id: string; channel_id: string | null; channel_name: string | null; thread_ts: string | null; message_ts: string | null; mailbox: string | null; gmail_thread_id: string | null; from_name: string | null; subject: string | null; gist: string | null; body: string | null; asked_at: string; client_id: string | null; clients: { name: string } | null };
  for (const o of (owed ?? []) as unknown as Owed[]) {
    if (input.client && o.client_id !== input.client.id) continue;
    if (input.channel === "email" && (!o.mailbox || o.mailbox.toLowerCase() !== ctx.me.email.toLowerCase() || !o.gmail_thread_id)) continue;
    if (input.channel === "slack" && (!o.channel_id || !(o.thread_ts ?? o.message_ts))) continue;
    out.push({
      ref: `o:${o.id}`,
      channel: input.channel,
      who: o.from_name ?? "Someone",
      when: o.asked_at,
      gist: clip(o.gist ?? o.subject ?? o.body, 200),
      client: o.clients?.name ?? null,
      owedId: o.id,
      ...(input.channel === "slack" ? { slack: { channel: o.channel_id as string, thread: (o.thread_ts ?? o.message_ts) as string, where: o.channel_name ? `#${o.channel_name}` : "Slack" } } : { email: { mailbox: o.mailbox as string, threadId: o.gmail_thread_id as string, subject: o.subject ?? "" } }),
    });
  }
  if (input.client) {
    const { data: items } = await ctx.db
      .from("context_items")
      .select("id, source, external_id, thread_id, author, title, body, occurred_at, meta")
      .eq("client_id", input.client.id)
      .in("source", input.channel === "slack" ? ["slack_internal", "slack_external"] : ["gmail"])
      .order("occurred_at", { ascending: false })
      .limit(15);
    type Item = { id: string; source: string; external_id: string; thread_id: string | null; author: string | null; title: string | null; body: string | null; occurred_at: string; meta: { mailbox?: string } | null };
    for (const i of (items ?? []) as Item[]) {
      if (input.channel === "slack") {
        const p = slackPlace(i.external_id, i.thread_id);
        if (!p || out.some((f) => f.slack?.channel === p.channel && f.slack.thread === p.thread)) continue;
        out.push({ ref: `c:${i.id}`, channel: "slack", who: i.author ?? "Someone", when: i.occurred_at, gist: clip(i.body, 200), client: input.client.name, owedId: null, slack: { channel: p.channel, thread: p.thread, where: i.source === "slack_internal" ? `${input.client.name}'s internal channel` : `${input.client.name}'s channel` } });
      } else {
        const mailbox = String(i.meta?.mailbox ?? "").toLowerCase();
        if (!i.thread_id || mailbox !== ctx.me.email.toLowerCase() || out.some((f) => f.email?.threadId === i.thread_id)) continue;
        out.push({ ref: `c:${i.id}`, channel: "email", who: i.author ?? "Someone", when: i.occurred_at, gist: clip(i.title ?? i.body, 200), client: input.client.name, owedId: null, email: { mailbox, threadId: i.thread_id, subject: i.title ?? "" } });
      }
    }
  }
  const from = input.from.toLowerCase();
  const about = words(input.about);
  const score = (f: Found) => (from && f.who.toLowerCase().includes(from) ? 2 : 0) + about.filter((w) => f.gist.toLowerCase().includes(w)).length + (f.owedId ? 1 : 0);
  const filtered = from ? out.filter((f) => f.who.toLowerCase().includes(from)) : out;
  return (filtered.length ? filtered : out).sort((a, b) => score(b) - score(a) || b.when.localeCompare(a.when)).slice(0, 6);
}

/** The thread a ref names (from findThreads), read again so a stale or someone else's ref can't be used */
async function threadByRef(ctx: CommsCtx, ref: string, channel: "slack" | "email"): Promise<Found | null> {
  const [kind, id] = ref.split(":");
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
  if (kind === "o") {
    const { data: o } = await ctx.db.from("owed_replies").select("client_id, from_name, clients(name)").eq("id", id).eq("target_id", ctx.me.id).maybeSingle();
    if (!o) return null;
    const all = await findThreads(ctx, { channel, client: o.client_id ? { id: o.client_id as string, name: (o.clients as unknown as { name: string } | null)?.name ?? "" } : null, from: "", about: "" });
    return all.find((f) => f.ref === ref) ?? null;
  }
  if (kind === "c") {
    const { data: i } = await ctx.db.from("context_items").select("client_id, clients(name)").eq("id", id).maybeSingle();
    if (!i) return null;
    const all = await findThreads(ctx, { channel, client: { id: i.client_id as string, name: (i.clients as unknown as { name: string } | null)?.name ?? "" }, from: "", about: "" });
    return all.find((f) => f.ref === ref) ?? null;
  }
  return null;
}

/** An email thread's last message, for a reply that stays in it (read with the read-only token) */
async function lastInThread(mailbox: string, threadId: string): Promise<{ to: string; cc: string | null; subject: string; inReplyTo: string | null; references: string | null } | null> {
  const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
  if (!googleConfigured()) return null;
  type Msg = { payload: { headers: { name: string; value: string }[] } };
  const t = await google<{ messages: Msg[] }>(await gmailToken(mailbox), `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`, { format: "metadata" });
  const last = t.messages.at(-1);
  if (!last) return null;
  const h = (n: string) => last.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  return { to: replyTo({ from: h("from"), to: h("to"), replyTo: h("reply-to") || null }, mailbox), cc: null, subject: reSubject(h("subject")), inReplyTo: h("message-id") || null, references: h("references") || null };
}

/** The draft as a card on the call: edit it, send it (on their yes), or copy it */
function showDraft(ctx: CommsCtx, d: Draft, status: CallDraft["status"], href = "/assistant") {
  if (!ctx.emit) return;
  const where = d.slack?.where ?? (d.email ? `email to ${addressOf(d.email.to)}` : "a message");
  ctx.emit({
    t: "card",
    card: {
      id: `draft-${d.id}`,
      title: status === "sent" ? "Sent as you" : status === "gmail_draft" ? "Saved as a Gmail draft" : d.channel === "slack" ? "Slack reply, drafted" : "Email, drafted",
      detail: where,
      href,
      external: false,
      cta: "Open",
      draft: {
        id: d.id,
        channel: d.channel,
        where,
        text: d.text,
        subject: d.email?.subject ?? null,
        to: d.email?.to ?? null,
        status,
        attachments: fileViews(d.attachments),
        // Without Gmail access: a prefilled compose, with a line saying which PDF to attach
        compose: d.email ? composeLinks({ to: [addressOf(d.email.to)], subject: d.email.subject, body: `${d.text}${attachNote(d.attachments ?? [])}` }).gmail : null,
      },
    },
  });
}

/**
 * A new email to a client, kept with their email drafts as well (Overview's "Emails ready to send"), with its files,
 * so it can be opened into Gmail later. One per draft on the call. Never sent from here.
 */
async function keepClientDraft(ctx: CommsCtx, clientId: string, d: Draft): Promise<string | null> {
  if (!d.email) return null;
  const files = (d.attachments ?? []).map((f) => ({ document_id: f.documentId, name: f.name }));
  const row = { client_id: clientId, owner_id: ctx.me.id, created_by: ctx.me.id, kind: "other", subject: d.email.subject.slice(0, 200), body: d.text.slice(0, 8000), to_emails: [addressOf(d.email.to)], reason: "Drafted with your assistant", source_kind: "assistant", source_id: ctx.callId, source_key: `assistant:${ctx.callId ?? "chat"}:${d.id}`, attachments: files };
  const { data, error } = await ctx.admin.from("client_email_drafts").upsert(row, { onConflict: "source_key" }).select("id").single();
  if (error) {
    // Before the attachments column: kept without the files
    const { attachments: _files, ...plain } = row;
    void _files;
    const again = await ctx.admin.from("client_email_drafts").upsert(plain, { onConflict: "source_key" }).select("id").single();
    return (again.data?.id as string | undefined) ?? null;
  }
  return (data?.id as string | undefined) ?? null;
}

// ─── The tools ──────────────────────────────────────────────────────────────

export function commsTools(ctx: CommsCtx): ChatTool[] {
  const from = firstNameOf(ctx.me.fullName);
  const via = ctx.roleKey === "assistant" ? "via their assistant" : `via the ${ctx.label}`;
  return [
    {
      name: "send_to_teammate",
      description: `Sends a task, an ask or an FYI to a teammate, credited to ${from}: it lands on their Overview (Next for me, cleared when they mark it done), in their bell, and as a Slack message when they've connected Slack. Use it when ${from} asks ("ask Rahul for an update", "tell the head of email", "let Dana know"), when they say yes to a send you proposed, or when they correct who it goes to ("it should be on the Meta buyer": that IS the ask; send what you'd drafted). One yes is enough: never ask them to repeat it. to: a name as heard (spoken variants are fine: "Raul" finds Rahul) or a role ("the Meta buyer", "the strategist", "the account lead"), which on a client goes to whoever sits in that seat for a line the client buys (your own line by default; an empty seat goes to the next owner on the line). If you offered two people and they just say yes, send to the one they named; if it's unclear, ask once in a few words. Then say who you sent it to in a few words.`,
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Who: a name as heard, or a role" },
          kind: { type: "string", enum: ["task", "ask", "fyi"], description: "task: something to do; ask: a question or an update wanted; fyi: just so they know" },
          what: { type: "string", description: "The task, question or note, short and plain, as it should read to them" },
          context: { type: "string", description: "Anything they need with it (one to three sentences)" },
          client: { type: "string", description: "The client it's about, if any" },
          due: { type: "string", description: "YYYY-MM-DD, if a day was said" },
        },
        required: ["to", "what"],
        additionalProperties: false,
      },
      status: (input) => `Sending it to ${clip(input.to, 40) || "them"}…`,
      run: async (input) => {
        const kind = (["task", "ask", "fyi"].includes(String(input.kind)) ? input.kind : "task") as TeammateKind;
        const title = teammateTitle(kind, clip(input.what, 200));
        if (!title) return { sent: false, note: "What should it say? Ask in a few words." };
        const client = await clientOf(ctx, input.client);
        const team = client ? await clientTeam(ctx.admin, client.id) : null;
        const r = await recipientFor(ctx.admin, { to: clip(input.to, 120), client: team, agentRole: ctx.roleKey === "assistant" ? null : ctx.roleKey, exclude: ctx.me.id });
        if (!r.ok) return { sent: false, note: r.note, options: r.options };
        const detail = clip(input.context, 800);
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : null;
        const { data, error } = await ctx.admin
          .from("agent_asks")
          .insert({ kind: "task", owner_id: r.to.id, asked_by: ctx.me.id, role_key: ctx.roleKey, call_id: ctx.callId, client_id: client?.id ?? null, title, detail: detail ? `${kind === "fyi" ? "FYI" : kind === "ask" ? "Asked" : "Task"} ${via}: ${detail}` : `${kind === "fyi" ? "FYI" : kind === "ask" ? "Asked" : "Task"} ${via}`, due_on: due })
          .select("id")
          .single();
        if (error || !data) return { sent: false, error: "It didn't save on our side. Try it again now (no need to ask them again)." };
        const told = r.to.id === ctx.me.id ? { slack: false } : await tellTeammate(ctx.admin, { ownerId: r.to.id, askId: data.id as string, title: `${from}${client ? ` on ${client.name}` : ""}: ${title}`, body: `${detail || title} (${via.replace("their", `${from}'s`)})` });
        return { sent: true, to: firstNameOf(r.to.name), routed: r.to.why ?? undefined, on: "their Overview and bell", slack: told.slack, note: r.to.why ? "Say who it went to and why, in a few words." : "Say who it went to, in a few words." };
      },
    },
    {
      name: "draft_message",
      description: `Drafts a Slack reply or an email as ${from}, in their voice (a message to a person; campaign, flow or SMS copy for the email team is never this: that's create_copy_doc): a reply in the exact thread they mean (the ones waiting on them first, then the client's recent threads), or a new email (to and subject). On a call it shows as a card they can edit and approve, with a copy button. Write the text yourself, short, the way they write (leave text out on a reply that's waiting on them and it's written in their voice for you). Several threads fit: list them in a few words and ask which (thread: its ref). A document goes with an email: make it first (create_document), then pass its document_id in attach (the card offers Open in Gmail with the PDF attached, and the PDF to download). After drafting, read it back in a sentence or say it's on screen, then ask "send it?"; send only with send_message on their yes.`,
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["slack", "email"] },
          thread: { type: "string", description: "A thread's ref from an earlier draft_message answer" },
          client: { type: "string", description: "The client the thread is about" },
          from: { type: "string", description: "Who wrote the message being replied to, as said" },
          about: { type: "string", description: "What the thread is about, a few words" },
          text: { type: "string", description: "The message, as it will be sent" },
          to: { type: "string", description: "A new email's address (not a reply)" },
          subject: { type: "string", description: "A new email's subject" },
          attach: { type: "array", items: { type: "string" }, description: "An email only: document_id(s) from create_document whose PDF goes with it" },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      status: () => "Drafting it…",
      run: async (input) => {
        // Campaign, flow or SMS copy is a document for the email team, never an email to a contact
        const asked = emailWritingKind(ctx.said());
        if (asked && asked !== "message" && !input.thread) return { drafted: false, note: "That's campaign copy for the email team, not a message to anyone: don't address a contact. Run the deliverable flow (the Email Strategist leads, the Copywriter writes it with create_copy_doc)." };
        const channel = input.channel === "email" ? "email" : "slack";
        const client = await clientOf(ctx, input.client);
        let text = body(input.text, 4000);
        const id = crypto.randomUUID().slice(0, 12);
        let d: Draft;
        const fresh = channel === "email" && clip(input.to, 200) && !input.thread;
        if (fresh) {
          const to = clip(input.to, 200);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addressOf(to))) return { drafted: false, note: "That isn't an email address. Ask for it." };
          if (!text) return { drafted: false, note: "Write the email's text, then draft it again." };
          d = { kind: "draft", id, done: true, channel, email: { mailbox: ctx.me.email, threadId: null, to, subject: clip(input.subject, 200) || "(no subject)" }, text, client: client?.name ?? null, at: new Date().toISOString() };
        } else {
          const found = input.thread ? await threadByRef(ctx, clip(input.thread, 60), channel) : null;
          let pick = found;
          if (!pick) {
            const all = await findThreads(ctx, { channel, client, from: clip(input.from, 60), about: clip(input.about, 120) });
            if (!all.length) return { drafted: false, note: `No ${channel === "slack" ? "Slack thread" : "email thread in your mailbox"} found${client ? ` for ${client.name}` : ""}. Ask which one, or who it's with.` };
            const clear = all.length === 1 || Boolean(input.from) || Boolean(input.about);
            if (!clear) return { drafted: false, which: all.map((f) => ({ ref: f.ref, from: f.who, about: f.gist, client: f.client, when: f.when })), note: "Several threads fit: name two or three in a few words (who and what) and ask which." };
            pick = all[0];
          }
          if (!text && pick.owedId) {
            const { draftOwedReply } = await import("@/lib/reply-drafts");
            const r = await draftOwedReply(ctx.admin, pick.owedId);
            if (r.ok) text = r.draft;
          }
          if (!text) return { drafted: false, note: "Write the reply's text, then draft it again with this thread.", thread: pick.ref };
          if (pick.slack) d = { kind: "draft", id, done: true, channel, slack: { ...pick.slack, where: `${pick.slack.where}, reply to ${pick.who}` }, text, client: pick.client, owedId: pick.owedId, at: new Date().toISOString() };
          else {
            const last = await lastInThread(pick.email!.mailbox, pick.email!.threadId).catch(() => null);
            d = { kind: "draft", id, done: true, channel, email: { mailbox: pick.email!.mailbox, threadId: pick.email!.threadId, to: last?.to ?? pick.who, subject: last?.subject ?? reSubject(pick.email!.subject), inReplyTo: last?.inReplyTo ?? null, references: last?.references ?? null }, text, client: pick.client, owedId: pick.owedId, at: new Date().toISOString() };
          }
        }
        // Files go with an email only: the documents they may see, by id
        const files = channel === "email" && input.attach ? await draftFiles(ctx.db, input.attach) : [];
        if (files.length) d.attachments = files;
        const askedFiles = Array.isArray(input.attach) ? input.attach.length : input.attach ? 1 : 0;
        // A new email to a client is also kept with their email drafts (Overview's "Emails ready to send"), files and all
        if (fresh && client) d.clientDraftId = await keepClientDraft(ctx, client.id, d).catch(() => null);
        if (!ctx.callId) return { drafted: true, text: d.text, where: d.slack?.where ?? d.email?.to, attached: files.map((f) => f.name), note: "Show the text so they can copy it; sending as them works on a call." };
        await putDraft(ctx.admin, ctx.callId, d);
        showDraft(ctx, d, "draft");
        return {
          drafted: true,
          draft_id: d.id,
          where: d.slack?.where ?? `email to ${d.email?.to}`,
          text: d.text,
          ...(files.length ? { attached: files.map((f) => f.name) } : {}),
          ...(askedFiles > files.length ? { not_attached: askedFiles - files.length, why: "Those documents weren't found or aren't theirs to attach. Make the document first (create_document) and attach its document_id." } : {}),
          note: "It's on screen to edit (with Open in Gmail and the PDF to download). Read it back in a sentence or two, then ask if you should send it. Send only on their yes (send_message).",
        };
      },
    },
    {
      name: "send_message",
      description: `Sends a drafted message (draft_message) as ${from}, after they clearly said yes to it on this turn (or tapped Approve on the card): a Slack reply posted as them in the exact thread (their Slack must be connected), or an email reply in the Gmail thread from their mailbox. If sending as them isn't possible it says what happened instead (Slack: how to connect; email: saved as a Gmail draft, else the card's copy button). The text on the card is what's sent (they may have edited it).`,
      input_schema: { type: "object", properties: { draft_id: { type: "string", description: "The draft's id (leave out for the latest draft on this call)" }, confirmed: CONFIRMED }, additionalProperties: false },
      status: () => "Sending it…",
      run: async (input) => {
        if (!ctx.callId) return { sent: false, note: "Sending as them works on a call. Show the text to copy." };
        const carried = input.confirmed === true && (await carriedYes(ctx.admin, ctx.callId)).has("send_message");
        if (input.confirmed !== true || (!saidYes(ctx.said()) && !carried)) return { sent: false, note: "Not run: say what will be sent and where in a sentence, then ask; send with confirmed: true on their yes." };
        const d = input.draft_id ? await getDraft(ctx.admin, ctx.callId, clip(input.draft_id, 40)) : await latestDraft(ctx.admin, ctx.callId);
        if (!d) return { sent: false, note: "That draft isn't on this call. Draft it again." };
        if (d.sent) return { sent: true, already: true };
        if (d.slack) {
          const { postAsUser } = await import("@/lib/slack-user");
          const r = await postAsUser(ctx.me.id, { channel: d.slack.channel, text: d.text, thread: d.slack.thread ?? undefined });
          if (!r.ok) {
            if (r.needsConnect) {
              ctx.emit?.({ t: "card", card: { id: "connect-slack", title: "Connect your Slack", detail: "So replies go out as you", href: "/api/slack/connect?next=%2Fassistant", external: true, cta: "Connect" } });
              return { sent: false, needs: "slack", note: "Their Slack isn't connected (or it expired). Say so in a sentence: connect it from the card, then you'll send it. The draft stays on screen to copy meanwhile." };
            }
            return { sent: false, error: r.error };
          }
          await putDraft(ctx.admin, ctx.callId, { ...d, sent: "slack" });
          showDraft(ctx, { ...d, sent: "slack" }, "sent");
          if (d.owedId) await ctx.admin.from("owed_replies").update({ status: "answered", answered_at: new Date().toISOString() }).eq("id", d.owedId).eq("target_id", ctx.me.id);
          return { sent: true, where: d.slack.where, link: r.permalink ?? null };
        }
        const e = d.email!;
        if (e.mailbox.toLowerCase() !== ctx.me.email.toLowerCase()) return { sent: false, note: "That thread isn't in their own mailbox, so it can't go out as them." };
        const { gmailComposeToken, gmailSendToken, googleConfigured, googlePost } = await import("@/lib/context/google");
        if (!googleConfigured()) {
          showDraft(ctx, d, "copy");
          return { sent: false, fallback: "copy", note: "Google isn't connected, so it can't send: the draft is on screen with a copy button." };
        }
        const { attached, missing } = await mailFiles(ctx.admin, d.attachments ?? []);
        if (missing.length) return { sent: false, error: `The file${missing.length === 1 ? "" : "s"} ${missing.join(", ")} couldn't be read, so nothing went out. Make the document again and attach it.` };
        const raw = rawEmail({ from: `${ctx.me.fullName} <${e.mailbox}>`, to: e.to, cc: e.cc ?? null, subject: e.subject, body: d.text, inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, attachments: attached });
        const msg = { raw, ...(e.threadId ? { threadId: e.threadId } : {}) };
        try {
          const token = await gmailSendToken(e.mailbox);
          await googlePost(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", msg);
          await putDraft(ctx.admin, ctx.callId, { ...d, sent: "gmail" });
          if (d.clientDraftId) await ctx.admin.from("client_email_drafts").update({ status: "sent", updated_at: new Date().toISOString() }).eq("id", d.clientDraftId).eq("owner_id", ctx.me.id);
          showDraft(ctx, { ...d, sent: "gmail" }, "sent");
          if (d.owedId) await ctx.admin.from("owed_replies").update({ status: "answered", answered_at: new Date().toISOString() }).eq("id", d.owedId).eq("target_id", ctx.me.id);
          return { sent: true, where: `email to ${addressOf(e.to)}` };
        } catch (sendErr) {
          console.error("[send_message] gmail send", sendErr instanceof Error ? sendErr.message : sendErr);
          try {
            const token = await gmailComposeToken(e.mailbox);
            const made = await googlePost<{ id: string }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: msg });
            await putDraft(ctx.admin, ctx.callId, { ...d, sent: "gmail_draft" });
            if (d.clientDraftId) await ctx.admin.from("client_email_drafts").update({ status: "opened", gmail_draft_id: made.id, updated_at: new Date().toISOString() }).eq("id", d.clientDraftId).eq("owner_id", ctx.me.id);
            showDraft(ctx, { ...d, sent: "gmail_draft" }, "gmail_draft");
            return { sent: false, fallback: "gmail_draft", note: "Sending email as them isn't switched on, so it's saved as a draft in their Gmail, in the thread: say so in a sentence (one click to send there)." };
          } catch (draftErr) {
            console.error("[send_message] gmail draft", draftErr instanceof Error ? draftErr.message : draftErr);
            showDraft(ctx, d, "copy");
            return { sent: false, fallback: "copy", note: "Email can't go out as them from the app yet: the draft is on screen with a copy button. Say so in a sentence." };
          }
        }
      },
    },
    {
      name: "flag_client_risk",
      description: `When ${from} says a client is probably leaving ("they're probably gonna be canceling", "I think we're losing them"), note it: a dated note in the client's memory and a retention-risk flag, so their work moves up on everyone's Overview. Run it as soon as it's said (no need to ask), then say so in a few words ("Noted, I've flagged them as at risk") and carry on with what they asked.`,
      input_schema: { type: "object", properties: { client: { type: "string" }, why: { type: "string", description: "What was said, in a short line (\"probably canceling, pushing work off\")" } }, required: ["client", "why"], additionalProperties: false },
      status: (input) => `Noting ${clip(input.client, 40) || "it"}…`,
      run: async (input) => {
        const client = await clientOf(ctx, input.client);
        if (!client) return { noted: false, note: "Which client? Ask in a few words." };
        const day = nyDay();
        const { data: had } = await ctx.db.from("client_memory").select("id").eq("client_id", client.id).eq("status", "active").like("body", `${RISK_PREFIX} (said%`).gte("created_at", `${day}T00:00:00Z`).limit(1);
        if ((had ?? []).length) return { noted: true, already: true, client: client.name };
        const note = riskNote(clip(input.why, 600), day);
        const { error } = await ctx.db.from("client_memory").insert({ client_id: client.id, kind: "note", body: note, source: "team", created_by: ctx.me.id });
        if (error) return { noted: false, error: "It didn't save. Try again." };
        // A client probably leaving is on fire: every exec hears, once today
        await import("@/lib/exec-focus/server").then(({ raiseFireAsAdmin }) => raiseFireAsAdmin({ clientId: client.id, client: client.name, signal: { kind: "risk_flag" }, body: note })).catch(() => undefined);
        return { noted: true, client: client.name, note: "Say it in a few words: noted, flagged as at risk, their work moves up." };
      },
    },
    {
      name: "submit_feedback",
      description: `Files feedback about the app when ${from} says "submit feedback", "report a bug", "I have an idea for…" (to you or any agent): sum it up in one line and confirm ("Got it: <one line>. Filing it."), then run this. It goes down the same path as the in-app report form, with this call's recent lines and the screen they're on attached: a bug goes straight to the fix pipeline; an idea goes to the owner to approve or comment on. Say in a few words where it went.`,
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What they reported or want, in their words, one to four sentences" },
          type: { type: "string", enum: ["bug", "idea", "confusing"], description: "Leave out to read it from what they said" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      status: () => "Filing it…",
      run: async (input) => {
        const summary = body(input.summary, 3000);
        if (!summary) return { filed: false, note: "What's the feedback? Ask in a few words." };
        const type: FeedbackType = ["bug", "idea", "confusing"].includes(String(input.type)) ? (input.type as FeedbackType) : spokenFeedbackType(`${summary} ${ctx.said()}`);
        const { fileFeedbackFromCall } = await import("@/lib/feedback-call");
        const r = await fileFeedbackFromCall(ctx.db, ctx.admin, ctx.me, { type, message: summary, callId: ctx.callId, roleKey: ctx.roleKey, label: ctx.roleKey === "assistant" ? "assistant" : ctx.label, path: ctx.path ?? null, screen: ctx.screen ?? null, clientId: ctx.clientId ?? null });
        if (!r.ok) return { filed: false, error: r.error };
        ctx.emit?.({ t: "card", card: { id: `feedback-${r.id.slice(0, 8)}`, title: type === "idea" ? "Your idea is filed" : "Your report is filed", detail: feedbackPath(type).path === "owner" ? "With the owner to approve" : "On its way to a fix", href: "/feedback?tab=mine", external: false, cta: "Open it" } });
        return { filed: true, id: r.id, type, where: r.says };
      },
    },
  ];
}
