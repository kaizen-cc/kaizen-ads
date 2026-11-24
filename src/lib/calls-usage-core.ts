// Settings › Calls & usage (the owner only): the pure parts. Which team a person is on, how the month's cost is
// projected to its end, and how the call log is grouped (flagged first, then by team). Tested in
// tests/calls-usage.test.ts; the data is read in src/lib/calls-usage.ts.

export const TEAMS = [
  ["execs", "Executives"],
  ["ads", "Ads"],
  ["creative", "Creative"],
  ["email", "Email"],
  ["social", "Social"],
  ["cs", "CS & onboarding"],
  ["other", "Everyone else"],
] as const;
export type TeamKey = (typeof TEAMS)[number][0];
export const teamLabel = (k: string) => TEAMS.find(([t]) => t === k)?.[1] ?? "Everyone else";

/** The team (role line) a person's role is on; an executive is an executive whatever the role says */
export function teamOf(role: string | null | undefined, isExec?: boolean | null): TeamKey {
  const r = String(role ?? "");
  if (isExec || r === "executive") return "execs";
  if (/^(media_buyer|google_buyer|head_of_meta|head_of_google|tiktok_buyer)$/.test(r)) return "ads";
  if (/(graphic_designer|video_editor|head_of_creative|copywriter|creative_director|motion)/.test(r)) return "creative";
  if (/email/.test(r)) return "email";
  if (/social/.test(r)) return "social";
  if (/^(customer_success|cs_coordinator|onboarding_specialist|tracking_specialist|account_manager)$/.test(r)) return "cs";
  return "other";
}

const isWorkday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/** Working days (Mon to Fri) in the month of `today` (YYYY-MM-DD) after today */
export function workingDaysLeft(today: string): number {
  const [y, m, d] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let day = d + 1; day <= last; day++) if (isWorkday(new Date(Date.UTC(y, m - 1, day)))) n++;
  return n;
}

export const PROJECTION_METHOD = "Month to date, plus the pace (month to date ÷ the days they used it) × the working days left this month (Mon to Fri, after today).";

/** The end-of-month projection: month to date + (month to date per active day) × the working days left */
export function projectMonth(mtd: number, activeDays: number, today: string): { projected: number; pace: number; daysLeft: number } {
  const daysLeft = workingDaysLeft(today);
  const pace = activeDays > 0 ? mtd / activeDays : 0;
  return { projected: mtd + pace * daysLeft, pace, daysLeft };
}

export type LogEntry = { id: string; kind: "call" | "chat"; team: TeamKey; flagged: boolean; at: string };

/** Flagged first, then normal; each by team in TEAMS order, newest first inside a team */
export function groupLog<E extends LogEntry>(entries: readonly E[]): { flagged: boolean; teams: { team: TeamKey; label: string; entries: E[] }[] }[] {
  const out: { flagged: boolean; teams: { team: TeamKey; label: string; entries: E[] }[] }[] = [];
  for (const flagged of [true, false]) {
    const mine = entries.filter((e) => e.flagged === flagged);
    if (!mine.length) continue;
    const teams = TEAMS.map(([team, label]) => ({ team, label, entries: mine.filter((e) => e.team === team).sort((a, b) => b.at.localeCompare(a.at)) })).filter((t) => t.entries.length);
    out.push({ flagged, teams });
  }
  return out;
}

/** "12m", "1h 05m", "40s" */
export function lengthLabel(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const USAGE_SORTS = ["cost", "projected", "calls", "chats", "minutes", "messages", "tokens", "name"] as const;
export type UsageSort = (typeof USAGE_SORTS)[number];
export type UsagePerson = { id: string; name: string; team: TeamKey; calls: number; chats: number; minutes: number; messages: number; input: number; output: number; cacheW: number; cacheR: number; cost: number; projected: number; activeDays: number; daily: { day: string; cost: number }[] };

export function sortPeople<P extends UsagePerson>(people: readonly P[], by: UsageSort): P[] {
  const key = (p: P): number | string => (by === "name" ? p.name.toLowerCase() : by === "tokens" ? p.input + p.output + p.cacheW + p.cacheR : p[by]);
  return [...people].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return typeof x === "string" ? x.localeCompare(String(y)) : (y as number) - x || a.name.localeCompare(b.name);
  });
}

/** "1.2M", "34k", "980" */
export const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
export const dollars = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
