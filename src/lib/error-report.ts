import "server-only";
import { createHash } from "node:crypto";
import { sendEmail } from "@/lib/email";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Where error alerts go (override with ERROR_ALERT_EMAIL in Vercel)
const ALERT_TO = () => process.env.ERROR_ALERT_EMAIL || "santi@kaizenmarketing.agency";

// Ids, numbers and dates differ per occurrence; strip them so one bug groups as one
const normalize = (s: string) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\d{4}-\d{2}-\d{2}[T\d:.Z+-]*/g, ":date")
    .replace(/\d+/g, "#")
    .slice(0, 300);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Record an error and email an alert when one is due (first time, or hourly while it keeps
 * happening). Never throws — reporting must not cause a second failure.
 */
export async function reportError(input: {
  message: string;
  path?: string | null;
  kind: "server" | "page" | "action";
  person?: string | null;
  digest?: string | null;
  stack?: string | null;
  detail?: Record<string, unknown>;
}) {
  try {
    if (!adminConfigured()) return;
    const path = input.path?.split("?")[0] ?? null;
    const fingerprint = createHash("sha1")
      .update(`${input.kind}|${normalize(input.message)}|${path ? normalize(path) : ""}`)
      .digest("hex");
    const sample = {
      digest: input.digest ?? null,
      stack: input.stack?.split("\n").slice(0, 12).join("\n") ?? null,
      ...input.detail,
    };
    const admin = createAdminClient();
    const { data: due } = await admin.rpc("record_error", {
      p_fingerprint: fingerprint,
      p_message: input.message,
      p_path: path,
      p_kind: input.kind,
      p_person: input.person ?? null,
      p_sample: sample,
    });
    if (!due) return;

    const { data: row } = await admin.from("error_events").select("count, people, first_seen").eq("fingerprint", fingerprint).single();
    const count = row?.count ?? 1;
    const who = row?.people?.length ? row.people.join(", ") : "unknown (not signed in, or a background request)";
    const subject = `[Kaizen Ads] ${count > 1 ? `${count}× ` : ""}${input.message.slice(0, 80)}`;
    const text = [
      `Something broke in Kaizen Ads.`,
      ``,
      `Error: ${input.message}`,
      `Where: ${path ?? "unknown"} (${input.kind})`,
      `Who: ${who}`,
      `Times seen: ${count}${row?.first_seen ? ` since ${new Date(row.first_seen).toUTCString()}` : ""}`,
      input.digest ? `Digest: ${input.digest}` : "",
      sample.stack ? `\n${sample.stack}` : "",
      ``,
      `Error log: Supabase → kaizen-ads → error_events (an Errors page comes with Admin)`,
      `You'll get at most one email an hour for this error while it keeps happening.`,
    ].join("\n");
    const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p><strong>Something broke in Kaizen Ads.</strong></p>
<table style="border-collapse:collapse">
<tr><td style="padding:2px 12px 2px 0;color:#666">Error</td><td><strong>${esc(input.message)}</strong></td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#666">Where</td><td>${esc(path ?? "unknown")} (${input.kind})</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#666">Who</td><td>${esc(who)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#666">Times seen</td><td>${count}</td></tr>
${input.digest ? `<tr><td style="padding:2px 12px 2px 0;color:#666">Digest</td><td>${esc(input.digest)}</td></tr>` : ""}
</table>
${sample.stack ? `<pre style="background:#f5f5f5;padding:10px;border-radius:6px;font-size:12px;overflow:auto">${esc(sample.stack)}</pre>` : ""}
<p style="color:#888;font-size:12px">At most one email an hour per error while it keeps happening.</p></div>`;
    await sendEmail({ to: ALERT_TO(), subject, text, html });
  } catch (e) {
    console.error("[error-report] failed to report:", e);
  }
}

/** Best-effort: the signed-in person's email from a request's cookies. */
export async function personFromCookies(cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  try {
    const { createServerClient } = await import("@supabase/ssr");
    const all = cookieHeader.split(/;\s*/).map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: decodeURIComponent(c.slice(i + 1)) };
    });
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      cookies: { getAll: () => all, setAll: () => {} },
    });
    const { data } = await supabase.auth.getClaims();
    return (data?.claims?.email as string | undefined) ?? null;
  } catch {
    return null;
  }
}
