import { cadenceWord, int, pct, signed, type ChannelKind, type DataFlag, type EmailMetrics, type SocialMetrics } from "./core";

// The email report's message, the way the email team writes it today: a title line, "Hi Team,", one line, then What
// happened (a short paragraph and four set bullets), Highlights, What we learned and Coming up. The parts that are pure
// arithmetic (the title, the four bullets) are made here so they are always right; the checks below catch a draft that
// lost the structure or slipped into internal words. The organic social report's message follows the same structure
// (its own title, four bullets and Highlights on the posts), so both lines read the same in the client's channel.
// Pure, so it is tested.

const monthDay = (d: string, year = false) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

/** "November 9 to November 15" (with the first day's year too when the period crosses one) */
export function periodWords(r: { start: string; end: string }, withYear = false): string {
  const cross = r.start.slice(0, 4) !== r.end.slice(0, 4);
  return `${monthDay(r.start, cross)} to ${monthDay(r.end, withYear || cross)}`;
}

/** "Candy Cloud Weekly Report | November 9 to November 15, 2026" (a social report: "Candy Cloud Weekly Social Media Report | ...") */
export function reportTitle(client: string, kind: ChannelKind, r: { start: string; end: string }, service?: string | null): string {
  return [client.trim(), cadenceWord(kind), service, `Report | ${periodWords(r, true)}`].filter(Boolean).join(" ");
}

/** The title for a report on either line: email keeps the team's own, social names itself */
export const channelTitle = (client: string, kind: ChannelKind, m: { platform: string; main: { start: string; end: string } }) => reportTitle(client, kind, m.main, m.platform === "social" ? "Social Media" : null);

/** The four bullets under What happened on a social report: followers, reach, views and engagement, always in this order */
export function socialHappenedBullets(m: SocialMetrics): string[] {
  return [
    `Followers: ${int(m.now.followers)}${m.now.followerChange != null ? ` (${signed(m.now.followerChange)})` : ""}`,
    `Reach: ${int(m.now.reach)}`,
    `Views: ${int(m.now.views)}`,
    m.insightsRead && m.now.rate != null ? `Engagement rate: ${pct(m.now.rate)}` : `Posts published: ${int(m.now.posts)}`,
  ];
}

/** Money as the team writes it in a message: whole units ("$13,179"), cents only under ten ("$4.50") */
export function wholeMoney(n: number | null | undefined, currency: string | null = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  const small = Math.abs(n) < 10 && Math.round(n) !== n;
  return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: small ? 2 : 0, maximumFractionDigits: small ? 2 : 0 })}`;
}

/** The four bullets under What happened, always in this order */
export function whatHappenedBullets(m: EmailMetrics): string[] {
  const c = m.currency;
  // The engagement report (no revenue to read): who it reached, who engaged, the clicks it sent, and the list
  const e = m.template === "engagement" ? m.engagement : null;
  if (e) {
    const n = (x: number | null) => (x == null ? "n/a" : Math.round(x).toLocaleString("en-US"));
    const list = e.list.net != null ? `List: ${e.list.net > 0 ? "+" : ""}${n(e.list.net)}${e.list.size != null ? ` (${n(e.list.size)} contacts)` : ""}` : e.list.size != null ? `List: ${n(e.list.size)} contacts, ${n(e.list.unsubscribes)} unsubscribed` : `Unsubscribed: ${n(e.list.unsubscribes)}`;
    return [`People reached: ${n(e.reached.now)}`, `Opens: ${n(e.opens.now)}, ${n(e.clickers.now)} people clicked`, `Clicks to your website: ${n(e.clicks.now)}`, list];
  }
  const orders = m.detail?.orders.now;
  return [
    `Revenue from email and SMS: ${wholeMoney(m.now.revenue, c)}`,
    ...(orders != null ? [`Orders: ${orders.toLocaleString("en-US")}`] : []),
    `From automated emails: ${wholeMoney(m.now.flowRevenue, c)}`,
    `From campaigns: ${wholeMoney(m.now.campaignRevenue, c)}`,
  ];
}

export const MESSAGE_HEADERS = ["What happened", "Highlights", "What we learned", "Coming up"] as const;

/** The title is always the first line (after the @here the app adds): whatever the draft opened with is replaced */
export function withTitle(message: string, title: string): string {
  const lines = message.replace(/\r\n/g, "\n").trim().split("\n");
  // A first line that is already a title (names the report or the period) gives way to the right one
  const first = (lines[0] ?? "").replace(/<!here>|@here/g, "").replace(/\*/g, "").trim();
  if (/\breport\b/i.test(first) && first.includes("|")) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  return [title, "", ...lines].join("\n");
}

/** Words that are the team's, not the client's */
const INTERNAL = [
  { re: /\bflows?\b/i, say: "automated emails" },
  { re: /\bRPR\b|\brevenue per recipient\b/i, say: "revenue for each email sent" },
  { re: /\bCTR\b|\bCVR\b|\bAOV\b/, say: "the words in full (click rate, order rate, average order)" },
];

/** Plain checks on an email or social report's message: the team's structure, the title, client words, no em dashes */
export function emailMessageFlags(message: string | null | undefined, m: EmailMetrics | SocialMetrics, client: string, kind: ChannelKind): DataFlag[] {
  const out: DataFlag[] = [];
  const text = String(message ?? "");
  if (!text.trim()) return out;
  const add = (severity: DataFlag["severity"], issue: string, suggestion: string, where = "Message") => out.push({ severity, issue, where, suggestion });
  const title = channelTitle(client, kind, m);
  if (!text.includes(title)) add("fix", "The message doesn't open with the report's title line.", `Start with: ${title}`);
  if (!/\bHi Team,/.test(text)) add("check", 'The greeting "Hi Team," is missing.', 'Put "Hi Team," on the line after the title.');
  let at = -1;
  for (const h of MESSAGE_HEADERS) {
    const i = text.search(new RegExp(`\\*${h}\\*`, "i"));
    if (i < 0) add("fix", `The "${h}" section is missing.`, `Add *${h}* in the team's order: ${MESSAGE_HEADERS.join(", ")}.`);
    else if (i < at) add("check", `"${h}" is out of order.`, `Keep the order: ${MESSAGE_HEADERS.join(", ")}.`);
    else at = i;
  }
  for (const w of m.platform === "klaviyo" ? INTERNAL : []) {
    const hit = w.re.exec(text);
    if (hit) add("fix", `"${hit[0]}" is the team's word, not the client's.`, `Say ${w.say}.`, `"…${text.slice(Math.max(0, hit.index - 20), hit.index + 20).replace(/\s+/g, " ")}…"`);
  }
  if (text.includes("—")) add("fix", "An em dash is in the message.", "Use a comma, a colon or a new sentence.");
  return out;
}
