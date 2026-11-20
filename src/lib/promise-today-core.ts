// The person's own promises and owed replies on their Today card (owner, Nov 20 2026): every Slack message or email
// they owe a reply to, and everything THEY promised (in Slack, email or on a call) that hasn't happened, is critical,
// at the top, with a message drafted for wherever it happened. The pure rules, tested in tests/promise-today.test.ts.

/** The recap makes 80+ critical; a person's own owed reply or late promise sits above every other critical item */
export const OWN_FLOOR = 90;

/** How urgent the person's own item is: always critical, rising as it gets later, capped below an on-fire client (99+) */
export function ownScore(kind: "said" | "owed" | "call", o: { late: number; escalated?: boolean; dueInDays?: number }): number {
  if (kind === "call" && (o.dueInDays ?? 0) > 0) return o.dueInDays! <= 1 ? 84 : 0;
  const base = o.escalated ? 96 : OWN_FLOOR + (kind === "owed" ? 0 : 1);
  return Math.min(98, base + Math.max(0, o.late) * 2);
}

/** Which call promises belong on someone's Today: theirs (routed to them), open, due within a day or past due */
export function callOnToday(p: { routedTo: readonly string[] | null; status: string; dueAt: string }, me: string, now = Date.now()): boolean {
  if (!(p.routedTo ?? []).includes(me)) return false;
  if (p.status !== "open" && p.status !== "briefed") return false;
  return Date.parse(p.dueAt) - now <= 86_400_000;
}

export type Destination = { source: "slack"; channelId: string; url: string } | { source: "gmail"; to: string; url: string } | null;

/**
 * Where an update on a call promise goes: the client's Slack channel, or email for a client that works by email only (an
 * email-only client never gets a Slack message). The person sends it themselves; nothing is posted for them.
 */
export function callDestination(c: { slackChannelId: string | null; services: readonly string[]; contactEmail: string | null; subject: string }): Destination {
  const emailOnly = c.services.length > 0 && c.services.every((s) => s === "email-marketing" || s === "sms-marketing");
  if (c.slackChannelId && !emailOnly) return { source: "slack", channelId: c.slackChannelId, url: `https://slack.com/app_redirect?channel=${c.slackChannelId}` };
  if (c.contactEmail) return { source: "gmail", to: c.contactEmail, url: `mailto:${encodeURIComponent(c.contactEmail)}?subject=${encodeURIComponent(c.subject)}` };
  return null;
}
