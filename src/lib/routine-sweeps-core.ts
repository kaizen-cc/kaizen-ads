// The call debrief sweep and the delegation tracker (owner, Nov 24 2026; spec docs/kyle-scheduled-runs.md #1 and #5):
// the pure rules. Tested in tests/routine-sweeps.test.ts.

/** A date some business days after another (YYYY-MM-DD) */
export function addBusinessDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * When an item is due: the date that was said, else soon when it's about a client, revenue or churn or someone is
 * blocked (`soonDays`), else later (`laterDays`).
 */
export function dueOf(today: string, stated: string | null | undefined, urgent: boolean, soonDays: number, laterDays: number): string {
  if (stated && /^\d{4}-\d{2}-\d{2}$/.test(stated) && stated >= today) return stated;
  return addBusinessDays(today, urgent ? soonDays : laterDays);
}

/** "[Call 11/24] …", "[Slack 11/24] …" */
export const tagged = (kind: "Call" | "Email" | "Slack" | "Sales" | "Agent", date: string, text: string) => `[${kind} ${date.slice(5, 7)}/${date.slice(8, 10)}] ${text}`.slice(0, 300);

export type Person = { id: string; name: string; email?: string | null };

/**
 * A teammate from a name as people say it in Slack or a call ("@Mel", "Lucas", "mel g"): the exact full name, else a
 * unique first name, else a unique name that starts with it. Ambiguous or unknown: null (the report says so).
 */
export function matchPerson(said: string, people: readonly Person[]): Person | null {
  const n = said.replace(/^@/, "").trim().toLowerCase();
  if (!n) return null;
  const exact = people.filter((p) => p.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const first = people.filter((p) => p.name.toLowerCase().split(" ")[0] === n.split(" ")[0]);
  if (first.length === 1) return first[0];
  const starts = people.filter((p) => p.name.toLowerCase().startsWith(n));
  return starts.length === 1 ? starts[0] : null;
}

/** Meetings with people outside Kaizen that have no notes from Gemini or Fireflies (matched within 20 minutes) */
export function coverageGaps(meetings: readonly { title: string; start: string; external: readonly string[] }[], calls: readonly { at: string }[], now = Date.now()): { title: string; start: string }[] {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 60_000;
  return meetings.filter((m) => m.external.length > 0 && Date.parse(m.start) < now - 45 * 60_000 && !calls.some((c) => near(c.at, m.start))).map((m) => ({ title: m.title, start: m.start }));
}
