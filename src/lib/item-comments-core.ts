// Comments on every Overview and Today item, the pure rules (tested in tests/item-comments.test.ts). One thread per
// thing, keyed by its stable key (src/lib/today-counts.ts stableKeyOf). A "waiting on client" mark pauses the item's
// reminders and escalations until something new happens: a new message from the client, a new asset, or its due date
// passing. Comments from the team don't end it ("still waiting" is still waiting); taking the mark off does.

export type ThreadState = { waiting_on_client: boolean; waiting_since: string | null; due_at: string | null };
export type Signals = { lastClientMessageAt?: string | null; lastAssetAt?: string | null };

export type PauseRead = { paused: true } | { paused: false; ended: null | "message" | "asset" | "due" };

/** Whether the item's reminders and escalations are paused now, and if a pause just ended, what ended it */
export function readPause(t: ThreadState | null | undefined, s: Signals = {}, now = new Date()): PauseRead {
  if (!t || !t.waiting_on_client) return { paused: false, ended: null };
  const since = t.waiting_since ? Date.parse(t.waiting_since) : 0;
  const after = (iso: string | null | undefined) => Boolean(iso && Date.parse(iso) > since);
  if (after(s.lastClientMessageAt)) return { paused: false, ended: "message" };
  if (after(s.lastAssetAt)) return { paused: false, ended: "asset" };
  if (t.due_at && Date.parse(t.due_at) <= now.getTime()) return { paused: false, ended: "due" };
  return { paused: true };
}

export const ENDED_SAY: Record<"message" | "asset" | "due", string> = {
  message: "The client wrote back, so reminders are on again.",
  asset: "The client sent a new asset, so reminders are on again.",
  due: "Its due date passed, so reminders are on again.",
};

/** The client a stable key belongs to can't be read from the key: the caller passes it. What kind of item a key is. */
export function kindOfKey(key: string): string {
  return key.split(":")[0] ?? "";
}

/** A comment as typed: trimmed, one blank line at most, capped */
export function cleanComment(body: unknown): string {
  return String(body ?? "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
}

/**
 * Who hears about a new comment, in the app only (never a Slack DM: team work stays in the OS): everyone the item
 * reached (it was on their day) and everyone who commented before, never the author.
 */
export function commentAudience(o: { author: string; reached: readonly string[]; commenters: readonly string[]; owners?: readonly (string | null | undefined)[] }): string[] {
  const out = new Set<string>();
  for (const id of [...o.reached, ...o.commenters, ...(o.owners ?? [])]) if (id && id !== o.author) out.add(id);
  return [...out];
}
