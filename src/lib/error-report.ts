import "server-only";
import { createHash } from "node:crypto";
import { sendEmail } from "@/lib/email";
import { diagnoseError, type Diagnosis } from "@/lib/error-diagnose";
import { classifyError } from "@/lib/error-triage";
import { opsLink } from "@/lib/ops-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Where error alerts go (override with ERROR_ALERT_EMAIL in Vercel)
const ALERT_TO = () => process.env.ERROR_ALERT_EMAIL || "santi@kaizenmarketing.agency";
const SITE = "https://ads.kaizenmarketing.agency";

// Ids, numbers and dates differ per occurrence; strip them so one bug groups as one
const normalize = (s: string) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\d{4}-\d{2}-\d{2}[T\d:.Z+-]*/g, ":date")
    .replace(/\d+/g, "#")
    .slice(0, 300);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const OUTAGE_PEOPLE = 5; // this many people losing connections within an hour looks like an outage

const row = (label: string, value: string) =>
  `<tr><td style="padding:6px 14px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:6px 0">${value}</td></tr>`;
const button = (href: string, label: string, primary = false) =>
  `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 14px;border-radius:5px;text-decoration:none;font-weight:600;${
    primary ? "background:#B21E2C;color:#fff" : "background:#f2f2f2;color:#111;border:1px solid #ddd"
  }">${label}</a>`;

