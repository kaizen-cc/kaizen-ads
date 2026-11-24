import "server-only";
import { emailWritingKind } from "@/lib/copy-docs/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientNamedOrNull } from "@/lib/client-named";
import { maySeeClient } from "@/lib/ai-access";
import type { Staff } from "@/lib/auth";
import type { CallDraft, CallEvent } from "@/lib/agent-call/core";
import { firstNameOf } from "@/lib/agent-call/core";
import type { ChatTool } from "@/lib/kaizen-ai/tools";
import { feedbackPath, spokenFeedbackType, type FeedbackType } from "@/lib/feedback-logic";
import { riskNote, RISK_PREFIX } from "@/lib/client-risk";
import { saidYes } from "./core";
import { clientTeam, recipientFor } from "./routing-server";
import { allDrafts, carriedYes, getDraft, latestDraft, putDraft, tellTeammate, type Draft } from "./handoff-server";
import { addressOf, gmailThreadId, reSubject, rawEmail, replyAllCc, replyTo, slackPlace, subjectCore } from "./messages";
import { attachNote, draftFiles, fileViews, mailFiles } from "@/lib/documents/attach";
import { composeLinks } from "@/lib/email-drafts/core";
import { teammateTitle, type TeammateKind } from "./teammates";
import { channelKey, groupDmIds, isJustMe, slackChannelPlace, slackGroupPlace, tagMentions } from "./platform-drafts-core";
import { placeCallDraft } from "./platform-drafts";
import { slackDmPlace, slackNewPlace } from "./platform-drafts-core";

// What the assistant and every agent can do for the person with the team and their messages, on a call or in a chat:
// send a task, an ask or an FYI to any teammate by name or role (send_to_teammate); draft a Slack reply or an email as
// them, shown on the call to edit (draft_message), put it in their own Gmail drafts or Slack self-DM to edit and send
// there (save_draft, no yes needed: nothing leaves), and send it in the exact thread on a spoken yes (send_message);
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
  if (named) return (await maySeeClient(ctx, named.id)) ? named : null;
  if (!ctx.clientId) return null;
  const { data } = await ctx.db.from("clients").select("id, name, slug").eq("id", ctx.clientId).maybeSingle();
  const c = (data as { id: string; name: string; slug: string } | null) ?? null;
  return c && (await maySeeClient(ctx, c.id)) ? c : null;
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
  slack?: { channel: string; thread: string | null; where: string };
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
    .select("id, source, message_key, channel_id, channel_name, thread_ts, message_ts, mailbox, gmail_thread_id, from_name, subject, gist, body, asked_at, client_id, clients(name)")
    .eq("target_id", ctx.me.id)
    .in("status", OPEN)
    .eq("source", input.channel === "slack" ? "slack" : "gmail")
    .order("asked_at", { ascending: false })
    .limit(30);
  type Owed = { id: string; message_key: string | null; channel_id: string | null; channel_name: string | null; thread_ts: string | null; message_ts: string | null; mailbox: string | null; gmail_thread_id: string | null; from_name: string | null; subject: string | null; gist: string | null; body: string | null; asked_at: string; client_id: string | null; clients: { name: string } | null };
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
      ...(input.channel === "slack" ? { slack: String(o.message_key ?? "").startsWith("dm:") ? { channel: o.channel_id as string, thread: null, where: o.channel_name ?? "a DM" } : { channel: o.channel_id as string, thread: (o.thread_ts ?? o.message_ts) as string, where: o.channel_name ? `#${o.channel_name}` : "Slack" } } : { email: { mailbox: o.mailbox as string, threadId: o.gmail_thread_id as string, subject: o.subject ?? "" } }),
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

/** A teammate's Slack user: from their connected Slack, else their profile, else found by work email (and saved) */
async function teammateSlackId(ctx: CommsCtx, profileId: string): Promise<string | null> {
  const { data: t } = await ctx.admin.from("slack_user_tokens").select("slack_user_id").eq("profile_id", profileId).maybeSingle();
  if (t?.slack_user_id) return String(t.slack_user_id);
  const { data: p } = await ctx.admin.from("profiles").select("email, slack_user_id").eq("id", profileId).maybeSingle();
  if (p?.slack_user_id) return String(p.slack_user_id);
  if (!p?.email) return null;
  const { findSlackUser } = await import("@/lib/profile-slack");
  const found = await findSlackUser(String(p.email)).catch(() => null);
  if (found?.id) await ctx.admin.from("profiles").update({ slack_user_id: found.id }).eq("id", profileId);
  return found?.id ?? null;
}

/**
 * Someone to DM, by name: a teammate (name or role), else a client contact (the client's, when one is named), found in
 * Slack by their email (a Slack Connect guest or a member of a shared channel)
 */
