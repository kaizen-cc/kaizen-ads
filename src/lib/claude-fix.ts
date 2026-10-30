import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

const LABEL = "claude-fix";

/**
 * Hand an error to Claude: open a GitHub issue labelled claude-fix with everything we know.
 * The claude-fix workflow picks it up and opens a pull request. Returns the issue link.
 */
export async function createFixIssue(fingerprint: string, by = "by Santi", autoMerge = false): Promise<{ url?: string; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "kaizen-cc/kaizen-ads";
  if (!token) return { error: "Automatic fixes aren't connected yet: add GITHUB_TOKEN in Vercel." };
  const admin = createAdminClient();
  const { data: e } = await admin
    .from("error_events")
    .select("fingerprint, message, path, kind, count, people, sample, diagnosis, fix_issue_url")
    .eq("fingerprint", fingerprint)
    .maybeSingle();
  if (!e) return { error: "That error is gone" };
  if (e.fix_issue_url) return { url: e.fix_issue_url };

  const gh = (path: string, body: unknown) =>
    fetch(`https://api.github.com/repos/${repo}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "kaizen-ads" },
      body: JSON.stringify(body),
    });
  // Make sure the label exists (422 = it already does)
  await gh("/labels", { name: LABEL, color: "B21E2C", description: "Kaizen Ads error handed to Claude to fix" }).catch(() => null);

  const d = (e.diagnosis ?? {}) as Record<string, unknown>;
  const sample = (e.sample ?? {}) as Record<string, unknown>;
  const body = [
    `Reported by Kaizen Ads's error monitor and handed to Claude ${by}.`,
    ``,
    `**Error:** \`${e.message}\``,
    `**Where:** ${e.path ?? "unknown"} (${e.kind}) · seen ${e.count}× · people: ${((e.people as string[]) ?? []).join(", ") || "unknown"}`,
    d.summary ? `\n**What happened:** ${d.summary}` : "",
    d.cause ? `**Likely cause:** ${d.cause}` : "",
    d.impact ? `**Impact:** ${d.impact}` : "",
    d.fix ? `**Suggested fix:** ${d.fix}` : "",
    sample.stack ? `\n**Stack:**\n\`\`\`\n${sample.stack}\n\`\`\`` : "",
    sample.userAgent ? `**Browser:** ${sample.userAgent}` : "",
    ``,
    `Fingerprint: \`${e.fingerprint}\``,
  ]
    .filter(Boolean)
    .join("\n");
  // auto-merge: low severity, so the workflow merges the fix itself once every check passes
  if (autoMerge) await gh("/labels", { name: "auto-merge", color: "2EB67D", description: "Low-severity fix: merges itself when the checks pass" }).catch(() => null);
  const res = await gh("/issues", { title: `Fix: ${e.message.slice(0, 120)}`, body, labels: autoMerge ? [LABEL, "auto-merge"] : [LABEL] });
  if (!res.ok) return { error: `GitHub said ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const issue = (await res.json()) as { html_url: string };
  await admin.from("error_events").update({ fix_issue_url: issue.html_url }).eq("fingerprint", e.fingerprint);
  return { url: issue.html_url };
}
