// Messages the assistant drafts and sends as the person: where a Slack reply goes (from the stored message keys), the
// email reply itself (headers that keep it in the thread, encoded the way Gmail takes it), and whether a tool's answer
// was a failure on our side (so a yes isn't used up by it). Pure: no keys, no network, tested on its own.

/** A Slack message's place from how it's stored ("C123:1700000000.0001" keys; a thread key when it's in one) */
export function slackPlace(externalId: string, threadId: string | null | undefined): { channel: string; thread: string } | null {
  const [channel, ts] = externalId.split(":");
  if (!channel || !ts || !/^[CGD][A-Z0-9]+$/.test(channel)) return null;
  const t = threadId?.split(":")[1] ?? null;
  return { channel, thread: t || ts };
}

/** "Re: Subject" once, however many times it's been replied to */
export const reSubject = (subject: string) => (/^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim() || "(no subject)"}`);

/** Just the address in "Dana Kim <dana@x.com>" */
export const addressOf = (header: string) => (header.match(/<([^>]+)>/)?.[1] ?? header).trim();

const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** Base64url, the way Gmail's API takes a raw message */
export const base64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 for a header with anything beyond plain ASCII */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/**
 * An email (a reply in its thread when In-Reply-To and References are given) as Gmail's raw message: plain text,
 * UTF-8, headers on one line each (no header injection from a subject or a name).
 */
export function rawEmail(m: { from: string; to: string; cc?: string | null; subject: string; body: string; inReplyTo?: string | null; references?: string | null }): string {
  const lines = [
    `From: ${headerSafe(m.from)}`,
    `To: ${headerSafe(m.to)}`,
    ...(m.cc ? [`Cc: ${headerSafe(m.cc)}`] : []),
    `Subject: ${encodeHeader(headerSafe(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${headerSafe(m.inReplyTo)}`] : []),
    ...(m.inReplyTo || m.references ? [`References: ${headerSafe([m.references, m.inReplyTo].filter(Boolean).join(" "))}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    m.body.replace(/\r?\n/g, "\r\n"),
  ];
  return base64url(lines.join("\r\n"));
}

/** Who a reply goes to: the last message's sender, or (when that was the person themselves) who they wrote to */
export function replyTo(last: { from: string; to: string; replyTo?: string | null }, mailbox: string): string {
  const from = addressOf(last.from).toLowerCase();
  if (from === mailbox.toLowerCase()) return last.to;
  return last.replyTo?.trim() || last.from;
}

/**
 * Whether a tool's answer means it didn't happen for a reason the person didn't cause (an error, a failed send), as
 * opposed to "not run: ask first" or a question back. A yes given for it carries to the next try.
 */
export function failedOnOurSide(out: unknown): boolean {
  if (!out || typeof out !== "object") return false;
  const o = out as Record<string, unknown>;
  if (typeof o.note === "string" && /^Not run: (?:say|ask)/.test(o.note)) return false;
  if (Array.isArray(o.options)) return false;
  return Boolean(o.error) || o.sent === false || o.ok === false || (o.done === false && Boolean(o.error));
}
