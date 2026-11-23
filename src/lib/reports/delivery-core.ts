import { headlineTiles, platformName } from "./format";
import type { ReportMetrics } from "./metrics";
import { scrubAgency } from "./white-label";

// How a report reaches the client: Slack, email or both, and who the email goes to. Plain functions (no server code),
// shared by the send step, the history's Resend and the tests: cleaning up the choice, and writing the email itself
// (subject "<Client> weekly report · <period>", two or three lines, the key numbers, the PDF attached).

export type Channel = "slack" | "email";
export type Recipient = { email: string; name?: string | null };
/**
 * Where the Slack post goes, when not the client's own channel as a new message: another channel, and/or a reply in a
 * thread (a client who asked for every weekly report in one standing thread), optionally also shown in the channel.
 */
export type SlackTarget = { channel?: string | null; channelName?: string | null; thread?: string | null; threadLabel?: string | null; broadcast?: boolean };

/** recipients: the email's To. cc: people the sender copies (the team the send copies by itself is added on top). slack: where the post goes */
export type Delivery = { channels: Channel[]; recipients: Recipient[]; cc?: Recipient[]; slack?: SlackTarget };

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL.test(s.trim());

/** The choice as given, cleaned: known channels only, real addresses only (lowercased, once each, at most 50) */
export function normalizeDelivery(input: unknown, fallback: Delivery = { channels: ["slack"], recipients: [] }): Delivery {
  const d = (input ?? {}) as { channels?: unknown; recipients?: unknown };
  const channels = Array.isArray(d.channels) ? [...new Set(d.channels.filter((c): c is Channel => c === "slack" || c === "email"))] : fallback.channels;
  const seen = new Set<string>();
  const read = (list: unknown, max: number) => {
    const out: Recipient[] = [];
    for (const r of Array.isArray(list) ? list : []) {
      const raw = typeof r === "string" ? { email: r } : (r as Recipient | null);
      const email = String(raw?.email ?? "").trim().toLowerCase();
      if (!isEmail(email) || seen.has(email)) continue;
      seen.add(email);
      const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : null;
      out.push({ email, name });
      if (out.length >= max) break;
    }
    return out;
  };
  // To first: someone in both stays in To
  const recipients = read(Array.isArray(d.recipients) ? d.recipients : fallback.recipients, 50);
  const cc = read((d as { cc?: unknown }).cc ?? fallback.cc, 20);
  const slack = slackTargetOf((d as { slack?: unknown }).slack ?? fallback.slack);
  return { channels: channels.length ? channels : fallback.channels, recipients, ...(cc.length ? { cc } : {}), ...(slack ? { slack } : {}) };
}

/** What's missing before it can go: an empty answer means it's ready */
export function deliveryProblem(d: Delivery, can: { slackChannel: boolean; slackConnected: boolean; emailReady: boolean }): string | null {
  if (!d.channels.length) return "Pick Slack, email or both.";
  if (d.channels.includes("slack") && !can.slackChannel) return "This client has no Slack channel linked. Add it on the client page, or send by email.";
  if (d.channels.includes("email") && !d.recipients.length) return "Add at least one email address to send it to.";
  if (d.channels.includes("email") && !can.emailReady) return "Email isn't set up yet (RESEND_API_KEY missing).";
  return null;
}

export const channelsLabel = (cs: Channel[]) => (cs.includes("slack") && cs.includes("email") ? "Slack and email" : cs.includes("email") ? "Email" : cs.includes("slack") ? "Slack" : "Nowhere");

/** The same, as it reads in a sentence: "in Slack", "by email", "in Slack and by email" */
export const channelsPhrase = (cs: Channel[]) => (cs.includes("slack") && cs.includes("email") ? "in Slack and by email" : cs.includes("email") ? "by email" : "in Slack");

const KIND_WORD: Record<string, string> = { weekly: "weekly report", monthly: "monthly recap", custom: "report", built: "report" };

/** The email's subject: "<Client> weekly report · <period>" */
export const reportSubject = (client: string, kind: string, period: string) => `${client} ${KIND_WORD[kind] ?? "report"} · ${period}`;

