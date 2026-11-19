// Plain-number summaries for the email_marketing tool, so a strategist can ask "which subject lines work" and get an
// answer from the client's own sends. Pure (no server code) and tested in tests/email-insights.test.ts.

export type SubjectCampaign = { subject: string | null; channel: string; recipients: number; openRate: number | null; clickRate: number | null; revenue: number };

type Test = { name: string; test: (s: string) => boolean };

const URGENT = /\b(last chance|ends? (today|tonight|soon|tomorrow)|final|hurry|only \d+|today only|don'?t miss|limited|expires?|\d+ ?(hours?|hrs?) left)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

// Each trait is checked against the subject line alone; a subject can match several
const TRAITS: Test[] = [
  { name: "a question", test: (s) => s.includes("?") },
  { name: "a number or percentage", test: (s) => /\d/.test(s) },
  { name: "urgency wording", test: (s) => URGENT.test(s) },
  { name: "an emoji", test: (s) => EMOJI.test(s) },
  { name: "short (40 characters or fewer)", test: (s) => s.length <= 40 },
  { name: "long (over 60 characters)", test: (s) => s.length > 60 },
  { name: "ALL CAPS word", test: (s) => /\b[A-Z]{4,}\b/.test(s) },
];

export type SubjectPattern = { trait: string; campaigns: number; open_rate_pct: number | null; click_rate_pct: number | null; revenue_per_recipient: number | null };

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * How each subject line trait did: the send-weighted open and click rate and revenue per recipient across the email
 * campaigns that have it (at least `min` campaigns; traits with fewer are left out as noise). Rates come in as 0..1.
 */
export function subjectPatterns(campaigns: readonly SubjectCampaign[], min = 3): SubjectPattern[] {
  const emails = campaigns.filter((c) => c.channel !== "sms" && c.subject && c.recipients > 0);
  const roll = (rows: SubjectCampaign[], trait: string): SubjectPattern => {
    const sent = rows.reduce((s, c) => s + c.recipients, 0);
    const wsum = (get: (c: SubjectCampaign) => number | null) => {
      const have = rows.filter((c) => get(c) != null);
      const w = have.reduce((s, c) => s + c.recipients, 0);
      return w ? have.reduce((s, c) => s + (get(c) as number) * c.recipients, 0) / w : null;
    };
    const open = wsum((c) => c.openRate);
    const click = wsum((c) => c.clickRate);
    return { trait, campaigns: rows.length, open_rate_pct: open == null ? null : round(open * 100), click_rate_pct: click == null ? null : round(click * 100), revenue_per_recipient: sent ? round(rows.reduce((s, c) => s + c.revenue, 0) / sent, 3) : null };
  };
  const out: SubjectPattern[] = [];
  for (const t of TRAITS) {
    const rows = emails.filter((c) => t.test(c.subject as string));
    if (rows.length >= min) out.push(roll(rows, t.name));
  }
  if (emails.length >= min) out.unshift(roll(emails, "all email campaigns (the baseline)"));
  return out;
}

/** Subscribers gained and lost per week from the daily rows (newest week last), for "is the list growing" */
export function weeklyListChange(daily: readonly { date: string; subscribed: number | null; unsubscribed: number | null }[]): { week_starting: string; subscribed: number; unsubscribed: number }[] {
  const weeks = new Map<string, { subscribed: number; unsubscribed: number }>();
  for (const d of daily) {
    if (d.subscribed == null && d.unsubscribed == null) continue;
    const t = Date.parse(`${d.date}T12:00:00Z`);
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday first
    const start = new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
    const w = weeks.get(start) ?? { subscribed: 0, unsubscribed: 0 };
    w.subscribed += d.subscribed ?? 0;
    w.unsubscribed += d.unsubscribed ?? 0;
    weeks.set(start, w);
  }
  return [...weeks].sort((a, b) => a[0].localeCompare(b[0])).map(([week_starting, w]) => ({ week_starting, ...w }));
}

type BoardCheck = { key: string; label: string; value: number | null; bar: number; weight: number; points: number; met: boolean; unit: "pct" | "money" | "score" };
type BoardScore = {
  score: number;
  band: "good" | "watch" | "bad";
  checks: BoardCheck[];
  deliverability?: { score: number; parts: { label: string; rate: number; points: number; of: number; grade: string }[] } | null;
  window?: { from: string; to: string };
};

/**
 * The email KPI board's numbers for one client, as the agents read them: the email score with its band, each of the
 * eight checks against its bar, and the deliverability score (0 to 100) with its parts. The deliverability score is
 * Kaizen's own, worked out from the campaign sends (Klaviyo's API doesn't share Klaviyo's), so it lives here, not in
 * the provider's numbers. Null when the board has nothing to score.
 */
export function kpiBoardEmail(s: BoardScore | null | undefined) {
  if (!s) return null;
  const val = (unit: BoardCheck["unit"], x: number | null) => (x == null ? null : unit === "pct" ? Math.round(x * 10000) / 100 : unit === "money" ? Math.round(x * 1000) / 1000 : Math.round(x));
  const d = s.deliverability ?? null;
  const dCheck = s.checks.find((c) => c.key === "deliverability");
  return {
    source: "The email KPI board (Kaizen's email score). Use these numbers for the score and deliverability: they are what the board shows.",
    window: s.window ?? null,
    email_score: s.score,
    band: s.band === "good" ? "green (80 and up)" : s.band === "watch" ? "yellow (60 to 79)" : "red (under 60)",
    deliverability_score: d ? d.score : null,
    deliverability_bar: dCheck?.bar ?? null,
    deliverability_parts: d ? d.parts.map((p) => ({ metric: p.label, rate_pct: Math.round(p.rate * 100000) / 1000, grade: p.grade, points: p.points, of: p.of })) : [],
    deliverability_note: d ? undefined : "No email campaign went out in the board's 30-day window, so there is no deliverability score yet.",
    checks: s.checks.map((c) => ({ check: c.label, unit: c.unit === "pct" ? "%" : c.unit === "money" ? "$ per recipient" : "score", value: val(c.unit, c.value), bar: val(c.unit, c.bar), met: c.value == null ? null : c.met, points: Math.round(c.points * 10) / 10, of: c.weight })),
  };
}
