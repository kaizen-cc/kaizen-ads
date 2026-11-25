// Reading a client's Slack channel (shared Slack Connect and internal), the pure parts (the owner, Nov 25 2026: a
// client's thread reply such as "do not send anything about Black Friday" was never read because its thread started
// before our last read, and conversations.history only lists messages posted after it). Parents are listed over a
// lookback window; only threads whose latest reply is newer than our last read have their replies fetched, so it
// stays light. Tested in tests/slack-read.test.ts.

/** How far back parents are listed, so a new reply in an older thread is found */
export const THREAD_LOOKBACK_DAYS = 14;

export type RawMessage = {
  ts: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: { name?: string; title?: string }[];
  user_profile?: { real_name?: string; display_name?: string };
};

const SKIP = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "group_join", "group_leave", "pinned_item", "bot_add", "bot_remove"]);

/** What a message says (its text, or the files it shares when there's no text); null for a join, a topic change or nothing */
export function messageText(m: RawMessage): string | null {
  if (m.subtype && SKIP.has(m.subtype)) return null;
  const text = String(m.text ?? "").trim();
  if (text) return text;
  const files = (m.files ?? []).map((f) => f.title || f.name).filter(Boolean);
  return files.length ? `Shared ${files.length === 1 ? "a file" : `${files.length} files`}: ${files.join(", ")}` : null;
}

/** Whether a message was posted after our last read */
export const isNew = (ts: string, since: number) => Number(ts) > since;

/** The threads (parent ts) with a reply newer than our last read: only those are read in full */
export const threadsWithNewReplies = (parents: readonly RawMessage[], since: number) =>
  parents.filter((m) => (m.reply_count ?? 0) > 0 && m.latest_reply && Number(m.latest_reply) > since).map((m) => m.ts);

/** The name to show for someone outside the workspace (a client in a Slack Connect channel), from the message itself */
export const profileName = (m: RawMessage) => m.user_profile?.real_name || m.user_profile?.display_name || null;
