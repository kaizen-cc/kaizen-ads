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

// Words that mark a people matter (performance, discipline, firing, pay, health), checked on top of the model's flag.
// Kept narrow so ad work ("raise the budget", "Meta warning") isn't caught.
const PEOPLE_WORDS = /\b(fired|firing|fire (him|her|them)|terminat(e|ed|ing|ion)|let (him|her|them) go|letting (him|her|them) go|lay ?offs?|laid off|replac(e|ing) (him|her|them)|performance (review|issue|plan|problem|conversation)|pip|write[- ]?up|disciplin\w*|underperform\w*|demot\w*|salary|pay (raise|cut)|compensation|medical leave|sick leave|hr (issue|complaint|matter))\b/i;

/**
 * Whether a meeting item is a people matter and must not be filed (the owner's Nov 24 2026 rule: what's said about an
 * individual in a C-suite call, or to a client about an employee who's being let go, never reaches that employee as a
 * task or notice). True when the model flags it, when it names a people-matter word, or when its owner is one of the
 * teammates it's about.
 */
export function peopleMatter(it: { owner?: string | null; task?: string | null; detail?: string | null; personnel?: boolean; about?: readonly string[] | null }, team: readonly Teammate[]): boolean {
  if (it.personnel) return true;
  if (PEOPLE_WORDS.test(`${it.task ?? ""} ${it.detail ?? ""}`)) return true;
  const owner = ownerFor(it.owner, team);
  if (!owner) return false;
  return (it.about ?? []).some((name) => ownerFor(name, team)?.id === owner.id);
}

/** The task's ref, so a meeting's items are filed once */
export const meetingRef = (callId: string, i: number) => `meet:${callId}:${i}`;