// Words that end in a period without ending the sentence ("vs. last week", "e.g. a lead form", "approx. $40")
const ABBREVIATION = /^(?:vs|e\.g|i\.e|approx|avg|mr|mrs|ms|dr|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;

/**
 * A text split into its sentences. A sentence ends at ".", "!" or "?" followed by a space and the next sentence (or by the
 * end of the text), never at a period inside a number or a name: "$4,583.98", "1.81 to 1.38", "$30.56", "v2.1", "3.5x" stay
 * whole, and so does "vs. last week". (The period inside a number is never followed by a space; matching it as an ending
 * is what broke a summary into "…$4,583", "56 the week before." and "16." as separate paragraphs.)
 */
export function sentencesOf(input: string | null | undefined): string[] {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+["')\]]*(?=\s+\S|\s*$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    const chunk = text.slice(start, end);
    const last = chunk.split(" ").at(-1) ?? "";
    // "vs." and its kind, or a lowercase word starting the next sentence, are not the end of one
    if (ABBREVIATION.test(last) || /^\s+[a-z]/.test(text.slice(end, end + 2))) continue;
    out.push(chunk.trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** The two or three lines the email opens with: the report's own summary (or its headline), never more than three sentences */
export function summaryLines(s: { headline?: string | null; summary?: string | null } | null | undefined): string[] {
  const lines = sentencesOf(s?.summary).slice(0, 3);
  if (!lines.length && s?.headline?.trim()) lines.push(s.headline.trim());
  return lines;
}

/** "What we did: …" and "What's next: …", three points each at most, for the message that carries a weekly */
export function narrativeLines(s: { did?: string[] | null; next?: string[] | null } | null | undefined, service: string | null = null): string[] {
  const join = (xs: string[]) => xs.map((x) => x.trim().replace(/[.;]+$/, "")).filter(Boolean).slice(0, 3).join("; ");
  const pre = service ? `${service}, ` : "";
  return [
    ...(s?.did?.length && join(s.did) ? [`${pre}${service ? "what we did" : "What we did"}: ${join(s.did)}.`] : []),
    ...(s?.next?.length && join(s.next) ? [`${pre}${service ? "what's next" : "What's next"}: ${join(s.next)}.`] : []),
  ];
}

/** The key numbers for the email: spend, results (and their cost), and ROAS or cost per result, each against before */
export function keyNumbers(m: ReportMetrics | null | undefined, service?: string): string[] {
  if (!m) return [];
  const tiles = headlineTiles(m).filter((t) => t.label !== "Click-through rate");
  const pre = service ? `${service} · ` : "";
  return tiles.map((t) => `${pre}${t.label}: ${t.value}${t.sub ? ` (${t.sub})` : ""}${t.delta ? `, ${t.delta.text} vs ${m.compare.label}` : ""}`);
}

export type ReportEmailInput = {
  client: string;
  kind: string;
  periodLabel: string;
  /** One part per service (a joint report has two) */
  parts: { platform: "meta" | "google" | "tiktok" | "klaviyo" | "social"; metrics: ReportMetrics | null; sections: { headline?: string | null; summary?: string | null; did?: string[] | null; next?: string[] | null } | null }[];
  /** The buyer sending it: the email is signed by them and replies go to them */
  from: { name: string; email: string | null };
  /** First name of the person it's addressed to, when it goes to one */
  first?: string | null;
  /** The client's live dashboard (their portal), when it's open to them */
  dashboard?: string | null;
  /** A note the buyer added for this send */
  note?: string | null;
  /** A white label client: no agency name, sign-off or link anywhere in it */
  whiteLabel?: boolean;
  /** A channel report (email or social): the service it is for, and its own key numbers in place of the ad tiles */
  serviceLabel?: string | null;
  keyLines?: string[] | null;
  /**
   * The report's message (the one the Slack post carries): when there is one it IS the email's body, turned from Slack's
   * formatting into the email's, so every change to it (the AI's, a hand edit, a refresh) is in the email too and the two
   * can never say different things.
   */
  message?: string | null;
};

export type ReportEmail = {
  subject: string;
  replyTo: string | null;
  preheader: string;
  kicker: string;
  title: string;
  highlight: string;
  hello: string;
  lines: string[];
  bullets: string[];
  /** The message's own headings, paragraphs and bullets, in order (empty when the email is drawn from the sections) */
  blocks: EmailBlock[];
  cta: { label: string; url: string } | null;
  note: string;
  text: string;
  whiteLabel: boolean;
};

/** The email for a report: short, branded, the numbers that matter, the PDF attached (the dashboard linked when there is one) */
export function buildReportEmail(p: ReportEmailInput): ReportEmail {
  const mail = writeReportEmail(p);
  if (!p.whiteLabel) return mail;
  // The backstop: whatever the buyer or the report said, a white label client's email never names the agency
  const clean = (t: string) => scrubAgency(t);
  const blocks = mail.blocks.map((b): EmailBlock => (b.kind === "list" ? { kind: "list", items: b.items.map(clean) } : { ...b, text: clean(b.text) }));
  return { ...mail, subject: clean(mail.subject), preheader: clean(mail.preheader), kicker: clean(mail.kicker), title: clean(mail.title), hello: clean(mail.hello), lines: mail.lines.map(clean), bullets: mail.bullets.map(clean), blocks, note: clean(mail.note), text: clean(mail.text) };
}

function writeReportEmail(p: ReportEmailInput): ReportEmail {
  const wl = Boolean(p.whiteLabel);
  const joint = p.parts.length > 1;
  const subject = p.serviceLabel ? `${p.client} ${p.serviceLabel} ${KIND_WORD[p.kind] ?? "report"} · ${p.periodLabel}` : reportSubject(p.client, p.kind, p.periodLabel);
  const fromMessage = messageBlocks(p.message);
  if (fromMessage.length) return messageEmail(p, subject, fromMessage);
  const lines = joint ? p.parts.flatMap((x) => summaryLines(x.sections).slice(0, 1).map((l) => `${platformName(x.platform)}: ${l}`)) : summaryLines(p.parts[0]?.sections);
  const bullets = p.keyLines ?? p.parts.flatMap((x) => keyNumbers(x.metrics, joint ? platformName(x.platform).replace(" Ads", "") : undefined));
  const firstName = p.from.name.split(" ")[0] || (wl ? "Your account team" : "The Kaizen team");
  const hello = p.first ? `Hi ${p.first},` : "Hi team,";
  const intro = `Here's your ${p.serviceLabel ? `${p.serviceLabel.toLowerCase()} ` : ""}${KIND_WORD[p.kind] ?? "report"} for ${p.periodLabel}. The full report is attached as a PDF.`;
  // White label: signed by the buyer alone, and no link to the agency's portal
  const sign = wl ? firstName : `${firstName}, Kaizen Marketing`;
  const note = [p.note?.trim() || "", "Any questions, just reply to this email.", sign].filter(Boolean).join(" ");
  const cta = p.dashboard && !wl ? { label: "See every number on your dashboard", url: p.dashboard } : null;
  // A weekly's narrative travels here, not in the PDF (which holds the numbers): what we did and what's next, briefly
  const story = p.kind === "weekly" || p.kind === "custom" || p.serviceLabel ? p.parts.flatMap((x) => narrativeLines(x.sections, joint ? platformName(x.platform).replace(" Ads", "") : null)) : [];
  const allLines = [intro, ...lines, ...story];
  const text = [hello, "", ...allLines.flatMap((l) => [l, ""]), ...(bullets.length ? ["The key numbers:", ...bullets.map((b) => `• ${b}`), ""] : []), ...(cta ? [`${cta.label}: ${cta.url}`, ""] : []), ...(p.note?.trim() ? [p.note.trim(), ""] : []), "Any questions, just reply to this email.", "", firstName, ...(wl ? [] : ["Kaizen Marketing"])].join("\n");
  return {
    whiteLabel: wl,
    subject,
    replyTo: p.from.email && isEmail(p.from.email) ? p.from.email : null,
    preheader: lines[0] ?? `${p.client} · ${p.periodLabel}`,
    kicker: p.client,
    title: `Your ${KIND_WORD[p.kind] ?? "report"}: ${p.periodLabel}`,
    highlight: p.periodLabel,
    hello,
    lines: allLines,
    bullets,
    blocks: [],
    cta,
    note,
    text,
  };
}

/** The PDF's file name, safe for every mail app */
export const pdfFileName = (client: string, what: string, period: string) => `${client} - ${what} - ${period}.pdf`.replace(/[\\/:*?"<>|]/g, "-");

// ─── The message as the email's body ────────────────────────────────────────────────────────────────────────────────

/** A part of the email's body: a heading ("*What happened*"), a paragraph, or a list of bullets */
export type EmailBlock = { kind: "heading"; text: string } | { kind: "para"; text: string } | { kind: "list"; items: string[] };

const GREETING = /^(?:hi|hey|hello|good (?:morning|afternoon|evening)|dear)\b[^.!?\n]{0,60}[,!:]?$/i;
const SIGN_OFF = /^(?:best|thanks|thank you|many thanks|cheers|talk soon|speak soon|regards|warmly)\b[^.\n]{0,40}[,!.]?$/i;
const BULLET = /^\s*(?:[•◦▪‣·–-]|\*(?=\s)|\d{1,2}[.)])\s+(.+)$/;
const HEADING = /^\*([^*\n]{1,140})\*:?$/;

/** Slack's own markup out (mentions, @here, channel links, emoji codes, <url|label> links), its *bold* and _italic_ kept */
export function slackToPlain(t: string): string {
  return t
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/g, "")
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name: string | undefined) => (name ? `@${name}` : ""))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label.trim() === url.trim() ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/(^|\s):[a-z0-9_+-]{2,40}:(?=\s|$)/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

/** The *bold* and _italic_ markers taken off, for the plain-text email and the inbox preview */
export const unmark = (t: string) => t.replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1$2");

/**
 * The Slack message turned into the email's body: its headings, paragraphs and bullets in the order written, every one
 * of them (nothing is cut to fit). What only belongs in Slack goes: @here, the title line the post opens with (the email
 * has its own title), and the greeting and sign-off (the email has its own, addressed to whoever it goes to).
 */
export function messageBlocks(message: string | null | undefined): EmailBlock[] {
  let lines = slackToPlain(String(message ?? "")).split(/\r?\n/).map((l) => l.trim());
  const firstReal = () => lines.findIndex((l) => l !== "");
  // The post's title line ("Atomic Wings Weekly Report | November 16 to 22"): short, no sentence, names the report
  let i = firstReal();
  if (i >= 0 && lines[i].length <= 140 && !/[.!?]$/.test(lines[i]) && (/\s[|·]\s/.test(lines[i]) || /\b(?:report|recap|update|wrap[- ]?up)\b/i.test(lines[i])) && !GREETING.test(lines[i])) lines = lines.slice(i + 1);
  // The greeting, when it's one of the first lines
  i = firstReal();
  if (i >= 0 && GREETING.test(unmark(lines[i]))) lines = lines.slice(i + 1);
  // The sign-off and the name under it
  const real = lines.map((l, k) => (l ? k : -1)).filter((k) => k >= 0);
  const tail = real.slice(-2);
  const off = tail.find((k) => SIGN_OFF.test(unmark(lines[k])));
  if (off != null && real.at(-1)! - off <= 1 && lines[off].length <= 40) lines = lines.slice(0, off);

  const out: EmailBlock[] = [];
  for (const line of lines) {
    if (!line) continue;
    const b = BULLET.exec(line);
    const h = HEADING.exec(line);
    const last = out.at(-1);
    if (b) {
      if (last?.kind === "list") last.items.push(b[1].trim());
      else out.push({ kind: "list", items: [b[1].trim()] });
    } else if (h) out.push({ kind: "heading", text: h[1].trim().replace(/:$/, "") });
    else out.push({ kind: "para", text: line });
  }
  return out;
}

/** The body as plain text: headings on their own line, bullets as "• " */
export function blocksText(blocks: EmailBlock[]): string[] {
  return blocks.flatMap((b) => (b.kind === "list" ? [...b.items.map((x) => `• ${unmark(x)}`), ""] : [unmark(b.text), ""]));
}

function messageEmail(p: ReportEmailInput, subject: string, body: EmailBlock[]): ReportEmail {
  const wl = Boolean(p.whiteLabel);
  const firstName = p.from.name.split(" ")[0] || (wl ? "Your account team" : "The Kaizen team");
  const hello = p.first ? `Hi ${p.first},` : "Hi team,";
  const sign = wl ? firstName : `${firstName}, Kaizen Marketing`;
  const note = [p.note?.trim() || "", "Any questions, just reply to this email.", sign].filter(Boolean).join(" ");
  const cta = p.dashboard && !wl ? { label: "See every number on your dashboard", url: p.dashboard } : null;
  const blocks: EmailBlock[] = [...body, { kind: "para", text: "The full report is attached as a PDF." }];
  const firstPara = body.find((b) => b.kind === "para") as { text: string } | undefined;
  const text = [hello, "", ...blocksText(blocks), ...(cta ? [`${cta.label}: ${cta.url}`, ""] : []), ...(p.note?.trim() ? [p.note.trim(), ""] : []), "Any questions, just reply to this email.", "", firstName, ...(wl ? [] : ["Kaizen Marketing"])].join("\n");
  return {
    whiteLabel: wl,
    subject,
    replyTo: p.from.email && isEmail(p.from.email) ? p.from.email : null,
    preheader: firstPara ? unmark(firstPara.text).slice(0, 180) : `${p.client} · ${p.periodLabel}`,
    kicker: p.client,
    title: `Your ${KIND_WORD[p.kind] ?? "report"}: ${p.periodLabel}`,
    highlight: p.periodLabel,
    hello,
    lines: [],
    bullets: [],
    blocks,
    cta,
    note,
    text,
  };
}

// ─── Who it went to before ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The people this client's report emails went to before (To and Cc of past sends), most often first, that aren't on
 * this one yet and aren't the team: offered as one-tap adds ("Eddie usually sees the report"). At most six.
 */
export function pastRecipients(sends: { to?: unknown; cc?: unknown }[], now: Delivery, team: Set<string>): Recipient[] {
  const on = new Set([...now.recipients, ...(now.cc ?? [])].map((r) => r.email));
  const count = new Map<string, number>();
  for (const s of sends)
    for (const e of [...(Array.isArray(s.to) ? s.to : []), ...(Array.isArray(s.cc) ? s.cc : [])]) {
      const email = String(typeof e === "string" ? e : ((e as { email?: unknown } | null)?.email ?? "")).trim().toLowerCase();
      if (!isEmail(email) || on.has(email) || team.has(email)) continue;
      count.set(email, (count.get(email) ?? 0) + 1);
    }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([email]) => ({ email, name: null }));
}

/** The delivery remembered for one service line (ads, email, social), else the client's own; null when neither */
export function lineDelivery(byLine: unknown, line: string | null | undefined): Delivery | null {
  const m = byLine && typeof byLine === "object" ? (byLine as Record<string, unknown>) : {};
  const hit = line ? m[line] : null;
  return hit && typeof hit === "object" ? normalizeDelivery(hit) : null;
}

// ─── Where in Slack ─────────────────────────────────────────────────────────────────────────────────────────────────

const CHANNEL_ID = /^[CG][A-Z0-9]{6,20}$/;
const TS = /^\d{9,11}\.\d{6}$/;

/** A Slack target as given, cleaned: a real channel id and message ts only; null when it says nothing */
export function slackTargetOf(input: unknown): SlackTarget | null {
  const t = (input ?? {}) as Record<string, unknown>;
  const channel = typeof t.channel === "string" && CHANNEL_ID.test(t.channel.trim()) ? t.channel.trim() : null;
  const thread = typeof t.thread === "string" && TS.test(t.thread.trim()) ? t.thread.trim() : null;
  if (!channel && !thread) return null;
  const text = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : null);
  return { channel, channelName: text(t.channelName, 80), thread, threadLabel: thread ? text(t.threadLabel, 120) : null, broadcast: Boolean(thread && t.broadcast) };
}

/**
 * A Slack message link, read: its channel and the thread it belongs to. "…/archives/C07JZ87E1N2/p1795460770177329" is
 * the message 1795460770.177329; a reply's link carries its thread as ?thread_ts=…, and that thread is the one to post in.
 */
export function parseSlackLink(url: string): { channel: string; thread: string } | null {
  const m = /\/archives\/([CG][A-Z0-9]{6,20})\/p(\d{10})(\d{6})/.exec(String(url ?? "").trim());
  if (!m) return null;
  const replyOf = /[?&]thread_ts=(\d{9,11}\.\d{6})/.exec(url)?.[1] ?? null;
  return { channel: m[1], thread: replyOf ?? `${m[2]}.${m[3]}` };
}

/** "Posting in #aldecoa › thread: Weekly email reports…", as the send step and the note after it say it */
export function slackWhere(t: SlackTarget | null | undefined, fallbackName: string | null): string {
  const name = t?.channelName ?? fallbackName;
  const ch = name ? `#${name.replace(/^#/, "")}` : "the client's channel";
  if (!t?.thread) return `Posting in ${ch}`;
  return `Posting in ${ch} › thread${t.threadLabel ? `: ${t.threadLabel}` : ""}${t.broadcast ? " (also sent to the channel)" : ""}`;
}
