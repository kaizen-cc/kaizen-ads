import { createFixIssue } from "@/lib/claude-fix";
import { readOpsToken, type OpsAction } from "@/lib/ops-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Buttons in error emails land here. Opening the link only shows a confirm button (mail scanners
// open links on their own), and the POST from that button does the work.
export const dynamic = "force-dynamic";

const LABEL: Record<OpsAction, { title: string; button: string }> = {
  resolve: { title: "Mark this error as fixed?", button: "Mark fixed" },
  mute: { title: "Stop alerting you about this error?", button: "Stop alerting me" },
  fix: { title: "Have Claude fix this error?", button: "Have Claude fix it" },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kaizen Ads</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0b;color:#f2f2f2;font-family:system-ui,sans-serif">
<main style="max-width:440px;padding:28px;margin:16px;border:1px solid #2a2a2a;border-radius:8px;background:#141414">
<p style="margin:0 0 4px;color:#e0505c;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Kaizen Ads</p>
<h1 style="margin:0 0 12px;font-size:20px">${title}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
const link = (href: string, text: string) => `<p><a href="${href}" style="color:#e0505c">${text}</a></p>`;

async function load(fingerprint: string) {
  const { data } = await createAdminClient()
    .from("error_events")
    .select("fingerprint, message, path, kind, count, people, sample, diagnosis, fix_issue_url, resolved_at, muted_at")
    .eq("fingerprint", fingerprint)
    .maybeSingle();
  return data;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t");
  const t = readOpsToken(token);
  if (!t || !adminConfigured()) return page("This link has expired", "<p>Open Settings › Errors in Kaizen Ads instead.</p>", 400);
  const e = await load(t.fingerprint);
  if (!e) return page("That error is gone", link("https://ads.kaizenmarketing.agency/settings?tab=errors", "Open Settings › Errors"), 404);
  if (t.action === "fix" && e.fix_issue_url) return page("Claude is already on it", link(e.fix_issue_url, "See the fix in GitHub"));
  const l = LABEL[t.action];
  return page(
    l.title,
    `<p style="color:#bbb">${esc(e.message)}<br><span style="color:#777;font-size:13px">${esc(e.path ?? "")} · ${e.count}×</span></p>
${t.action === "fix" ? '<p style="color:#bbb;font-size:14px">Claude reads the error, finds the cause in the code and opens a fix as a pull request. Nothing goes live until you approve (merge) it in GitHub.</p>' : ""}
<form method="post"><input type="hidden" name="t" value="${esc(token!)}"><button style="margin-top:8px;padding:11px 16px;border:0;border-radius:5px;background:#B21E2C;color:#fff;font-weight:600;font-size:15px;cursor:pointer">${l.button}</button></form>`,
  );
}

export async function POST(req: Request) {
  const form = await req.formData();
  const t = readOpsToken(String(form.get("t") ?? ""));
  if (!t || !adminConfigured()) return page("This link has expired", "<p>Open Settings › Errors in Kaizen Ads instead.</p>", 400);
  const admin = createAdminClient();
  const e = await load(t.fingerprint);
  if (!e) return page("That error is gone", "", 404);

  if (t.action === "resolve") {
    await admin.from("error_events").update({ resolved_at: new Date().toISOString() }).eq("fingerprint", e.fingerprint);
    return page("Marked fixed ✓", "<p>If it happens again it reopens and you'll get a fresh email.</p>");
  }
  if (t.action === "mute") {
    await admin.from("error_events").update({ muted_at: new Date().toISOString(), resolved_at: new Date().toISOString() }).eq("fingerprint", e.fingerprint);
    return page("You won't be emailed about this one again ✓", "<p>It's still recorded in Settings › Errors.</p>");
  }

  // fix: hand it to Claude through a GitHub issue (the claude-fix workflow picks it up)
  if (e.fix_issue_url) return page("Claude is already on it", link(e.fix_issue_url, "See the fix in GitHub"));
  const r = await createFixIssue(e.fingerprint);
  if (!r.url) return page("Couldn't hand it to Claude", `<p>${esc(r.error ?? "Unknown problem")}</p>`, 502);
  return page(
    "Claude is on it ✓",
    `<p>It'll open a pull request with the fix and explain what happened, why, and what changed. GitHub emails you when it's ready — merge it to put it live.</p>${link(r.url, "Follow along in GitHub")}`,
  );
}
