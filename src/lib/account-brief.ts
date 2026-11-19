// "What to know" about one ad account, on hover over its Overview card (owner, Nov 19 2026): the five most critical
// things a head of the line should know before touching it, worst first, each one plain line. Pure, so it's tested.

export type BriefTone = "bad" | "warn" | "ok";
export type BriefItem = { tone: BriefTone; text: string; weight: number };

export type BriefInput = {
  status: "excellent" | "good" | "close" | "off" | "idle" | "setup" | "unset";
  label: string;
  value: string | null;
  target: string | null;
  deviation: number | null;
  pacing: "over" | "under" | "check" | null;
  pace: number | null;
  spend30: number;
  hasAccount: boolean;
  owed?: { n: number; escalated: number } | null;
  audit?: { status: "running" | "ready" | "failed"; band: "good" | "watch" | "bad" | null; headline: string | null; actions: number; done: number; createdAt: string } | null;
  sprint?: { moves: number; done: number; score: number | null; baseline: number | null; lastDoneAt: string | null; startedAt: string } | null;
  /** Open direction changes from the client on this line, newest first */
  changes?: { summary: string; pending: number }[];
  /** Promises the team made to this client that are overdue */
  overduePromises?: number;
  /** The client's creative allotment this cycle, when it's behind */
  creativeBehind?: string | null;
};

const days = (iso: string | null | undefined, now: number) => (iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : null);
const pctText = (d: number) => `${Math.round(Math.abs(d) * 100)}%`;

/** The five things to know, worst first (nothing critical: what's going well, so the card never says nothing) */
export function accountBrief(i: BriefInput, now = Date.now()): BriefItem[] {
  const out: BriefItem[] = [];
  const add = (tone: BriefTone, weight: number, text: string) => out.push({ tone, weight, text });

  if (!i.hasAccount) add("bad", 100, "No ad account is linked, so nothing is being measured");
  else if (i.status === "setup" || i.status === "unset") add("warn", 60, "No KPI is set: the account isn't being judged against anything");

  if (i.status === "off" && i.deviation != null) add("bad", 90 + Math.min(30, Math.abs(i.deviation) * 20), `${i.label || "The KPI"} is ${pctText(i.deviation)} off target (${i.value ?? "n/a"} vs ${i.target ?? "n/a"}, last 14 days)`);
  else if (i.status === "close" && i.deviation != null) add("warn", 50, `${i.label || "The KPI"} is close to target but slipping (${i.value ?? "n/a"} vs ${i.target ?? "n/a"})`);
  else if (i.status === "idle") add("bad", 85, "No spend lately: the account has gone quiet");

  if (i.owed?.escalated) add("bad", 95, `${i.owed.escalated === 1 ? "A client message has" : `${i.owed.escalated} client messages have`} gone unanswered past the second notice`);
  else if (i.owed?.n) add("warn", 55, `${i.owed.n === 1 ? "A message is" : `${i.owed.n} messages are`} waiting on a reply`);

  for (const c of (i.changes ?? []).slice(0, 2)) add(c.pending ? "bad" : "warn", c.pending ? 88 : 45, `The client changed direction: ${c.summary}${c.pending ? ` (${c.pending} piece${c.pending === 1 ? "" : "s"} still to adapt)` : ""}`);

  if (i.overduePromises) add("bad", 80, `${i.overduePromises === 1 ? "A promise to the client is" : `${i.overduePromises} promises to the client are`} overdue`);

  if (i.pacing === "over") add("warn", 65, `Spending over pace${i.pace != null ? ` (${Math.round(i.pace * 100)}% of where the budget should be)` : ""}`);
  else if (i.pacing === "under") add("warn", 58, `Spending under pace${i.pace != null ? ` (${Math.round(i.pace * 100)}% of where the budget should be)` : ""}: results may be left on the table`);
  else if (i.pacing === "check") add("warn", 40, "The budget pace needs a check");

  if (i.audit?.status === "failed") add("warn", 52, "The last audit didn't finish: run it again");
  else if (i.audit?.status === "ready" && i.audit.band === "bad") add("bad", 75, `The latest audit says it's in trouble${i.audit.headline ? `: ${i.audit.headline}` : ""}`);
  else if (i.audit?.status === "ready" && i.audit.actions > i.audit.done) add("warn", 42, `${i.audit.actions - i.audit.done} audit action${i.audit.actions - i.audit.done === 1 ? "" : "s"} still open`);

  if (i.sprint) {
    const idle = days(i.sprint.lastDoneAt ?? i.sprint.startedAt, now);
    if (i.sprint.score != null && i.sprint.baseline != null && i.sprint.score < i.sprint.baseline) add("bad", 70, `The sprint isn't working yet: the score fell from ${i.sprint.baseline} to ${i.sprint.score}`);
    else if (idle != null && idle >= 5 && i.sprint.done < i.sprint.moves) add("warn", 48, `The sprint has stalled: no move done in ${idle} days (${i.sprint.done} of ${i.sprint.moves})`);
  }

  if (i.creativeBehind) add("warn", 46, `Creative is behind: ${i.creativeBehind}`);

  if (!out.length) {
    if (i.status === "excellent" || i.status === "good") add("ok", 1, `${i.label || "The KPI"} is on target (${i.value ?? "n/a"} vs ${i.target ?? "n/a"})`);
    add("ok", 0, "Nothing critical: no unanswered messages, no open changes, spend on pace");
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 5);
}
