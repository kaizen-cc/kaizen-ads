// How much of a call goes back to the agent with each turn, and how a long turn is taken. Pure: no keys, no calls.
// A call can run thirty minutes: sending every line every turn would make each answer slower than the last, so the
// latest lines go as they were said and anything older as a short digest of what was asked.

/** The latest lines of the call sent as they were said */
export const RECENT_LINES = 24;
/** The digest of older lines, at most this long */
export const DIGEST_CHARS = 1800;
/** A turn longer than this (a very long monologue) keeps its start and its end */
export const TURN_CHARS = 20_000;

/** A turn as the agent gets it: whole, unless it's truly huge (then its start and end, with a note of the cut) */
export function longTurnText(text: string): string {
  const t = text.trim();
  if (t.length <= TURN_CHARS) return t;
  const head = t.slice(0, 7000);
  const tail = t.slice(t.length - (TURN_CHARS - 7000 - 60));
  return `${head} [... a long middle part is left out here ...] ${tail}`;
}

export type HistoryLine = { role: string; content: string; role_key?: string | null };

/**
 * A call's lines for the prompt: the latest RECENT_LINES whole, and before them a digest (the start of each thing the
 * person said, newest kept when it runs long) so the agent still knows what was covered. `rows` are oldest first.
 */
export function callHistory<T extends HistoryLine>(rows: readonly T[]): { recent: T[]; digest: string | null } {
  if (rows.length <= RECENT_LINES) return { recent: rows.slice(), digest: null };
  const older = rows.slice(0, rows.length - RECENT_LINES);
  const recent = rows.slice(rows.length - RECENT_LINES);
  const asked = older
    .filter((r) => r.role === "user")
    .map((r) => {
      const c = r.content.replace(/\s+/g, " ").trim();
      return c.length > 140 ? `${c.slice(0, 137)}...` : c;
    })
    .filter(Boolean);
  const kept: string[] = [];
  let size = 0;
  for (let i = asked.length - 1; i >= 0; i--) {
    if (size + asked[i].length + 3 > DIGEST_CHARS) break;
    kept.unshift(asked[i]);
    size += asked[i].length + 3;
  }
  const skipped = asked.length - kept.length;
  const digest = `Earlier in this call (${older.length} lines) they asked about: ${skipped ? `(${skipped} earlier things) ` : ""}${kept.map((k) => `"${k}"`).join("; ")}`;
  return { recent, digest };
}