async function slackPersonNamed(ctx: CommsCtx, name: string, client: { id: string; name: string } | null): Promise<{ ok: true; person: { id: string; name: string } } | { ok: false; note: string; options?: string[] }> {
  const r = await recipientFor(ctx.admin, { to: name, client: null, agentRole: null, exclude: ctx.me.id });
  if (r.ok) {
    const id = await teammateSlackId(ctx, r.to.id);
    if (!id) return { ok: false, note: `${r.to.name} isn't found in Slack (no Slack account matches their work email). Say so in a sentence.` };
    return { ok: true, person: { id, name: firstNameOf(r.to.name) } };
  }
  if (r.options?.length) return { ok: false, note: r.note, options: r.options };
  // A client contact: their email, then their Slack user
  let q = ctx.db.from("contact_clients").select("client_id, contacts(full_name, email)").is("removed_at", null);
  if (client) q = q.eq("client_id", client.id);
  const { data } = await q.limit(400);
  const want = name.toLowerCase();
  const hits = ((data ?? []) as unknown as { contacts: { full_name: string | null; email: string | null } | null }[])
    .map((x) => x.contacts)
    .filter((c): c is { full_name: string; email: string } => Boolean(c?.full_name && c.email))
    .filter((c) => c.full_name.toLowerCase() === want || c.full_name.toLowerCase().split(/\s+/)[0] === want);
  const unique = [...new Map(hits.map((h) => [h.email.toLowerCase(), h])).values()];
  if (unique.length > 1) return { ok: false, note: "More than one contact has that name: ask which (and the client) in a few words.", options: unique.map((h) => h.full_name) };
  if (!unique.length) return { ok: false, note: `No teammate or client contact called "${name}" is on file. Ask who they meant in a few words.` };
  const { findSlackUser } = await import("@/lib/profile-slack");
  const found = await findSlackUser(unique[0].email).catch(() => null);
  if (!found?.id) return { ok: false, note: `${unique[0].full_name} isn't in Slack with us (no Slack account matches their email). Offer an email instead.` };
  return { ok: true, person: { id: found.id, name: unique[0].full_name.split(/\s+/)[0] } };
}

