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

/** Add labels to an issue (the claude-fix workflow acts on some: approved-merge has it merge the fix). */
export async function labelIssue(issue: number, labels: string[], create?: { name: string; color: string; description: string }) {
  if (create) await github("/labels", { body: create }).catch(() => null);
  const res = await github(`/issues/${issue}/labels`, { body: { labels } }).catch(() => null);
  return res?.ok ? { ok: true as const } : { error: res ? `GitHub said ${res.status}` : "GitHub isn't connected (GITHUB_TOKEN)" };
}

/** Comment on an issue or a pull request. */
export async function commentOn(number: number, body: string) {
  const res = await github(`/issues/${number}/comments`, { body: { body } }).catch(() => null);
  return Boolean(res?.ok);
}

/** Close an issue (as not planned) or a pull request. */
export async function closeOn(number: number, kind: "issue" | "pull") {
  const res = await github(kind === "pull" ? `/pulls/${number}` : `/issues/${number}`, { method: "PATCH", body: kind === "pull" ? { state: "closed" } : { state: "closed", state_reason: "not_planned" } }).catch(() => null);
  return Boolean(res?.ok);
}

/**
 * Change one file on main through the API, committed as kaizen-cc (the only identity Vercel deploys): read it,
 * change it, write it back. A conflict (someone pushed in between) is tried once more.
 */
export async function editRepoFile(path: string, message: string, change: (text: string) => string): Promise<{ ok: true; url: string | null } | { error: string }> {
  if (!githubConfigured()) return { error: "GitHub isn't connected (GITHUB_TOKEN)" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await github(`/contents/${path}?ref=main`).catch(() => null);
    if (!res?.ok) return { error: `Couldn't read ${path} (GitHub said ${res?.status ?? "nothing"})` };
    const file = (await res.json()) as { content: string; sha: string };
    const before = Buffer.from(file.content, "base64").toString("utf8");
    const after = change(before);
    if (after === before) return { ok: true, url: null };
    const who = { name: "kaizen-cc", email: "santi@kaizenmarketing.agency" };
    const put = await github(`/contents/${path}`, {
      method: "PUT",
      body: { message, content: Buffer.from(after, "utf8").toString("base64"), sha: file.sha, branch: "main", committer: who, author: who },
    }).catch(() => null);
    if (put?.ok) return { ok: true, url: ((await put.json()) as { commit?: { html_url?: string } }).commit?.html_url ?? null };
    if (put?.status !== 409) return { error: `Couldn't save ${path} (GitHub said ${put?.status ?? "nothing"})` };
  }
  return { error: `${path} kept changing; try again` };
}
