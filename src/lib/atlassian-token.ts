// The Atlassian API token behind Loom's connection lasts a year at most. Its expiry date (set on the Settings card, or
// ATLASSIAN_TOKEN_EXPIRES_AT) drives a countdown and notices to the execs at 30, 14, 7 and 1 days before. Pure, so the
// card, the cron and the tests share it.

/** Atlassian's page for a new API token, prefilled for the MCP server with the longest expiry */
export const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=mcp-v2&selectedScopes=all";

/** What to do with it, in order */
export const TOKEN_STEPS = [
  "Make a new token, signed in to Atlassian as the account whose Looms we pull.",
  "Replace ATLASSIAN_API_TOKEN in Vercel with it, and redeploy.",
  "Set the new expiry date on the Loom (Atlassian) card in Settings › Connections.",
];

export const THRESHOLDS = [30, 14, 7, 1] as const;

const DAY = 86_400_000;
const isDate = (s: string | null | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()));

/** The expiry date in force: the one set on the card, else the env default (YYYY-MM-DD), else none */
export function tokenExpiry(saved: string | null | undefined, env: string | null | undefined = process.env.ATLASSIAN_TOKEN_EXPIRES_AT): { date: string; from: "set" | "env" } | null {
  const s = saved?.slice(0, 10);
  if (isDate(s)) return { date: s, from: "set" };
  const e = env?.trim().slice(0, 10);
  if (isDate(e)) return { date: e, from: "env" };
  return null;
}

/** Whole days from `today` to `date` (both YYYY-MM-DD): 0 on the day, negative after */
export const daysUntil = (date: string, today: string) => Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY);

/**
 * The notice due today, if any: the smallest threshold already reached that hasn't been sent for this date. When the
 * date was set late (12 days left), only the 14-day notice goes, and the 30-day one is counted as passed. Returns the
 * threshold to send and every threshold to mark sent.
 */
export function dueNotice(daysLeft: number, sent: number[]): { send: number; mark: number[] } | null {
  if (daysLeft < 0) return null;
  const reached = THRESHOLDS.filter((t) => daysLeft <= t);
  if (!reached.length) return null;
  const send = Math.min(...reached);
  if (sent.includes(send)) return null;
  return { send, mark: reached.filter((t) => !sent.includes(t)) };
}

/** The countdown as words */
export function countdown(daysLeft: number) {
  if (daysLeft < 0) return `Expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
  if (daysLeft === 0) return "Expires today";
  if (daysLeft === 1) return "Expires tomorrow";
  return `Expires in ${daysLeft} days`;
}