/** A channel as said ("the OO channel", "La Jetée's internal channel"): the client's own channels first, then by name */
async function channelNamed(ctx: CommsCtx, said: string, client: { id: string; name: string } | null): Promise<{ id: string; name: string } | null> {
  if (client) {
    const { data: c } = await ctx.db.from("clients").select("slack_channel_id, internal_slack_channel_id").eq("id", client.id).maybeSingle();
    const internal = /\binternal\b/i.test(said);
    const id = (internal ? c?.internal_slack_channel_id : c?.slack_channel_id) as string | null | undefined;
    if (id) return { id, name: `${client.name}${internal ? " internal" : ""}` };
  }
  const key = channelKey(said);
  if (!key) return null;
  const { listChannels } = await import("@/lib/context/slack");
  const all = await listChannels().catch(() => []);
  const hit = all.find((ch) => ch.name === key) ?? all.find((ch) => ch.name.replace(/-/g, "") === key.replace(/-/g, ""));
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** A new group DM opened as the person (conversations.open with their own token; needs mpim:write) */
async function openGroupDm(ctx: CommsCtx, users: string[]): Promise<{ ok: true; channel: string } | { ok: false; answer: Record<string, unknown> }> {
  const { slackUserToken, slackRead } = await import("@/lib/slack-user");
  const t = await slackUserToken(ctx.me.id);
  if (!t) return { ok: false, answer: await connectSlack(ctx, "missing") };
  const r = await slackRead<{ ok: boolean; error?: string; channel?: { id: string } }>(t.token, "conversations.open", { users: users.join(",") });
  if (r.ok && r.channel?.id) return { ok: true, channel: r.channel.id };
  if (r.error === "missing_scope") {
    const { needsConnection } = await import("@/lib/personal-connections-core");
    const n = needsConnection("slack", "missing_scope", { missing: ["mpim:write"], what: "start a group DM as you" });
    const link = `/api/slack/connect?read=1&dm=1&next=${encodeURIComponent("/connected?service=slack")}`;
    ctx.emit?.({ t: "card", card: { id: "connect-slack", title: "Reconnect your Slack", detail: "So I can start group DMs as you", href: link, external: true, cta: "Reconnect", connect: { service: "slack" } } });
    return { ok: false, answer: { ...n, needs_connection: { ...n.needs_connection, link }, note: "Starting a group DM needs one more Slack permission: say so in a sentence, the Reconnect card is on screen. If Slack refuses it, an admin adds im:write and mpim:write to the Slack app first (they've been told). The draft stays on screen to copy meanwhile." } };
  }
  return { ok: false, answer: { error: `Slack couldn't open the group DM (${r.error ?? "no reason given"}).` } };
}

/** @Name for teammates in Slack as real mentions */
async function withMentions(ctx: CommsCtx, text: string): Promise<string> {
  if (!text.includes("@")) return text;
  const { data } = await ctx.admin.from("profiles").select("full_name, slack_user_id").eq("is_active", true).not("slack_user_id", "is", null);
  return tagMentions(text, ((data ?? []) as { full_name: string | null; slack_user_id: string }[]).map((p) => ({ name: p.full_name ?? "", slackId: p.slack_user_id })));
}

/** An email thread's last message, for a reply that stays in it (read with the read-only token) */
async function lastInThread(mailbox: string, threadId: string, all = false): Promise<{ to: string; cc: string | null; subject: string; inReplyTo: string | null; references: string | null } | null> {
  const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
  if (!googleConfigured()) return null;
  type Msg = { payload: { headers: { name: string; value: string }[] } };
  const t = await google<{ messages: Msg[] }>(await gmailToken(mailbox), `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`, { format: "metadata" });
  const last = t.messages.at(-1);
  if (!last) return null;
  const h = (n: string) => last.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  const to = replyTo({ from: h("from"), to: h("to"), replyTo: h("reply-to") || null }, mailbox);
  return { to, cc: all ? replyAllCc({ to: h("to"), cc: h("cc") || null }, mailbox, to) : null, subject: reSubject(h("subject")), inReplyTo: h("message-id") || null, references: h("references") || null };
}

/**
 * The thread a "new" email with a reply's subject belongs to: the newest thread in their mailbox with that subject
 * and that person (to or from), so "Re: …" never starts a second thread beside the real one
 */
async function threadForReply(mailbox: string, to: string, subject: string): Promise<string | null> {
  const core = subjectCore(subject);
  const who = addressOf(to);
  if (!core || !who) return null;
  const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
  if (!googleConfigured()) return null;
  const q = `subject:"${core.replace(/"/g, "")}" (from:${who} OR to:${who}) newer_than:180d`;
  const r = await google<{ threads?: { id: string }[] }>(await gmailToken(mailbox), "https://gmail.googleapis.com/gmail/v1/users/me/threads", { q, maxResults: "1" }).catch(() => null);
  return r?.threads?.[0]?.id ?? null;
}

/** The draft as a card on the call: edit it, send it (on their yes), or copy it */
function showDraft(ctx: CommsCtx, d: Draft, status: CallDraft["status"], href = "/assistant", external = false) {
  if (!ctx.emit) return;
  const where = d.slack?.where ?? (d.email ? `email to ${addressOf(d.email.to)}` : "a message");
  ctx.emit({
    t: "card",
    card: {
      id: `draft-${d.id}`,
      title: status === "sent" ? "Sent as you" : status === "gmail_draft" ? "Saved as a Gmail draft" : status === "slack_draft" ? "In your Slack, to send" : d.channel === "slack" ? (d.slack && !d.slack.thread ? (d.slack.channel ? "Slack DM, drafted" : "Slack message, drafted") : "Slack reply, drafted") : "Email, drafted",
      detail: where,
      href,
      external,
      cta: status === "gmail_draft" ? "Open in Gmail" : status === "slack_draft" ? "Open in Slack" : "Open",
      draft: {
        id: d.id,
        channel: d.channel,
        where,
        text: d.text,
        subject: d.email?.subject ?? null,
        to: d.email?.to ?? null,
        status,
        link: external ? href : null,
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

/**
 * A call draft into the person's own Gmail drafts (email) or Slack self-DM (Slack), marked on the call and shown on the
 * card with its link. Their own mailbox only. Never sends.
 */
async function saveDraftToPlatform(ctx: CommsCtx, d: Draft): Promise<{ ok: true; where: string; href: string | null; unsure?: boolean } | { ok: false; error: string; needs?: "slack" | "google_admin" }> {
  const r = await placeCallDraft(ctx.admin, ctx.me, ctx.callId!, d);
  if (!r.ok) {
    if (r.needsConnect) await connectSlack(ctx, "reconnect");
    return { ok: false, error: r.error, needs: r.needsConnect ? "slack" : r.scope ? "google_admin" : undefined };
  }
  showDraft(ctx, r.draft, d.slack ? "slack_draft" : "gmail_draft", r.href ?? "/assistant", Boolean(r.href));
  // An older Slack connection can't find their own self-DM: it may have landed in their DM with Slackbot instead, and
  // reconnecting (one tap) makes it land in "message to yourself" every time
  if (r.unsure) {
    const [{ needsConnection }, { showConnect }] = await Promise.all([import("@/lib/personal-connections-core"), import("@/lib/personal-connections")]);
    showConnect(ctx.emit, needsConnection("slack", "missing_scope"));
  }
  return { ok: true, where: r.where, href: r.href, unsure: r.unsure };
}

/** Slack needs connecting (or reconnecting): the card on screen, and the needs_connection answer */
async function connectSlack(ctx: CommsCtx, state: "missing" | "reconnect") {
  const [{ needsConnection }, { showConnect, slackConnection }] = await Promise.all([import("@/lib/personal-connections-core"), import("@/lib/personal-connections")]);
  const now = await slackConnection(ctx.me.id).catch(() => null);
  const n = needsConnection("slack", now?.state === "missing" ? "missing" : state);
  showConnect(ctx.emit, n);
  return n;
}

// ─── The tools ──────────────────────────────────────────────────────────────

/** The first name of a teammate whose address appears among these recipients, or null (a client's contacts aren't teammates) */
async function teammateNamed(ctx: CommsCtx, to: string): Promise<string | null> {
  const emails = [...to.matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)].map((m) => m[0].toLowerCase());
  if (!emails.length) return null;
  const { data } = await ctx.admin.from("profiles").select("full_name, email").in("email", emails).limit(1);
  const hit = (data ?? [])[0];
  if (hit) return firstNameOf(hit.full_name as string);
  return emails.some((e) => e.endsWith("@kaizenmarketing.agency")) ? (emails.find((e) => e.endsWith("@kaizenmarketing.agency")) ?? "").split("@")[0] : null;
}

export function commsTools(ctx: CommsCtx): ChatTool[] {
  const from = firstNameOf(ctx.me.fullName);
  const via = ctx.roleKey === "assistant" ? "via their assistant" : `via the ${ctx.label}`;
  const tools: ChatTool[] = [
    {
      name: "send_to_teammate",
      description: `Sends a task, an ask or an FYI to a teammate, credited to ${from}: it lands on their Overview (Next for me, cleared when they mark it done), in their bell, and as a Slack message when they've connected Slack. Use it when ${from} asks ("ask Rahul for an update", "tell the head of email", "let Dana know"), when they say yes to a send you proposed, or when they correct who it goes to ("it should be on the Meta buyer": that IS the ask; send what you'd drafted). One yes is enough: never ask them to repeat it. to: a name as heard (spoken variants are fine: "Raul" finds Rahul) or a role ("the Meta buyer", "the strategist", "the account lead"), which on a client goes to whoever sits in that seat for a line the client buys (your own line by default; an empty seat goes to the next owner on the line). If you offered two people and they just say yes, send to the one they named; if it's unclear, ask once in a few words. Then say who you sent it to in a few words. Handing over something already on ${from}'s plate ("give this to Dana", "delegate that"): pass item (a my_day key, a reminder's id as ask:<id>, or a promise:/suggestion: ref) so it leaves ${from}'s dashboard and stays with the new owner only. One line of a reminder's checklist (a client's follow-ups are one reminder, one line each) is ask:<id>#<n>, n counted from 1: only that line goes, so each line can go to a different teammate; never pass the whole ask:<id> for one line.`,
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Who: a name as heard, or a role" },
          kind: { type: "string", enum: ["task", "ask", "fyi"], description: "task: something to do; ask: a question or an update wanted; fyi: just so they know" },
          what: { type: "string", description: "The task, question or note, short and plain, as it should read to them" },
          context: { type: "string", description: "Anything they need with it (one to three sentences)" },
          client: { type: "string", description: "The client it's about, if any" },
          due: { type: "string", description: "YYYY-MM-DD, if a day was said" },
          urgent: { type: "boolean", description: "Time-sensitive (\"I need this in the next hour\", \"urgent\"): from an exec, a line head or a creative lead it rings their assistant as an urgent alert" },
          checklist: { type: "array", items: { type: "string" }, description: "Several steps for them: each one a line they tick off (they tick and reply on their Overview; the sender sees the progress under Sent by you)" },
          item: { type: "string", description: "What's being handed over from their own plate, when it is: a my_day key, ask:<id> for one of their reminders or tasks (ask:<id>#<n> for just line n of its checklist, from 1), or a promise:/suggestion: ref" },
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
        // On a client, a task or an ask comes from the client's buyer, strategist or social media manager, a head or an exec (an FYI from anyone)
        if (client) {
          const may = await (await import("@/lib/line-actions-server")).mayAskOn(ctx.admin, { id: ctx.me.id, role: ctx.me.role, isExec: ctx.me.isExec }, client.id, kind);
          if (!may.ok) return { sent: false, note: may.reason };
        }
        const team = client ? await clientTeam(ctx.admin, client.id) : null;
        const r = await recipientFor(ctx.admin, { to: clip(input.to, 120), client: team, agentRole: ctx.roleKey === "assistant" ? null : ctx.roleKey, exclude: ctx.me.id });
        if (!r.ok) return { sent: false, note: r.note, options: r.options };
        const detail = clip(input.context, 800);
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : null;
        // Handing over something on their own plate: tied back to it, and it leaves their dashboard (creative team, Nov 20
        // 2026: a task delegated through the assistant kept resurfacing on the old owner's dashboard)
        // Said twice within minutes (a retry, a reworded repeat): it's already with them, once (owner, Nov 24 2026)
        {
          const { sameAsk, SAME_ASK_WINDOW_MS } = await import("@/lib/agent-asks-core");
          const now = new Date().toISOString();
          const { data: recent } = await ctx.admin.from("agent_asks").select("id, owner_id, asked_by, title, created_at").eq("owner_id", r.to.id).eq("asked_by", ctx.me.id).eq("status", "open").gte("created_at", new Date(Date.now() - SAME_ASK_WINDOW_MS).toISOString()).limit(20);
          const twin = ((recent ?? []) as { id: string; owner_id: string; asked_by: string | null; title: string; created_at: string }[]).find((x) => sameAsk(x, { owner_id: r.to.id, asked_by: ctx.me.id, title, created_at: now }));
          if (twin) return { sent: true, to: firstNameOf(r.to.name), already: true, open: (await import("@/lib/sent-asks")).sentHref(twin.id), note: "It was already sent a moment ago: say it's with them, once." };
        }
        const handed = await (await import("@/lib/handover")).handedItem(ctx.db, ctx.me.id, clip(input.item, 200));
        const sentList = (Array.isArray(input.checklist) ? input.checklist : []).map((t) => clip(t, 200)).filter(Boolean).slice(0, 40).map((text) => ({ text, done: false }));
        const { data, error } = await ctx.admin
          .from("agent_asks")
          .insert({ kind: "task", owner_id: r.to.id, asked_by: ctx.me.id, role_key: ctx.roleKey, call_id: ctx.callId, client_id: client?.id ?? null, title, detail: detail ? `${kind === "fyi" ? "FYI" : kind === "ask" ? "Asked" : "Task"} ${via}: ${detail}` : `${kind === "fyi" ? "FYI" : kind === "ask" ? "Asked" : "Task"} ${via}`, due_on: due, urgent: input.urgent === true, ...(handed ? { source_ref: handed.ref } : {}), ...(sentList.length ? { checklist: sentList } : handed?.checklist ? { checklist: handed.checklist } : {}) })
          .select("id")
          .single();
        if (error || !data) return { sent: false, error: "It didn't save on our side. Try it again now (no need to ask them again)." };
        if (handed) await handed.clear(ctx.admin, r.to.name);
        const told = r.to.id === ctx.me.id ? { slack: false } : await tellTeammate(ctx.admin, { ownerId: r.to.id, askId: data.id as string, title: `${from}${client ? ` on ${client.name}` : ""}: ${title}`, body: `${detail || title} (${via.replace("their", `${from}'s`)})` });
        return { sent: true, to: firstNameOf(r.to.name), routed: r.to.why ?? undefined, on: "their Overview and bell", open: (await import("@/lib/sent-asks")).sentHref(data.id as string), slack: told.slack, note: r.to.why ? "Say who it went to and why, in a few words." : "Say who it went to, in a few words." };
      },
    },
    {
      name: "find_email_address",
      description: `Finds someone's email address before you ever ask for it: a client's contact or anyone ${from} has emailed. It looks in order: the client's contacts in Kaizen OS, ${from}'s whole Gmail (from, to and cc, by name and by the client's domain, every folder), the client's Slack channel members; when nothing turns up it offers a likely address from the client's pattern (firstname@theirdomain.com) as a suggestion to confirm. Run it for every person named for an email you don't have the address of, before drafting. Only ask ${from} when it finds nothing, and then say where it looked and offer the suggestion.`,
      input_schema: { type: "object", properties: { name: { type: "string", description: "The person, as said" }, client: { type: "string", description: "The client they're with, if any" } }, required: ["name"], additionalProperties: false },
      status: (input) => `Looking for ${clip(input.name, 40) || "their"} address…`,
      run: async (input) => {
        const name = clip(input.name, 80);
        if (!name) return { note: "Whose address?" };
        const client = await clientOf(ctx, input.client);
        const { findAddress } = await import("./find-address");
        const r = await findAddress({ db: ctx.db, admin: ctx.admin, mailbox: ctx.me.email, name, client: client ? { id: client.id, name: client.name } : null });
        if (r.found.length) return { found: r.found, note: r.found.length > 1 ? "More than one fits: say both in a few words and ask which." : "Use it; say where it came from in a few words only if it matters." };
        return {
          found: [],
          looked: r.looked,
          suggestion: r.suggestion ?? undefined,
          note: r.suggestion ? `Not found in: ${r.looked.join("; ")}. Offer the suggestion (${r.suggestion.why}) and ask them to confirm it, together with any other open question, in one message.` : `Not found in: ${r.looked.join("; ")}. Say where you looked and ask for it, together with any other open question, in one message.`,
        };
      },
    },
    {
      name: "draft_message",
      description: `Drafts a Slack reply, a new Slack DM to a teammate, or an email as ${from}, in their voice (a message to a person; campaign, flow or SMS copy for the email team is never this: that's create_copy_doc): a reply in the exact thread they mean (the ones waiting on them first, then the client's recent threads), a new direct message to someone on the team ("DM Jesus", "message Dana on Slack": channel slack, dm: their name as heard, text), a new Slack message that is neither (an announcement they'll post in a channel, or one just for them to copy: channel slack, new_for: where it's meant to go as said, or "me"; never a thread reply), or a reply in an email thread they point at (a thread_id from search_my_email or a Gmail link: email_thread, never a new email with the same subject; reply_all for reply all), or a new email (to and subject). On a call it shows as a card they can edit and approve, with a copy button. Write the text yourself, short, the way they write (leave text out on a reply that's waiting on them and it's written in their voice for you). Several threads fit: list them in a few words and ask which (thread: its ref). A document goes with an email: make it first (make_document), then pass its document_id in attach (the card can save it to their Gmail drafts with the PDF attached, and offers the PDF to download); mention its Google link in the email when it helps. An email to a client goes to that client's contacts (find_email_address for each person named; never ask for an address it hasn't looked for); never address it to someone on the Kaizen team unless ${from} named them as a recipient. After drafting, read it back in a sentence or say it's on screen, then ask "send it?"; send only with send_message on their yes. When they'd rather send it themselves ("put it in my drafts", "I'll send it from Gmail"), run save_draft.`,
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["slack", "email"] },
          thread: { type: "string", description: "A thread's ref from an earlier draft_message answer" },
          client: { type: "string", description: "The client the thread is about" },
          from: { type: "string", description: "Who wrote the message being replied to, as said" },
          about: { type: "string", description: "What the thread is about, a few words" },
          text: { type: "string", description: "The message, as it will be sent" },
          dm: { type: "string", description: "Slack only: who a new direct message is to: a teammate's name or role, or a client contact's name (with client); several names (\"Jesus and Dana\") start a group DM. Not a reply in a thread" },
          new_for: { type: "string", description: "Slack only: a new top-level message in a channel, as said (\"the OO channel\", \"#email-team\", \"La Jetée's internal channel\" with client), sent there as them on their yes; or \"me\" when it's just for them to copy. Tag teammates in the text with @Name" },
          email_thread: { type: "string", description: "Email only: the exact thread to reply in, when they point at one: a thread_id from search_my_email / search_my_gmail, or a Gmail link. The reply is drafted inside that thread (same subject, In-Reply-To and References, to whoever wrote last)" },
          reply_all: { type: "boolean", description: "Email reply only: true for reply all (everyone else on the last message goes on Cc)" },
          to: { type: "string", description: "A new email's address (not a reply)" },
          subject: { type: "string", description: "A new email's subject" },
          attach: { type: "array", items: { type: "string" }, description: "An email only: document_id(s) from make_document whose PDF goes with it" },
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
        const pointed = channel === "email" && !input.thread && clip(input.email_thread, 300) ? gmailThreadId(input.email_thread) : null;
        if (channel === "email" && !input.thread && clip(input.email_thread, 300) && !pointed) return { drafted: false, note: "That Gmail link can't be read by id. Find the thread with search_my_email (who and subject) and pass its thread_id as email_thread." };
        const fresh = channel === "email" && clip(input.to, 200) && !input.thread && !pointed;
        const dm = channel === "slack" && !input.thread ? clip(input.dm, 160) : "";
        if (dm) {
          // A new DM (or, with several names, a group DM): each a teammate by name or role, else a client contact;
          // their Slack users found; sent as the person on their yes
          const names = dm.split(/\s*(?:,|&|\band\b|\+)\s*/i).map((x) => x.trim()).filter(Boolean).slice(0, 8);
          const people: { id: string; name: string }[] = [];
          for (const n of names) {
            const p = await slackPersonNamed(ctx, n, client);
            if (!p.ok) return { drafted: false, note: p.note, ...(p.options ? { options: p.options } : {}) };
            people.push(p.person);
          }
          const place = people.length > 1 ? slackGroupPlace(people) : slackDmPlace(people[0]?.id ?? "", people[0]?.name ?? "");
          if (!place) return { drafted: false, note: "They aren't found in Slack. Say so in a sentence." };
          if (!text) return { drafted: false, note: `Write the message, then draft it again.` };
          d = { kind: "draft", id, done: true, channel, slack: place, text, client: client?.name ?? null, at: new Date().toISOString() };
        } else if (channel === "slack" && !input.thread && clip(input.new_for, 80)) {
          // A new top-level message: in the channel named when it's found (sent there as them on their yes), else a
          // message for them to post themselves (no thread, so their self-DM copy carries no label)
          if (!text) return { drafted: false, note: "Write the message, then draft it again." };
          const said = clip(input.new_for, 80);
          const ch = isJustMe(said) ? null : await channelNamed(ctx, said, client);
          d = { kind: "draft", id, done: true, channel, slack: ch ? slackChannelPlace(ch.id, ch.name) : slackNewPlace(said), text, client: client?.name ?? null, at: new Date().toISOString() };
        } else if (pointed) {
          // The exact thread they pointed at: the reply is drafted inside it, to whoever wrote last (reply all on Cc)
          const last = await lastInThread(ctx.me.email, pointed, input.reply_all === true).catch(() => null);
          if (!last) return { drafted: false, note: "That thread isn't in their own mailbox (or Gmail didn't answer). Find it with search_my_email and pass its thread_id." };
          if (!text) return { drafted: false, note: "Write the reply's text, then draft it again with this email_thread." };
          d = { kind: "draft", id, done: true, channel, email: { mailbox: ctx.me.email, threadId: pointed, to: last.to, cc: last.cc, subject: last.subject, inReplyTo: last.inReplyTo, references: last.references }, text, client: client?.name ?? null, at: new Date().toISOString() };
        } else if (fresh && (/^\s*re\s*:/i.test(clip(input.subject, 200)) || /\b(?:reply|respond|answer)\b/i.test(ctx.said())) && (await threadForReply(ctx.me.email, clip(input.to, 200), clip(input.subject, 200) || clip(input.about, 120)))) {
          // A "new" email that's really a reply (a "Re:" subject, or they said reply) to someone they already have that
          // thread with: drafted inside it, never as a second thread with the same subject
          const tid = (await threadForReply(ctx.me.email, clip(input.to, 200), clip(input.subject, 200) || clip(input.about, 120)))!;
          const last = await lastInThread(ctx.me.email, tid, input.reply_all === true).catch(() => null);
          if (!text) return { drafted: false, note: "Write the reply's text, then draft it again." };
          d = last
            ? { kind: "draft", id, done: true, channel, email: { mailbox: ctx.me.email, threadId: tid, to: last.to, cc: last.cc, subject: last.subject, inReplyTo: last.inReplyTo, references: last.references }, text, client: client?.name ?? null, at: new Date().toISOString() }
            : { kind: "draft", id, done: true, channel, email: { mailbox: ctx.me.email, threadId: null, to: clip(input.to, 200), subject: clip(input.subject, 200) || "(no subject)" }, text, client: client?.name ?? null, at: new Date().toISOString() };
        } else if (fresh) {
          const to = clip(input.to, 200);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addressOf(to))) return { drafted: false, note: "That isn't an email address. Look it up with find_email_address first; ask only if it finds nothing." };
          // A client's email never goes to someone on the team unless they were named as a recipient
          if (client) {
            const internal = await teammateNamed(ctx, to);
            if (internal && !ctx.said().toLowerCase().includes(internal.toLowerCase())) return { drafted: false, note: `${internal} is on the Kaizen team, not ${client.name}. A client email goes to the client's contacts: run find_email_address for the people named, then draft it to them.` };
          }
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
            // Picked on "about" alone with no word of it in the thread: an unrelated thread, never a reply there
            const about = words(clip(input.about, 120));
            if (!input.from && about.length && !about.some((w) => pick!.gist.toLowerCase().includes(w))) return { drafted: false, which: all.map((f) => ({ ref: f.ref, from: f.who, about: f.gist, client: f.client, when: f.when })), note: "No thread matches that. A new message (not a reply): draft it again with new_for (or dm for a teammate). Otherwise ask which thread." };
          }
          if (!text && pick.owedId) {
            const { draftOwedReply } = await import("@/lib/reply-drafts");
            const r = await draftOwedReply(ctx.admin, pick.owedId);
            if (r.ok) text = r.draft;
          }
          if (!text) return { drafted: false, note: "Write the reply's text, then draft it again with this thread.", thread: pick.ref };
          if (pick.slack) d = { kind: "draft", id, done: true, channel, slack: { ...pick.slack, where: `${pick.slack.where}, reply to ${pick.who}` }, text, client: pick.client, owedId: pick.owedId, at: new Date().toISOString() };
          else {
            const last = await lastInThread(pick.email!.mailbox, pick.email!.threadId, input.reply_all === true).catch(() => null);
            d = { kind: "draft", id, done: true, channel, email: { mailbox: pick.email!.mailbox, threadId: pick.email!.threadId, to: last?.to ?? pick.who, cc: last?.cc ?? null, subject: last?.subject ?? reSubject(pick.email!.subject), inReplyTo: last?.inReplyTo ?? null, references: last?.references ?? null }, text, client: pick.client, owedId: pick.owedId, at: new Date().toISOString() };
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
          ...(askedFiles > files.length ? { not_attached: askedFiles - files.length, why: "Those documents weren't found or aren't theirs to attach. Make the document first (make_document) and attach its document_id." } : {}),
          note: "It's on screen to edit. Read it back in a sentence or two, then ask if you should send it (send only on their yes, send_message) or put it in their Gmail drafts / Slack to send themselves (save_draft, no yes needed).",
        };
      },
    },
    {
      name: "save_draft",
      description: `Puts a drafted message (draft_message) where ${from} edits and sends it themselves. Email: a real draft in their own Gmail (a reply sits in its thread; to, cc, subject and any attached PDFs included), with a link straight to it. Slack: Slack has no way for an app to write into someone's Slack Drafts, so it's posted to their own self-DM (their "message to yourself", with their own connected Slack) labeled with where it goes and a link to the thread; they copy it, edit it and send it there. Nothing reaches anyone else, so it needs no "send it?": run it when they ask ("put it in my Gmail drafts", "drop it in my Slack"). Then say where it is in a few words; the card links to it. If it can't, say the reason it gives in a sentence.`,
      input_schema: {
        type: "object",
        properties: {
          draft_id: { type: "string", description: "The draft's id (leave out for the latest draft on this call)" },
          all: { type: "boolean", description: "true to save every draft on this conversation that isn't saved or sent yet, each as its own message (\"put them all in my Slack\")" },
        },
        additionalProperties: false,
      },
      status: (input) => (input.all ? "Saving them to your drafts…" : "Saving it to your drafts…"),
      run: async (input) => {
        if (!ctx.callId) return { saved: false, note: "Draft it first (draft_message), then save it." };
        // Several drafts on screen ("put them in my Slack"): each one saved on its own
        const list = input.all === true ? (await allDrafts(ctx.admin, ctx.callId)).filter((x) => !x.sent && !x.saved) : [input.draft_id ? await getDraft(ctx.admin, ctx.callId, clip(input.draft_id, 40)) : await latestDraft(ctx.admin, ctx.callId)].filter((x): x is Draft => Boolean(x));
        if (!list.length) return { saved: false, note: input.all ? "Every draft on this conversation is already saved or sent." : "That draft isn't on this conversation. Draft it again (draft_message), then save it." };
        const done: { where: string; link: string | null; to: string }[] = [];
        let unsure = false;
        for (const d of list) {
          const r = await saveDraftToPlatform(ctx, d);
          if (!r.ok) return { saved: done.length > 0, saved_count: done.length, error: r.error, ...(r.needs ? { needs: r.needs } : {}) };
          if (r.unsure) unsure = true;
          done.push({ where: r.where, link: r.href, to: d.slack?.where ?? d.email?.to ?? "" });
        }
        const d = list[list.length - 1];
        const where = unsure
          ? "Say it was posted with their Slack, and if it isn't under their messages to themselves it's in their DM with Slackbot; the Reconnect card on screen (one tap) makes drafts land in their own self-DM every time."
          : d.slack
            ? `Say it's in their Slack, in their messages to themselves, ready to copy into ${d.slack.thread ? "the thread" : d.slack.where === "your Slack" ? "wherever it goes" : d.slack.where}.`
            : "Say it's in their Gmail drafts, ready to edit and send there.";
        return { saved: true, saved_count: done.length, drafts: done, note: done.length > 1 ? `${done.length} drafts saved, each on its own. ${where}` : where };
      },
    },
    {
      name: "send_message",
      description: `Sends a drafted message (draft_message) as ${from}, after they clearly said yes to it on this turn (or tapped Approve on the card): a Slack reply posted as them in the exact thread, a new DM or group DM from them (to teammates or client contacts), a new message in the channel named (with @mentions), all as them (their Slack must be connected), or an email reply in the Gmail thread from their mailbox. If sending as them isn't possible it says what happened instead (Slack: how to connect; email: saved as a Gmail draft, else the card's copy button). The text on the card is what's sent (they may have edited it).`,
      input_schema: { type: "object", properties: { draft_id: { type: "string", description: "The draft's id (leave out for the latest draft on this call)" }, confirmed: CONFIRMED }, additionalProperties: false },
      status: () => "Sending it…",
      run: async (input) => {
        if (!ctx.callId) return { sent: false, note: "Sending as them works on a call. Show the text to copy." };
        const carried = input.confirmed === true && (await carriedYes(ctx.admin, ctx.callId)).has("send_message");
        if (input.confirmed !== true || (!saidYes(ctx.said()) && !carried)) return { sent: false, note: "Not run: say what will be sent and where in a sentence, then ask; send with confirmed: true on their yes." };
        const d = input.draft_id ? await getDraft(ctx.admin, ctx.callId, clip(input.draft_id, 40)) : await latestDraft(ctx.admin, ctx.callId);
        if (!d) return { sent: false, note: "That draft isn't on this call. Draft it again." };
        if (d.sent) return { sent: true, already: true };
        if (d.slack && !d.slack.channel) return { sent: false, note: "A new message with no channel to send it to from here: put it in their Slack with save_draft (no yes needed) for them to post." };
        if (d.slack) {
          const { postAsUser } = await import("@/lib/slack-user");
          // A new group DM: opened as them first (needs mpim:write on their Slack connection)
          let target = d.slack.channel;
          const group = groupDmIds(target);
          if (group) {
            const opened = await openGroupDm(ctx, group);
            if (!opened.ok) return { sent: false, ...opened.answer };
            target = opened.channel;
          }
          // @Name in the text: real mentions
          const r = await postAsUser(ctx.me.id, { channel: target, text: await withMentions(ctx, d.text), thread: d.slack.thread ?? undefined });
          if (!r.ok) {
            if (r.needsConnect) {
              const n = await connectSlack(ctx, "reconnect");
              return { sent: false, ...n, note: "Their Slack isn't connected (or it expired). Say so in a sentence: connect it from the card, then you'll send it. The draft stays on screen to copy meanwhile." };
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
        const { gmailSendToken, googleConfigured, googlePost } = await import("@/lib/context/google");
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
          const saved = await saveDraftToPlatform(ctx, d);
          if (saved.ok) return { sent: false, fallback: "gmail_draft", link: saved.href, note: "Sending email as them isn't switched on, so it's saved as a draft in their Gmail, in the thread: say so in a sentence (one click to send there)." };
          showDraft(ctx, d, "copy");
          return { sent: false, fallback: "copy", why: saved.error, note: "Email can't go out as them from the app yet: the draft is on screen with a copy button. Say so in a sentence." };
        }
      },
    },
    {
      name: "connect_account",
      description: `Shows ${from} the one-tap Connect / Reconnect card for one of their own accounts, right in the conversation (on a call too). Use it when they say yes to reconnecting ("yes, reconnect it"), ask to connect their Slack, or a tool answered needs_connection and the card isn't on screen. Slack and Asana are connected by them (their own sign-ins); Gmail, Drive and Calendar go through Kaizen's company access, so for those it says what an admin turns on instead. Once they're connected the conversation tells you: then do what they'd asked.`,
      input_schema: { type: "object", properties: { service: { type: "string", enum: ["slack", "gmail", "drive", "calendar", "asana"] } }, required: ["service"], additionalProperties: false },
      status: () => "Getting the connect card…",
      run: async (input) => {
        const service = (["slack", "gmail", "drive", "calendar", "asana"].includes(String(input.service)) ? input.service : "slack") as "slack" | "gmail" | "drive" | "calendar" | "asana";
        if (service === "asana") {
          const [{ asanaConnection }, { showConnect }, { needsConnection }] = await Promise.all([import("@/lib/asana-user"), import("@/lib/personal-connections"), import("@/lib/personal-connections-core")]);
          const a = await asanaConnection(ctx.admin, ctx.me.id);
          if (a.connected) return { card: false, connected: true, note: "Their Asana is already connected. Go ahead with what they asked." };
          if (!a.configured) return { card: false, note: "Connecting your own Asana isn't set up yet (an admin adds the Asana app's keys). Kaizen's shared Asana account still works meanwhile." };
          const n = needsConnection("asana", "missing", { what: "see your own Asana tasks" });
          showConnect(ctx.emit, n);
          return { card: true, ...n };
        }
        if (service !== "slack") return { card: false, note: "Google goes through Kaizen's company access: there's nothing for them to connect. If it isn't working, it's an admin setting (Settings > Connections > Yours shows which)." };
        const { slackConnection, showConnect } = await import("@/lib/personal-connections");
        const { needsConnection } = await import("@/lib/personal-connections-core");
        const now = await slackConnection(ctx.me.id, true);
        if (now.state === "connected") return { card: false, connected: true, note: "Their Slack is already connected with everything you need. Go ahead with what they asked." };
        const n = needsConnection("slack", now.state);
        showConnect(ctx.emit, n);
        return { card: true, ...n };
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
      description: `Files feedback about the app when ${from} says "submit feedback", "report a bug", "I have an idea for…" (to you or any agent): sum it up in one line and confirm ("Got it: <one line>. Filing it."), then run this. It goes down the same path as the in-app report form, with this call's recent lines and the screen they're on attached: a bug goes straight to the fix pipeline; an idea goes to the owner to approve or comment on, except one the owner (an exec) files, which needs no approval and goes straight to Claude to build. Say in a few words where it went (the result's "where").`,
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
        ctx.emit?.({ t: "card", card: { id: `feedback-${r.id.slice(0, 8)}`, title: type === "idea" ? "Your idea is filed" : "Your report is filed", detail: { owner: "With the owner to approve", build: "On its way to be built", fix: "On its way to a fix" }[feedbackPath(type, ctx.me.isExec).path], href: "/feedback?tab=mine", external: false, cta: "Open it" } });
        return { filed: true, id: r.id, type, where: r.says };
      },
    },
  ];
  // While the owner views as someone, nothing goes out as them, from any surface that reuses these (calls, huddles, chats)
  return ctx.me.viewAs ? tools.map((t) => ({ ...t, run: async () => ({ done: false, error: "While viewing as someone, nothing is sent or saved as them." }) })) : tools;
}
