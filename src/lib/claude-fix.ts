import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

const LABEL = "claude-fix";
const repo = () => process.env.GITHUB_REPO || "kaizen-cc/kaizen-ads";
export const githubConfigured = () => Boolean(process.env.GITHUB_TOKEN);

/** A GitHub REST call for the repo (null when GitHub isn't connected). */
export async function github(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return fetch(`https://api.github.com/repos/${repo()}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "kaizen-ads" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
}

export const commitUrl = (sha: string) => `https://github.com/${repo()}/commit/${sha}`;

/**
 * Open a GitHub issue labelled claude-fix: the claude-fix workflow picks it up and opens a pull request. With
 * autoMerge it's also labelled auto-merge, and the workflow merges the fix itself once every check passes (and it
 * stays out of the database and the other protected files); without it the pull request waits for someone to merge.
 */
export async function openClaudeIssue(title: string, body: string, autoMerge: boolean): Promise<{ url?: string; number?: number; error?: string }> {
  if (!githubConfigured()) return { error: "Automatic fixes aren't connected yet: add GITHUB_TOKEN in Vercel." };
  // Make sure the labels exist (422 = they already do)
  await github("/labels", { body: { name: LABEL, color: "B21E2C", description: "Kaizen Ads error handed to Claude to fix" } }).catch(() => null);
  if (autoMerge) await github("/labels", { body: { name: "auto-merge", color: "2EB67D", description: "Low-severity fix: merges itself when the checks pass" } }).catch(() => null);
  const res = await github("/issues", { body: { title: title.slice(0, 200), body, labels: autoMerge ? [LABEL, "auto-merge"] : [LABEL] } });
  if (!res) return { error: "Automatic fixes aren't connected yet: add GITHUB_TOKEN in Vercel." };
  if (!res.ok) return { error: `GitHub said ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const issue = (await res.json()) as { html_url: string; number: number };
  return { url: issue.html_url, number: issue.number };
}

/**
 * Hand an error to Claude: open a GitHub issue labelled claude-fix with everything we know.
 * The claude-fix workflow picks it up and opens a pull request. Returns the issue link.
 */
export async function createFixIssue(fingerprint: string, by = "by Santi", autoMerge = false): Promise<{ url?: string; error?: string }> {
  if (!githubConfigured()) return { error: "Automatic fixes aren't connected yet: add GITHUB_TOKEN in Vercel." };
  const admin = createAdminClient();
  const { data: e } = await admin
    .from("error_events")
    .select("fingerprint, message, path, kind, count, people, sample, diagnosis, fix_issue_url")
    .eq("fingerprint", fingerprint)
    .maybeSingle();
  if (!e) return { error: "That error is gone" };
  if (e.fix_issue_url) return { url: e.fix_issue_url };

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
  const issue = await openClaudeIssue(`Fix: ${e.message.slice(0, 120)}`, body, autoMerge);
  if (!issue.url) return { error: issue.error };
  await admin.from("error_events").update({ fix_issue_url: issue.url }).eq("fingerprint", e.fingerprint);
  return { url: issue.url };
}
