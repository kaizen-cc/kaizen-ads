import "server-only";

// Sends through Resend using the OS's verified domain (contact.kaizenmarketing.agency).
// Mirrors kaizen-cc's lib/email/client.ts so the two can merge later.

const DEFAULT_FROM = "Kaizen Ads <ads@contact.kaizenmarketing.agency>";
const DEFAULT_REPLY_TO = "admin@kaizenmarketing.agency";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];

export type SendResult = { ok: true; id?: string } | { ok: false; error: string };

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "Email isn't set up yet (RESEND_API_KEY missing in Vercel)" };

  const body = JSON.stringify({
    from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    reply_to: params.replyTo ?? DEFAULT_REPLY_TO,
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
