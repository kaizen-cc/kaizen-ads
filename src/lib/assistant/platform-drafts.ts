import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Draft } from "./handoff-server";
import { rawEmail } from "./messages";
import { draftError, draftViaMcp, gmailDraftLink, serviceAccountClientId, slackMessageLink, slackSelfText } from "./platform-drafts-core";

// Every assistant and agent puts a drafted message where the person edits and sends it: a real draft in their own
// Gmail (in the thread for a reply, with the PDFs attached), or a message to themselves in Slack labeled with where it
// goes. Neither sends anything to anyone else, so neither needs a "send it?" first.

export type EmailToDraft = {
  mailbox: string;
  fromName: string;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  files?: readonly { documentId: string; name: string }[];
};

export type GmailDraftResult = { ok: true; draftId: string; messageId: string | null; href: string } | { ok: false; scope: boolean; error: string };

/** The email as a draft in the person's own Gmail. A refused scope tells the execs once, in Kaizen OS. */
export async function saveGmailDraft(admin: SupabaseClient, e: EmailToDraft): Promise<GmailDraftResult> {
  const { gmailComposeToken, gmailSignature, googleConfigured, googlePost } = await import("@/lib/context/google");
  if (!googleConfigured()) return { ok: false, scope: false, error: "Google isn't connected to Kaizen OS, so drafts can't go into Gmail yet." };
  const clientId = serviceAccountClientId(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  try {
    const { mailFiles } = await import("@/lib/documents/attach");
    const { attached, missing } = await mailFiles(admin, e.files ?? []);
    if (missing.length) throw new Error(`files missing: ${missing.join(", ")}`);
    const signature = await gmailSignature(e.mailbox);
    // Through Google's Gmail MCP server when WORKSPACE_MCP is on (plain text, their signature as text under it); a
    // draft with files, or a reply in a thread, stays on REST: Google's create_draft can't attach files or set the
    // In-Reply-To and References headers Gmail needs to keep a draft in its thread
    if (draftViaMcp(e, attached.length)) {
      const sig = signature ? signatureText(signature) : "";
      const viaMcp = await (await import("@/lib/workspace-agent")).mcpGmailDraft({ mailbox: e.mailbox, to: e.to, cc: e.cc ?? null, subject: e.subject, body: sig ? `${e.body}\n\n${sig}` : e.body });
      if (viaMcp) return { ok: true, draftId: viaMcp.draftId, messageId: viaMcp.messageId, href: gmailDraftLink(e.mailbox, viaMcp.messageId) };
    }
    const raw = rawEmail({ from: `${e.fromName} <${e.mailbox}>`, to: e.to, cc: e.cc ?? null, subject: e.subject, body: e.body, inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, attachments: attached, signature });
    const token = await gmailComposeToken(e.mailbox);
    const made = await googlePost<{ id: string; message?: { id: string } }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw, ...(e.threadId ? { threadId: e.threadId } : {}) } });
    return { ok: true, draftId: made.id, messageId: made.message?.id ?? null, href: gmailDraftLink(e.mailbox, made.message?.id) };
  } catch (err) {
    console.error("[gmail draft]", err instanceof Error ? err.message : err);
    const why = draftError(err, clientId);
    if (why.scope) await tellExecsComposeScope(admin, why.message).catch(() => undefined);
    return { ok: false, scope: why.scope, error: why.message };
  }
}

