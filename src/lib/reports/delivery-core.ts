import { headlineTiles, platformName } from "./format";
import type { ReportMetrics } from "./metrics";
import { scrubAgency } from "./white-label";

// How a report reaches the client: Slack, email or both, and who the email goes to. Plain functions (no server code),
// shared by the send step, the history's Resend and the tests: cleaning up the choice, and writing the email itself
// (subject "<Client> weekly report · <period>", two or three lines, the key numbers, the PDF attached).

export type Channel = "slack" | "email";
export type Recipient = { email: string; name?: string | null };
export type Delivery = { channels: Channel[]; recipients: Recipient[] };

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL.test(s.trim());

/** The choice as given, cleaned: known channels only, real addresses only (lowercased, once each, at most 10) */
export function normalizeDelivery(input: unknown, fallback: Delivery = { channels: ["slack"], recipients: [] }): Delivery {
  const d = (input ?? {}) as { channels?: unknown; recipients?: unknown };
  const channels = Array.isArray(d.channels) ? [...new Set(d.channels.filter((c): c is Channel => c === "slack" || c === "email"))] : fallback.channels;
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const r of Array.isArray(d.recipients) ? d.recipients : fallback.recipients) {
    const raw = typeof r === "string" ? { email: r } : (r as Recipient | null);
    const email = String(raw?.email ?? "").trim().toLowerCase();
    if (!isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : null;
    recipients.push({ email, name });
    if (recipients.length >= 10) break;
  }
  return { channels: channels.length ? channels : fallback.channels, recipients };
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

const KIND_WORD: Record<string, string> = { weekly: "weekly report", monthly: "monthly recap", custom: "report", built: "report" };

/** The email's subject: "<Client> weekly report · <period>" */
export const reportSubject = (client: string, kind: string, period: string) => `${client} ${KIND_WORD[kind] ?? "report"} · ${period}`;

/** The two or three lines the email opens with: the report's own summary (or its headline), never more than three sentences */
export function summaryLines(s: { headline?: string | null; summary?: string | null } | null | undefined): string[] {
  const text = (s?.summary ?? "").replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  const lines = sentences.slice(0, 3);
  if (!lines.length && s?.headline?.trim()) lines.push(s.headline.trim());
  return lines;
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
  parts: { platform: "meta" | "google"; metrics: ReportMetrics | null; sections: { headline?: string | null; summary?: string | null } | null }[];
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
  return { ...mail, subject: clean(mail.subject), preheader: clean(mail.preheader), kicker: clean(mail.kicker), title: clean(mail.title), hello: clean(mail.hello), lines: mail.lines.map(clean), bullets: mail.bullets.map(clean), note: clean(mail.note), text: clean(mail.text) };
}

function writeReportEmail(p: ReportEmailInput): ReportEmail {
  const wl = Boolean(p.whiteLabel);
  const joint = p.parts.length > 1;
  const subject = reportSubject(p.client, p.kind, p.periodLabel);
  const lines = joint ? p.parts.flatMap((x) => summaryLines(x.sections).slice(0, 1).map((l) => `${platformName(x.platform)}: ${l}`)) : summaryLines(p.parts[0]?.sections);
  const bullets = p.parts.flatMap((x) => keyNumbers(x.metrics, joint ? platformName(x.platform).replace(" Ads", "") : undefined));
  const firstName = p.from.name.split(" ")[0] || (wl ? "Your account team" : "The Kaizen team");
  const hello = p.first ? `Hi ${p.first},` : "Hi there,";
  const intro = `Here's your ${KIND_WORD[p.kind] ?? "report"} for ${p.periodLabel}. The full report is attached as a PDF.`;
  // White label: signed by the buyer alone, and no link to the agency's portal
  const sign = wl ? firstName : `${firstName}, Kaizen Marketing`;
  const note = [p.note?.trim() || "", "Any questions, just reply to this email.", sign].filter(Boolean).join(" ");
  const cta = p.dashboard && !wl ? { label: "See every number on your dashboard", url: p.dashboard } : null;
  const allLines = [intro, ...lines];
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
    cta,
    note,
    text,
  };
}

/** The PDF's file name, safe for every mail app */
export const pdfFileName = (client: string, what: string, period: string) => `${client} - ${what} - ${period}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
