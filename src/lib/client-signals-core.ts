// The pure rules behind reading what clients (and the team) said that changes the work (src/lib/client-signals.ts).
// Tested in tests/client-signals.test.ts.

export type SignalKind = "cancel" | "dated_request" | "hold" | "resume" | "recurring";
export type Cadence = "daily" | "weekdays" | "weekly";
export type Recurring = { ownerId: string; owner: string; what: string; cadence: Cadence; weekday: number | null; until: string | null; from: string };

/** Who wrote it is on the team: a Kaizen address, or a teammate's name */
export function isTeamAuthor(author: string | null | undefined, teamNames: readonly string[]): boolean {
  const a = String(author ?? "").toLowerCase();
  if (!a) return false;
  if (/@kaizenmarketing\.agency|@contact\.kaizenmarketing\.agency/.test(a)) return true;
  const name = a.replace(/<[^>]*>/g, "").trim();
  return teamNames.some((t) => t.length > 2 && name === t.toLowerCase());
}

/** A subject with the client's name and "Re:" taken out, for spotting the same automated email across clients */
export function templateOf(title: string, clientName: string): string {
  let t = title.toLowerCase().replace(/^((re|fwd?):\s*)+/g, "");
  for (const w of clientName.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) t = t.split(w).join(" ");
  return t.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Subjects the team's mailboxes send to three or more clients (a monthly review, a check-in): automated sends */
export function automatedTemplates(sends: readonly { client: string; title: string }[], min = 3): Set<string> {
  const by = new Map<string, Set<string>>();
  for (const s of sends) {
    const t = templateOf(s.title, s.client);
    if (t.length < 6) continue;
    by.set(t, (by.get(t) ?? new Set()).add(s.client));
  }
  return new Set([...by].filter(([, cs]) => cs.size >= min).map(([t]) => t));
}

/** A client is on hold when its latest hold is newer than its latest resume (and within 45 days) */
export function onHold(rows: readonly { kind: string; said_at: string }[], now = Date.now()): { since: string } | null {
  const hold = rows.filter((r) => r.kind === "hold").sort((a, b) => b.said_at.localeCompare(a.said_at))[0];
  if (!hold || now - Date.parse(hold.said_at) > 45 * 86_400_000) return null;
  const resume = rows.filter((r) => r.kind === "resume").sort((a, b) => b.said_at.localeCompare(a.said_at))[0];
  return resume && resume.said_at > hold.said_at ? null : { since: hold.said_at };
}

/** A recurring commitment is due on a date (YYYY-MM-DD, its weekday 0 Sunday) between when it was said and its end */
export function recurringDue(r: Pick<Recurring, "cadence" | "weekday" | "until" | "from">, date: string, weekday: number): boolean {
  if (date < r.from.slice(0, 10)) return false;
  // No end said: a month at most
  const end = r.until ?? new Date(Date.parse(r.from) + 30 * 86_400_000).toISOString().slice(0, 10);
  if (date > end) return false;
  if (r.cadence === "weekdays") return weekday >= 1 && weekday <= 5;
  if (r.cadence === "weekly") return weekday === (r.weekday ?? 1);
  return true;
}

/** The refs the reader may kill ("A3" an item, "P2" a promise) back to their rows */
export function refsToIds(refs: readonly string[], asks: readonly { id: string }[], promises: readonly { id: string }[]): { asks: string[]; promises: string[] } {
  const out = { asks: [] as string[], promises: [] as string[] };
  for (const r of refs) {
    const m = /^([AP])(\d+)$/.exec(r.trim().toUpperCase());
    if (!m) continue;
    const row = (m[1] === "A" ? asks : promises)[Number(m[2]) - 1];
    if (row) (m[1] === "A" ? out.asks : out.promises).push(row.id);
  }
  return { asks: [...new Set(out.asks)], promises: [...new Set(out.promises)] };
}
