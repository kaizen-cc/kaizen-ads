// Drafts put where people edit and send them: a real Gmail draft in their own mailbox, or a Slack message to
// themselves (Slack's Web API has no endpoint for a person's Drafts, so their self-DM is the closest place they can
// copy, edit and send from). Pure: the links, the labels and what a Google refusal means. No keys, no network.

/** The draft open in Gmail, in the right account (the mailbox picks it; /u/0 would be whoever is signed in first) */
export function gmailDraftLink(mailbox: string, messageId?: string | null): string {
  const base = `https://mail.google.com/mail/u/${encodeURIComponent(mailbox.trim().toLowerCase())}/#drafts`;
  return messageId ? `${base}?compose=${encodeURIComponent(messageId)}` : base;
}

/** The service account's OAuth client ID (what the Admin console's domain-wide delegation asks for), never the key */
export function serviceAccountClientId(json: string | undefined | null): string | null {
  if (!json) return null;
  try {
    const id = (JSON.parse(json) as { client_id?: unknown }).client_id;
    return typeof id === "string" && /^\d{6,}$/.test(id.trim()) ? id.trim() : null;
  } catch {
    return null;
  }
}

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

/** The plain words when Google won't let the app write drafts (the scope isn't in domain-wide delegation) */
export function composeScopeMessage(clientId: string | null): string {
  return `Gmail drafts need one Admin console setting: add gmail.compose to the service account's domain-wide delegation${clientId ? ` (client ID ${clientId})` : ""}. In admin.google.com: Security > Access and data control > API controls > Manage domain-wide delegation, edit that client and add ${GMAIL_COMPOSE_SCOPE} next to the scopes already there.`;
}

export type DraftError = { scope: boolean; message: string };

/**
 * What a failed draft means. Google refuses a scope that isn't delegated with unauthorized_client (asking for the
 * token) or, once a token exists, a 403 on insufficient scopes: both are the one Admin console setting. Anything else
 * is said as it is.
 */
export function draftError(e: unknown, clientId: string | null): DraftError {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (/unauthorized_client|access_denied|insufficient(?:Permissions| authentication scopes)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(m)) return { scope: true, message: composeScopeMessage(clientId) };
  if (/invalid_grant|Invalid email or User ID/i.test(m)) return { scope: false, message: "Google doesn't know that mailbox, so the draft couldn't be saved there." };
  if (/files missing/i.test(m)) return { scope: false, message: "A file on it couldn't be read, so the draft wasn't saved. Make the document again and attach it." };
  return { scope: false, message: `Gmail didn't take the draft (${m.slice(0, 160) || "no reason given"}).` };
}

/** A Slack message's link from its channel and ts (Slack redirects it to the workspace) */
export function slackMessageLink(channel: string, ts: string | null | undefined): string | null {
  if (!channel || !ts || !/^\d+\.\d+$/.test(ts)) return null;
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/**
 * The note in their self-DM: where it's meant to go (with the thread's link), then the message itself, untouched, so
 * it copies clean.
 */
export function slackSelfNote(d: { where: string; link: string | null; text: string }): string {
  const head = `Draft for ${d.where}${d.link ? ` (<${d.link}|open the thread>)` : ""}. Copy it, edit it and send it there:`;
  return `${head}\n\n${d.text}`;
}
