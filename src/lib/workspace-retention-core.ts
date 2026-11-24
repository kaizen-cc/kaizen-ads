// How long raw Workspace content stays whole (Google's Workspace AI Tools Addendum, Nov 24 2026: AI tools may not keep
// Workspace user data beyond the task it was fetched for). Raw email bodies older than the window are cut to a short
// gist (the length the Brand Bible, playbooks and briefs already read from an old email), so the features that look
// back still have the who, when, subject and the point, but no full copy of the mailbox. docs/WORKSPACE-MCP.md.

export const GIST_CHARS = 600;

/** Days an email body stays whole: GMAIL_BODY_KEEP_DAYS, 90 by default, never under 14 */
export function bodyKeepDays(env: string | undefined = process.env.GMAIL_BODY_KEEP_DAYS): number {
  const n = Math.round(Number(env));
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.max(14, n);
}

/** An old body as the gist kept (the same cut the database makes: the first 600 characters and an ellipsis) */
export function trimmedBody(body: string): string {
  return body.length <= GIST_CHARS ? body : `${body.slice(0, GIST_CHARS)}…`;
}
