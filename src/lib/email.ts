import "server-only";

// Sends through Resend using the OS's verified domain (contact.kaizenmarketing.agency).
// Mirrors kaizen-cc's lib/email/client.ts so the two can merge later.

const DEFAULT_FROM = "Kaizen <ads@contact.kaizenmarketing.agency>";
/**
 * The name every email is from (owner, Nov 19 2026): just "Kaizen", whatever name RESEND_FROM_EMAIL carries. The
 * address stays RESEND_FROM_EMAIL's: only a domain verified in Resend can send (contact. today; app. once verified).
 */
export const SENDER_NAME = "Kaizen";
const DEFAULT_REPLY_TO = "admin@kaizenmarketing.agency";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];

/** "Name <address>" with the name swapped (the address kept: only the verified domain can send) */
export function fromWithName(from: string, name?: string) {
  if (!name?.trim()) return from;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  return `${name.trim().replace(/[<>"]/g, "")} <${address}>`;
}

export type SendResult = { ok: true; id?: string } | { ok: false; error: string };

/** A subject on one line: breaks and tabs become spaces, runs of spaces one, at most 300 characters */
export const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 300);

export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  cc?: string[];
  /** Files to attach (a report's PDF): the bytes, base64 */
  attachments?: { filename: string; content: string }[];
  /** The name it's from, in place of the usual one (same address: a white label client's report is "Performance Report") */
  fromName?: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "Email isn't set up yet (RESEND_API_KEY missing in Vercel)" };

  const body = JSON.stringify({
    from: fromWithName(process.env.RESEND_FROM_EMAIL || DEFAULT_FROM, params.fromName || SENDER_NAME),
    to: params.to,
    // One line: Resend refuses a subject with a line break in it (a client or campaign name can carry one)
    subject: oneLine(params.subject),
    html: params.html,
    text: params.text,
    reply_to: params.replyTo ?? DEFAULT_REPLY_TO,
    ...(params.cc?.length ? { cc: params.cc } : {}),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
  });

  let lastError = "Email delivery failed";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok) return { ok: true, id: data.id };
      lastError = data.message || `Resend error ${res.status}`;
      // Only rate limits and server errors are worth retrying
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Email service unreachable";
    }
  }
  console.error("[email] send failed:", lastError);
  return { ok: false, error: lastError };
}
