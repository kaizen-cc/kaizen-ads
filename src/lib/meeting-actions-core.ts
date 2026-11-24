// Internal meetings with an executive on them (the C-suite meeting, an exec's 1:1s): each action item becomes a task
// for the teammate who owns it, on their Overview (the owner's Nov 24 2026 call: "exec meeting notes feed tasks for
// their owners"). The pure parts: who owns an item, and whether a meeting counts. The rest is src/lib/meeting-actions.ts.

export type Teammate = { id: string; full_name: string | null; email: string | null; is_exec: boolean | null };

const norm = (s: string | null | undefined) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The teammate an item names: the full name, an email, or a first name only one active teammate has; never a guess */
export function ownerFor(name: string | null | undefined, team: readonly Teammate[]): Teammate | null {
  const n = norm(name);
  if (!n) return null;
  const full = team.filter((t) => norm(t.full_name) === n || norm(t.email) === n);
  if (full.length === 1) return full[0];
  const first = n.split(" ")[0];
  const byFirst = team.filter((t) => norm(t.full_name).split(" ")[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Whether an executive ran or sat in on the meeting (its host's email, or a name or email in the attendees) */
export function execOnMeeting(host: string | null | undefined, attendees: readonly string[] | null | undefined, team: readonly Teammate[]): boolean {
  const execs = team.filter((t) => t.is_exec);
  const h = norm(host);
  if (h && execs.some((e) => norm(e.email) === h)) return true;
  const who = norm((attendees ?? []).join(" "));
  return execs.some((e) => (e.email && who.includes(norm(e.email))) || (e.full_name && who.includes(norm(e.full_name))));
}

/** The task's ref, so a meeting's items are filed once */
export const meetingRef = (callId: string, i: number) => `meet:${callId}:${i}`;
