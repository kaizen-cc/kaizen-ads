// What an email is before anyone treats it as a client conversation: a calendar invite or RSVP (Google Calendar's
// "Invitation:", "Accepted:", "Declined:" and the rest, or anything carrying a text/calendar part), or mail only between
// us. Neither is the client talking, so they stay off the client lists, the owed replies and the promises. And the
// link that opens an email in Gmail.

/** Our own domain: an email only between addresses here is internal */
export const INTERNAL_DOMAIN = "kaizenmarketing.agency";

// Google Calendar's (and Outlook's) subject prefixes for invites, changes and replies, before the colon
const CALENDAR_SUBJECT =
  /^\s*(?:(?:re|fwd?):\s*)*(?:(?:updated |new )?invitation(?: with note)?(?: from google calendar)?|updated event|new event|event (?:canceled|cancelled|updated)|cancel(?:l)?ed(?: event)?(?: with note)?|accepted|declined|tentative(?:ly accepted)?|maybe|proposed new time|new time proposed|invitation updated)\b[^:\n]{0,60}:/i;

type Part = { mimeType?: string; filename?: string; parts?: Part[] };

/** Whether a message has a calendar part (an invite's text/calendar or an .ics attachment), at any depth */
export function hasCalendarPart(part: Part | null | undefined): boolean {
  if (!part) return false;
  const type = (part.mimeType ?? "").toLowerCase();
  if (type === "text/calendar" || type === "application/ics" || /\.ics$/i.test(part.filename ?? "")) return true;
  return (part.parts ?? []).some(hasCalendarPart);
}

/** A calendar invite, update or RSVP, from its subject or (when there) its parts */
export function isCalendarEmail(subject: string | null | undefined, payload?: Part | null) {
  return CALENDAR_SUBJECT.test(subject ?? "") || hasCalendarPart(payload);
}

/** Every address on it is ours: mail between teammates, not with a client */
export function isInternalOnly(addresses: readonly string[]) {
  const all = addresses.map((a) => a.toLowerCase().trim()).filter(Boolean);
  return all.length > 0 && all.every((a) => a.endsWith(`@${INTERNAL_DOMAIN}`));
}

/**
 * The link that opens a thread in Gmail. Gmail's /mail/u/<address>/ answers with a 404 when that address isn't one
 * signed in on the browser (another alias, signed in as someone else); authuser picks the account when it is signed
 * in, and asks to sign in to it when it isn't.
 */
export function gmailLink(mailbox: string, threadId: string) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${threadId}`;
}

/** An email link saved in the old /mail/u/<address>/ form, rewritten to the one that opens; anything else as it is */
export function fixGmailLink<T extends string | null>(href: T): T {
  const m = href?.match(/^https:\/\/mail\.google\.com\/mail\/u\/([^/#?]+@[^/#?]+)\/?#(?:all|inbox)\/([A-Za-z0-9_-]+)$/);
  return (m ? gmailLink(decodeURIComponent(m[1]), m[2]) : href) as T;
}