/** The execs hear once (a bell in Kaizen OS) that Gmail drafts wait on the Admin console setting */
async function tellExecsComposeScope(admin: SupabaseClient, body: string) {
  const { data } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({ profile_id: id, kind: "setup", title: "Gmail drafts need one Admin console setting", body: body.slice(0, 1000), href: null, key: "google:gmail-compose-scope", priority: "normal" })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** A call draft (email) as a Gmail draft, from its stored parts */
export function emailOfDraft(d: Draft, fromName: string): EmailToDraft | null {
  if (!d.email) return null;
  const e = d.email;
  return { mailbox: e.mailbox, fromName, to: e.to, cc: e.cc ?? null, subject: e.subject, body: d.text, threadId: e.threadId, inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, files: d.attachments ?? [] };
}

export type SlackDraftResult = { ok: true; href: string | null; where: string; /** Not confirmed to be their own self-DM (an older connection without im:read) */ unsure?: boolean } | { ok: false; error: string; needsConnect?: boolean };

/**
 * Their own self-DM ("message to yourself"): the DM whose other person is themselves. Posting to their own user ID with
 * their token doesn't reliably land there (Slack can put it in another DM, Slackbot's), so it's looked up by id; that
 * needs im:read. Null when the token can't list DMs (an older connection) or it isn't found.
 */
async function selfDmId(token: string, scopes: string[], me: string): Promise<string | null> {
  if (!scopes.includes("im:read")) return null;
  const { slackRead } = await import("@/lib/slack-user");
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await slackRead<{ ok: boolean; channels?: { id: string; user?: string }[]; response_metadata?: { next_cursor?: string } }>(token, "conversations.list", { types: "im", limit: "200", exclude_archived: "true", ...(cursor ? { cursor } : {}) }).catch(() => null);
    if (!r?.ok) return null;
    const hit = (r.channels ?? []).find((c) => c.user === me);
    if (hit) return hit.id;
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return null;
}

/**
 * A Slack draft in the person's own self-DM ("message to yourself"), posted with their own token: labeled with where it
 * goes and a link to that thread, so they copy, edit and send it there (a new message is the text alone). Slack has no
 * API for a person's Drafts.
 */
export async function saveSlackSelfDraft(profileId: string, d: Draft): Promise<SlackDraftResult> {
  if (!d.slack) return { ok: false, error: "That draft isn't a Slack message." };
  const { postAsUser, slackUserToken } = await import("@/lib/slack-user");
  const mine = await slackUserToken(profileId);
  if (!mine?.slackUserId) return { ok: false, error: "Connect your Slack first, so the draft lands in your own messages.", needsConnect: true };
  // Their own self-DM, found by id; an older connection that can't list DMs posts to their user ID as before, flagged
  const self = await selfDmId(mine.token, mine.scopes, mine.slackUserId);
  const r = await postAsUser(profileId, { channel: self ?? mine.slackUserId, text: slackSelfText(d.slack, d.text) });
  if (!r.ok) return { ok: false, error: r.error, needsConnect: r.needsConnect };
  return { ok: true, href: r.permalink ?? slackMessageLink(r.channel, r.ts), where: d.slack.where, ...(self ? {} : { unsure: true }) };
}

export type PlacedCallDraft = { ok: true; draft: Draft; where: string; href: string | null; unsure?: boolean } | { ok: false; error: string; scope?: boolean; needsConnect?: boolean };

/**
 * A draft on a call or chat saved where the person sends it: Gmail (their own mailbox only; marked on the call and on
 * the client's email draft) or their Slack self-DM. The chat's tool and the card's button both come here.
 */
export async function placeCallDraft(admin: SupabaseClient, me: { id: string; email: string; fullName: string }, callId: string, d: Draft): Promise<PlacedCallDraft> {
  const { putDraft } = await import("./handoff-server");
  if (d.slack) {
    const r = await saveSlackSelfDraft(me.id, d);
    if (!r.ok) return { ok: false, error: r.error, needsConnect: r.needsConnect };
    const next: Draft = { ...d, saved: { to: "slack", href: r.href } };
    await putDraft(admin, callId, next);
    return { ok: true, draft: next, where: "your Slack (a message to yourself)", href: r.href, ...(r.unsure ? { unsure: true } : {}) };
  }
  const email = emailOfDraft(d, me.fullName);
  if (!email) return { ok: false, error: "That draft has nothing to save." };
  if (email.mailbox.toLowerCase() !== me.email.toLowerCase()) return { ok: false, error: "That thread isn't in your own mailbox, so it can't be saved in your Gmail." };
  const r = await saveGmailDraft(admin, email);
  if (!r.ok) return { ok: false, error: r.error, scope: r.scope };
  const next: Draft = { ...d, sent: "gmail_draft", saved: { to: "gmail", href: r.href } };
  await putDraft(admin, callId, next);
  if (d.clientDraftId) await admin.from("client_email_drafts").update({ status: "opened", gmail_draft_id: r.draftId, updated_at: new Date().toISOString() }).eq("id", d.clientDraftId).eq("owner_id", me.id);
  return { ok: true, draft: next, where: "your Gmail drafts", href: r.href };
}

/** A Gmail signature (HTML) as plain text, for a draft made through the MCP server */
function signatureText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
