import { replyText, verifySvix } from "@/lib/inbound-email";
import { readReplyAddress } from "@/lib/notice-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Replies to promise and unanswered-message emails, through Resend Receiving. The notice email's Reply-To is
// reply+<signed code>@<inbound domain>; Resend posts email.received here (metadata only, signed the Svix way), the
// body is fetched from Resend, the quoted original dropped, and what they wrote is read exactly like "Add context"
// (or closes it, for a plain "done"). Anything without a valid code, or from someone the notice didn't go to, is
// ignored.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Received = { type?: string; data?: { email_id?: string; to?: string[]; cc?: string[]; received_for?: string[] | string; from?: string } };
const addressOf = (s: string | null | undefined) => (/<([^>]+)>/.exec(s ?? "")?.[1] ?? s ?? "").trim().toLowerCase();
const fromHtml = (html: string) =>
  html
    .replace(/<blockquote[\s\S]*$/i, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_API_KEY;
  if (!secret || !apiKey || !adminConfigured()) return Response.json({ error: "Email replies aren't set up (RESEND_WEBHOOK_SECRET)" }, { status: 503 });
  const raw = await req.text();
  const ok = verifySvix(secret, { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") }, raw);
  if (!ok) return Response.json({ error: "Bad signature" }, { status: 401 });
  let event: Received;
  try {
    event = JSON.parse(raw) as Received;
  } catch {
    return Response.json({ ignored: "not JSON" });
  }
  if (event.type !== "email.received" || !event.data?.email_id) return Response.json({ ignored: event.type ?? "no type" });
  const d = event.data;
  const rf = Array.isArray(d.received_for) ? d.received_for : d.received_for ? [d.received_for] : [];
  const item = readReplyAddress([...(d.to ?? []), ...(d.cc ?? []), ...rf]);
  if (!item) return Response.json({ ignored: "no reply code" });

  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id!)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  // Resend retries on an error, so a passing failure here gets another go
  if (!res.ok) return Response.json({ error: `Couldn't read the email (${res.status})` }, { status: 502 });
  const email = (await res.json()) as { from?: string; text?: string | null; html?: string | null };
  const from = addressOf(email.from ?? d.from);
  const admin = createAdminClient();
  const { data: person } = await admin.from("profiles").select("id").ilike("email", from).eq("is_active", true).maybeSingle();
  if (!person) return Response.json({ ignored: "not from the team" });
  const { mayAct, resolveNotice } = await import("@/lib/notice-resolve");
  if (!(await mayAct(admin, item.kind, item.id, person.id as string))) return Response.json({ ignored: "not theirs" });
  const text = replyText(email.text ?? fromHtml(email.html ?? "")).slice(0, 1500);
  if (!text) return Response.json({ ignored: "empty reply" });
  // "Done", "handled", "all set": closed as handled; anything else is context, read with everything else
  const plainDone = /^(done|handled|it'?s handled|all set|all good|completed?|sorted|taken care of)[.! ]*$/i.test(text);
  const r = await resolveNotice(admin, { kind: item.kind, id: item.id, profileId: person.id as string, how: plainDone ? "done" : "context", text: plainDone ? null : text, via: "reply", ref: d.email_id });
  // They hear back how it went
  const { sendEmail } = await import("@/lib/email");
  await sendEmail({
    to: from,
    subject: r.closed ? "Closed: thanks for the update" : "Got it: it's still open",
    text: `${r.message}\n\nAdd more or mark it handled in Kaizen Ads.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 14px">Kaizen Ads</p><p style="font-size:15px;line-height:1.5">${r.message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></div>`,
  }).catch(() => null);
  return Response.json({ ok: true, closed: r.closed });
}
