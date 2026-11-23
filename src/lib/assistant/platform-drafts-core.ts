// Drafts put where people edit and send them: a real Gmail draft in their own mailbox, or a Slack message to
// themselves (Slack's Web API has no endpoint for a person's Drafts, so their self-DM is the closest place they can
// copy, edit and send from). Pure: the links, the labels and what a Google refusal means. No keys, no network.

/**
 * The draft open in Gmail, in the right account: authuser picks the mailbox (/u/0 would be whoever is signed in first).
 * Never the address in the path: Gmail reads /u/name%40domain as an unknown account ("temporarily unavailable", 404).
 */
export function gmailDraftLink(mailbox: string, messageId?: string | null): string {
  const base = `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox.trim().toLowerCase())}#drafts`;
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

/** A new Slack DM to a teammate as the draft's place: their Slack user is the channel (opened as the sender on send) */
export function slackDmPlace(slackUserId: string, name: string): { channel: string; thread: null; where: string } | null {
  const id = slackUserId.trim();
  if (!/^[UW][A-Z0-9]{6,}$/.test(id)) return null;
  return { channel: id, thread: null, where: `a DM to ${name.trim() || "them"}` };
}

/** A new group DM with several people ("mpim:U1,U2"): opened as the person when it's sent (conversations.open) */
export function slackGroupPlace(people: readonly { id: string; name: string }[]): { channel: string; thread: null; where: string } | null {
  const ok = people.filter((p) => /^[UW][A-Z0-9]{6,}$/.test(p.id.trim()));
  const ids = [...new Set(ok.map((p) => p.id.trim()))];
  if (ids.length < 2) return null;
  const names = ok.map((p) => p.name.trim() || "them");
  return { channel: `mpim:${ids.join(",")}`, thread: null, where: `a group DM with ${names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ")}` };
}

/** The people of a group DM still to open, from its stored place; null for anything else */
export const groupDmIds = (channel: string) => (channel.startsWith("mpim:") ? channel.slice(5).split(",").filter(Boolean) : null);

/** A new top-level message in a channel they're in (#name) */
export const slackChannelPlace = (id: string, name: string) => ({ channel: id, thread: null, where: `#${name.replace(/^#/, "")}` });

/** How a channel is said ("the OO channel", "#oo-team") to how it's named in Slack ("oo-team"), for matching */
export const channelKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+channel$/, "")
    .replace(/^#/, "")
    .trim()
    .replace(/[\s_]+/g, "-");

/** Names someone tagged ("@Dana", "@Dana Kim") as real Slack mentions (<@U123>), longest names first, once each place */
export function tagMentions(text: string, people: readonly { name: string; slackId: string }[]): string {
  const byName: { label: string; id: string }[] = [];
  for (const p of people) {
    if (!/^[UW][A-Z0-9]{6,}$/.test(p.slackId)) continue;
    const full = p.name.trim();
    if (!full) continue;
    byName.push({ label: full, id: p.slackId });
    const first = full.split(/\s+/)[0];
    if (first && first !== full) byName.push({ label: first, id: p.slackId });
  }
  // A first name two people share isn't tagged by itself (ambiguous)
  const count = new Map<string, number>();
  for (const b of byName) count.set(b.label.toLowerCase(), (count.get(b.label.toLowerCase()) ?? 0) + (b.label.includes(" ") ? 0 : 1));
  const usable = byName.filter((b) => b.label.includes(" ") || count.get(b.label.toLowerCase()) === 1).sort((a, b) => b.label.length - a.label.length);
  let out = text;
  for (const b of usable) {
    const esc = b.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^<\\w])@${esc}(?![\\w])`, "gi"), (_m, pre: string) => `${pre}<@${b.id}>`);
  }
  return out;
}

const JUST_ME = /^(?:me|myself|just me|my (?:own )?(?:slack|dms?|self[- ]?dms?|messages))$/i;
/** Whether a "where it's meant to go" is just them (a copy for themselves), not a channel */
export const isJustMe = (s: string) => JUST_ME.test(s.trim());

/**
 * A new Slack message that's neither a reply nor a DM (an announcement they'll post in a channel themselves, a note to
 * copy): no channel and no thread, so it's never tied to some unrelated thread. Where it's meant for is only a hint.
 */
export function slackNewPlace(meantFor: string): { channel: ""; thread: null; where: string } {
  const w = meantFor.trim().replace(/\s+/g, " ").slice(0, 80);
  return { channel: "", thread: null, where: w && !JUST_ME.test(w) ? w : "your Slack" };
}

/** What lands in their self-DM: a new message is the text alone (no label, no thread); a reply or DM says where it goes */
export function slackSelfText(place: { channel: string; thread: string | null; where: string }, text: string): string {
  if (!place.channel) return text;
  return slackSelfNote({ where: place.where, link: slackMessageLink(place.channel, place.thread), text });
}