/**
 * Record an error. Harmless ones (a dropped connection, a tab on an old version) are explained and
 * closed automatically. Real ones are diagnosed by Claude and emailed — first time, then at most
 * hourly — with one-click buttons: mark fixed, stop alerting, or have Claude fix it. Never throws.
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
    const auto = classifyError(input.message, input.stack);
    const sample = {
      digest: input.digest ?? null,
      stack: input.stack?.split("\n").slice(0, 12).join("\n") ?? null,
      triage: auto?.kind ?? null,
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

    // Harmless: explain it, close it, and only speak up if it looks like an outage
    if (auto) {
      await admin
        .from("error_events")
        .update({ resolved_at: new Date().toISOString(), auto_resolved: true, diagnosis: { ...auto, severity: "low", dataRisk: false, by: "rules" } })
        .eq("fingerprint", fingerprint);
      if (!due || auto.kind !== "network") return;
      const { data: recent } = await admin
        .from("error_events")
        .select("people")
        .eq("auto_resolved", true)
        .gte("last_seen", new Date(Date.now() - 3600_000).toISOString());
      const people = new Set((recent ?? []).flatMap((r) => (r.people as string[]) ?? []));
      if (people.size < OUTAGE_PEOPLE) return;
      const list = [...people].join(", ");
      await sendEmail({
        to: ALERT_TO(),
        subject: `[Kaizen Ads] Possible outage: ${people.size} people lost their connection in the last hour`,
        text: `${people.size} people had requests fail to load in the last hour (${list}). That usually means Vercel or Supabase had a hiccup, or a shared network is down.\n\nVercel status: https://www.vercel-status.com · Supabase status: https://status.supabase.com\nAll errors: ${SITE}/settings?tab=errors?show=all`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111"><p><strong>Possible outage.</strong> ${people.size} people had requests fail to load in the last hour.</p><p style="color:#666">${esc(list)}</p><p>That usually means Vercel or Supabase had a hiccup, or a shared network is down. Check <a href="https://www.vercel-status.com">Vercel status</a> and <a href="https://status.supabase.com">Supabase status</a>.</p><p><a href="${SITE}/settings?tab=errors?show=all">See all errors</a></p></div>`,
      });
      return;
    }
    if (!due) return;

    const { data: rec } = await admin
      .from("error_events")
      .select("count, people, first_seen, diagnosis, muted_at, fix_issue_url")
      .eq("fingerprint", fingerprint)
      .single();
    if (rec?.muted_at) return;
    const count = rec?.count ?? 1;
    const people = (rec?.people as string[] | null) ?? [];
    const who = people.length ? people.join(", ") : "unknown (not signed in, or a background request)";

    // Diagnose once per error; later alerts reuse it
    let d = rec?.diagnosis as Diagnosis | null;
    if (!d) {
      d = await diagnoseError({
        message: input.message,
        path,
        kind: input.kind,
        stack: sample.stack,
        count,
        people,
        userAgent: (input.detail?.userAgent as string | undefined) ?? null,
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      });
      if (d) await admin.from("error_events").update({ diagnosis: d }).eq("fingerprint", fingerprint);
    }

    const sev = d?.severity ?? "medium";
    // Low severity goes to Claude on its own: it fixes it in a pull request (or says why it isn't ours), and the fix
    // merges itself once every check passes (.github/workflows/claude-fix.yml). Medium and high wait for someone to
    // press "Have Claude fix it" and to review the fix.
    let fixUrl = rec?.fix_issue_url ?? null;
    if (!fixUrl && process.env.GITHUB_TOKEN && sev === "low") {
      const { createFixIssue } = await import("@/lib/claude-fix");
      fixUrl = (await createFixIssue(fingerprint, "automatically", true).catch(() => ({ url: undefined }))).url ?? null;
    }
    const handled = d?.handled ?? "Recorded; the person saw a friendly error page and their work is safe.";
    const subject = `[Kaizen Ads] ${sev === "high" ? "🔴 " : sev === "low" ? "" : "🟠 "}${count > 1 ? `${count}× ` : ""}${input.message.slice(0, 80)}`;
    const fixHref = fixUrl ?? opsLink("fix", fingerprint);
    const fixLabel = fixUrl ? (sev === "low" ? "Claude is fixing it (merges itself if the checks pass)" : "Claude is already on it") : "Have Claude fix it";
    const text = [
      d ? `What happened: ${d.summary}` : `Something broke in Kaizen Ads: ${input.message}`,
      d ? `Why: ${d.cause}` : "",
      d ? `Impact: ${d.impact}${d.dataRisk ? " (data may be affected)" : ""}` : "",
      d ? `What would fix it: ${d.fix}` : "",
      `What was done: ${handled}`,
      "",
      `Error: ${input.message}`,
      `Where: ${path ?? "unknown"} (${input.kind}) · Who: ${who} · Times seen: ${count}`,
      sample.stack ? `\n${sample.stack}` : "",
      "",
      `Mark fixed: ${opsLink("resolve", fingerprint)}`,
      `Stop alerting me about this: ${opsLink("mute", fingerprint)}`,
      `${fixLabel}: ${fixHref}`,
      `All errors: ${SITE}/settings?tab=errors`,
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n");
    const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:640px">
<p style="font-size:16px"><strong>${d ? esc(d.summary) : "Something broke in Kaizen Ads."}</strong></p>
<table style="border-collapse:collapse">
${d ? row("Why", esc(d.cause)) : ""}
${d ? row("Impact", esc(d.impact) + (d.dataRisk ? ' <strong style="color:#B21E2C">· data may be affected</strong>' : "")) : ""}
${row("Severity", sev === "high" ? '<strong style="color:#B21E2C">High</strong>' : sev === "low" ? "Low" : "Medium")}
${d ? row("What would fix it", esc(d.fix)) : ""}
${row("What was done", esc(handled))}
${row("Error", `<code>${esc(input.message)}</code>`)}
${row("Where", `${esc(path ?? "unknown")} (${input.kind})`)}
${row("Who", esc(who))}
${row("Times seen", String(count))}
</table>
<p style="margin-top:16px">${button(opsLink("resolve", fingerprint), "Mark fixed")}${button(opsLink("mute", fingerprint), "Stop alerting me")}${button(fixHref, fixLabel, true)}</p>
${sample.stack ? `<details><summary style="color:#666">Technical details</summary><pre style="background:#f5f5f5;padding:10px;border-radius:6px;font-size:12px;overflow:auto">${esc(sample.stack)}</pre></details>` : ""}
<p style="color:#888;font-size:12px">${d?.by === "claude" ? "Diagnosed by Claude from the error details. " : ""}At most one email an hour per error. <a href="${SITE}/settings?tab=errors">All errors</a></p></div>`;
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
