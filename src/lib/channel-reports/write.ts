import "server-only";
import { chatThumbs } from "@/lib/chat-thumbs";
import { OUTPUTS_RULE, outputsCheck } from "@/lib/reports/outputs-core";
import { dedupeSections, lastSentBlock, ONCE_RULE } from "@/lib/reports/style-core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, askJsonWithTools, clientContext, contextBlock } from "@/lib/ai";
import type { ChatTurn, Qa, QaFlag, Sections } from "@/lib/reports/write";
import { reportBasis } from "@/lib/reports/format";
import { forClient, isWhiteLabel, scrubSections, WHITE_LABEL_RULE } from "@/lib/reports/white-label";
import { openWithHere, withoutMentions } from "@/lib/reports/slack-text";
import { previousPeriod, rangeLabel, todayIn } from "@/lib/reports/period";
import { voiceOf } from "@/lib/reports/work";
import { channelName, dataFlags, lineOfPlatform, platformOfLine, type ChannelKind, type ChannelLine, type ChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
import { loadChannelMetrics } from "./data";
import { channelMetricsText } from "./text";
import { channelTitle, emailMessageFlags, withTitle } from "./email-message";
import { applyStated, type Stated } from "./stated";
import { channelReportTools, channelToolsLine } from "./tools";
import { cardShotIds } from "./email-cards";
import { ENGAGEMENT_DRAFT_SCHEMA, ENGAGEMENT_REVISE_SCHEMA, ENGAGEMENT_RULES, ENGAGEMENT_TAKEAWAY_RULES, engagementTemplate } from "./engagement-write";
import { SOCIAL_DRAFT_SCHEMA, SOCIAL_REVISE_SCHEMA, SOCIAL_TAKEAWAY_RULES } from "./social-write";
import { carryTeamFindings, teamFindingsPrompt, withTeamFindings } from "./social-notes";

// Writing a channel client report (email or organic social): the numbers (data.ts), the work behind them, the owner's own
// voice, what this client likes in a report, and the client's Brand Bible and context. The same arc as the ads reports:
// what we did, what we're doing now and why, what comes next. Every draft and every revision is checked by the QA before
// the owner sees it. Written in roles, never names: the report is the email strategist's or the social media manager's.

type Metrics = EmailMetrics | SocialMetrics;

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SECTIONS = obj({ headline: S, summary: S, did: LIST, doing: LIST, next: LIST, highlights: LIST, takeaways: { type: "array", items: obj({ title: S, text: S }) } });
const DRAFT_SCHEMA = obj({ message: S, sections: SECTIONS });
const QA_SCHEMA = obj({ verdict: { type: "string", enum: ["clean", "check", "fix"] }, flags: { type: "array", items: obj({ severity: { type: "string", enum: ["fix", "check", "alert"] }, issue: S, where: S, suggestion: S }) } });

/** No em dashes in anything the client reads: the model is told, and this is the backstop */
export const noEmDashes = (t: string) => t.replace(/\s*—\s*/g, ", ").replace(/,\s*,/g, ",");
function plain(sections: Sections): Sections {
  const f = (t: string) => noEmDashes(t);
  return { ...sections, headline: f(sections.headline), summary: f(sections.summary), did: sections.did.map(f), doing: sections.doing.map(f), next: sections.next.map(f), highlights: sections.highlights.map(f), takeaways: sections.takeaways?.map((t) => ({ title: f(t.title), text: f(t.text), ...(t.next?.trim() ? { next: f(t.next) } : {}) })), stories: [] };
}

const ROLE: Record<ChannelLine, string> = { email: "email strategist", social: "social media manager" };

const TAKEAWAY_RULES = `takeaways: exactly three cards for the PDF, read from the numbers alone (the work and the plan stay in the message). Each: title (a bold claim of 3 to 7 words) and text (one or two sentences with the real numbers and what they are compared to). Plain and specific: no hype, no exclamation marks, no adjectives the numbers don't earn, no advice. Percent changes to one decimal.`;

/** What the writer is told, by line: the owner's role, what leads the report, what each number means */
function lineRules(platform: ChannelPlatform): string {
  if (platform === "klaviyo")
    return `Revenue is what Klaviyo attributes to email and SMS: never call it the store's total revenue and never claim email caused sales it doesn't show. In anything the client reads, say "automated emails" (never "flows"), "people who received it" (never "recipients" in prose), and plain words for every rate ("60% of people opened it", "about 1.4% of the people who received it placed an order"); no jargon (RPR, CTR, CVR, AOV, deliverability score weights). Every campaign and automated email has its own numbers for the period in <numbers>: use those. If a deliverability flag is red, say it plainly and what we're doing about it. When <numbers> has a location breakdown (a multi-location client), Highlights may end with one bullet naming the top and the bottom location by revenue with their exact figures from the ranked list; never invent a location or rank one that isn't listed. When <numbers> lists revenue sources (two order systems, such as Toast and a custom POS), say what each one earned and the combined total exactly as given (What happened's paragraph or a Highlights bullet), never add them yourself and never call one of them the whole. When <numbers> gives email against SMS and texts earned a real part of the revenue (about a tenth or more) or moved a lot against the period before, say what SMS brought in and from how many texts. When a campaign in <numbers> lists who it was sent to and who it was excluded, you may say which segments or lists it went to (by name); say why only when the numbers or the work log show the reason (a segment that out-earned the rest, an exclusion that protected a recent buyer), never invent one. Revenue per recipient is "revenue for each email sent" in the client's words; mention it when it moved clearly against the period before or a campaign stood out on it.`;
  return `Lead with follower growth and reach for the period against the period before, then views, the engagement rate (interactions over reach; if <numbers> says it isn't available, don't quote one) against the target when <numbers> gives one, how much we published, and the posts that did best and why they likely worked (format, topic, hook, from what the numbers and captions show). Never claim a post caused follower growth unless the numbers show it. Instagram and Facebook are counted from Meta's own account insights; say which platform a number is from when it matters. When <numbers> has a By location list (a client with a Page and Instagram per location), every other number is the whole company: lead with those, and end Highlights with one bullet per location (its name, followers, reach, engagement and posts, exactly as listed); never rank or compare locations beyond the figures given.`;
}

/** The report's cadence in the writer's words: a report on dates picked by hand is a report on those dates */
const KIND_WORD = (kind: ChannelKind) => (kind === "custom" ? "custom-dates" : kind);
/** How the message's opening line leads into the dates */
const PERIOD_LEAD = (kind: ChannelKind) => (kind === "monthly" ? "for the month of" : kind === "weekly" ? "for the week of" : "from");

const EMAIL_MESSAGE = (kind: ChannelKind) => `message: the email team's ${KIND_WORD(kind)} report message, plain text with Slack formatting (*bold* headers, "• " bullets), in exactly this structure and order, nothing before or after:
1. The title line (the app sets it exactly; write it as given in <report_title>).
2. A blank line, then "Hi Team," on its own line.
3. One line: "Here's how email and SMS performed ${PERIOD_LEAD(kind)} <period words>." (email only when no SMS was sent).
4. *What happened*: a short paragraph (2 or 3 sentences: which campaigns went out and when, by name and date, and where most of the revenue came from, in plain words like "about four of every five dollars"), then exactly the four bullets given in <numbers> under "What happened bullets", word for word.
5. *Highlights*: one bullet per campaign sent in the period (name: revenue from orders, with X% of people opening it, and a plain comparison such as which was stronger and the order rate against the other), then the top two to four automated emails the same way (revenue, orders, order rate). Numbers rounded the way the team rounds: whole dollars, whole percent for opens, one decimal for order rates.
6. *What we learned*: one short paragraph with a single insight grounded in the numbers (a comparison the numbers show and what it means for the calendar). Never advice the numbers don't support.
7. *Coming up*: one bullet per dated item, "Month D: what", only from the Coming up list in <numbers>, the work log or what was said; leave ideas out unless confirmed there. If nothing is dated, one bullet with what the work log says is next; never invent a date or a campaign.
No sign-off, no emojis, no em dashes, no internal words (flows, Klaviyo report names, scores, AI, Kaizen OS, team names).`;

/** The organic social message: the email team's structure, so both lines read the same in the client's channel */
const SOCIAL_MESSAGE = (kind: ChannelKind) => `message: the social team's ${KIND_WORD(kind)} report message, plain text with Slack formatting (*bold* headers, "• " bullets), in exactly this structure and order, nothing before or after:
1. The title line (the app sets it exactly; write it as given in <report_title>).
2. A blank line, then "Hi Team," on its own line.
3. One line: "Here's how organic social performed ${PERIOD_LEAD(kind)} <period words>." (name Instagram and Facebook only if both were posted to).
4. *What happened*: a short paragraph (2 or 3 sentences: how much we published and in which formats, and where most of the reach and engagement came from, in plain words), then exactly the four bullets given in <numbers> under "What happened bullets", word for word.
5. *Highlights*: one bullet per top post of the period (platform and format, a few words of what it was, its interactions and reach, and a plain comparison with the others), then one bullet on follower growth against the period before.
6. *What we learned*: one short paragraph with a single insight grounded in the numbers (which format, topic or hook worked and what it means for the calendar). Never advice the numbers don't support.
7. *Coming up*: one bullet per planned item from the work log or what was said ("Month D: what" when it's dated); never invent a date, a post or a campaign.
No sign-off, no emojis, no em dashes, no internal words (AI, Kaizen OS, team names, insights jargon).`;

/** The writer's rules name the platform: for Brevo and Customer.io clients that name replaces Klaviyo, and a source with no revenue is told so */
function forSource(text: string, m: unknown): string {
  const x = (m ?? null) as { source?: string; revenueMeasured?: boolean } | null;
  const name = x?.source;
  const named = name && name !== "Klaviyo" ? text.split("Klaviyo").join(name) : text;
  // The engagement report (no readable revenue): its own rules, and takeaways that carry what we'll do next
  if (engagementTemplate(m)) return `${named.replace(TAKEAWAY_RULES, ENGAGEMENT_TAKEAWAY_RULES)}\n${ENGAGEMENT_RULES}\nWhere the message structure above mentions revenue, orders or order rates, use reach, clicks and what people clicked instead.`;
  return x?.revenueMeasured === false ? `${named}
This client's ${name ?? "email"} reports no revenue: never write revenue, orders, order rates or revenue targets; build the report on sends, opens, clicks, list growth and what we did.` : named;
}

function writerSystem(kind: ChannelKind, platform: ChannelPlatform, whiteLabel = false): string {
  const line = lineOfPlatform(platform);
  const base = `You draft a ${KIND_WORD(kind)} ${channelName(platform).toLowerCase()} report for a client of Kaizen Marketing, a marketing agency, as the ${ROLE[line]} who runs this channel for the client. The ${ROLE[line]} reads it, may edit it, and sends it as themselves, so it must sound exactly like them: match the voice, warmth, length, formatting and habits in their examples (greeting, how they introduce numbers, headers, bullets, sign-off). If there are no examples, write warm, plain and confident. This is not a paid ads report: ignore any guidance meant for ad accounts, budgets, ROAS or cost per result.
Every report follows the same arc: what we did, what we're doing now and why, and what comes next. Its job is to show the client the work behind the numbers, not just the numbers.
A weekly's <numbers> also gives its month to date against the same days last month: the PDF draws it, so don't restate it. Mention it in one or two sentences inside the What happened paragraph only when the pace is ahead of or behind the monthly target by a meaningful margin (<numbers> says so), or when the month is clearly up or down on the same days last month; early in the month say it is early; never invent a target, and with no target say nothing about pacing.
Accuracy above everything: every number you write must come from the numbers given, rounded the way the ${ROLE[line]} rounds; never estimate, never invent a figure, a campaign, a post, a change or a plan. Comparisons say against what ("vs September", "vs the week before"). If results are down, say it plainly and say what we're doing about it; never spin. Only mention work that is in the work log or what the ${ROLE[line]} added (group many small edits into what they amount to). Never mention internal things: team members other than the client's own people, Kaizen OS, AI, audits by name, internal Slack, other clients. Never use em dashes; use a comma, a colon or a new sentence.
${lineRules(platform)}
${platform === "klaviyo" ? `${EMAIL_MESSAGE(kind)}
sections: the same content, structured, for the report page (the PDF draws the numbers itself): headline (one line, the main takeaway), summary (the What happened paragraph), did (what we did, 2 to 6 bullets from the work log), doing (2 to 4), next (the Coming up items), highlights (the Highlights bullets).
${TAKEAWAY_RULES}` : `${SOCIAL_MESSAGE(kind)}
sections: the same content, structured, for the PDF and the report page: headline (one line, the main takeaway), summary (the What happened paragraph), did (what we did, 3 to 7 bullets from the work log), doing (what we're doing now and why, 2 to 5), next (the Coming up items), highlights (the Highlights bullets).
${SOCIAL_TAKEAWAY_RULES}`}`;
  return whiteLabel ? `${base}\n${ONCE_RULE}\n${WHITE_LABEL_RULE}` : `${base}\n${ONCE_RULE}`;
}

const QA_SYSTEM = (platform: ChannelPlatform) => `You are the QA for client reports at Kaizen Marketing, a marketing agency. Before the ${ROLE[lineOfPlatform(platform)]} sees a draft of this ${channelName(platform).toLowerCase()} report, you check it as if the client's trust depended on it. Compare the draft (message and sections) with the source data, the work log and what the ${ROLE[lineOfPlatform(platform)]} added.
Flag:
- fix: a number that doesn't match the data or the math (percent changes, rates), a wrong period or comparison,${platform === "klaviyo" ? " a Coming up item (date or campaign) that isn't in the Coming up list, the work log or what was said, an idea listed as if it were confirmed," : ""} a campaign, post, change or plan that isn't in the sources, revenue described as the store's total instead of attributed email revenue (email), an engagement rate quoted when the data says it isn't available (social), a client-facing mention of something internal (team names other than the client's, AI, Kaizen OS, other clients), an em dash.
- check: something the ${ROLE[lineOfPlatform(platform)]} should confirm before sending: the same piece of work told twice (in two sections, or twice in the message), a claim that's only loosely supported, wording that could read badly to the client, ${platform === "klaviyo" ? "a message that leaves the email team's structure (title, Hi Team, What happened with its four bullets, Highlights, What we learned, Coming up), a client-facing internal word (flows, recipients, RPR)" : "a message that leaves the team's structure (title, Hi Team, What happened with its four bullets, Highlights, What we learned, Coming up), a Coming up item that isn't in the work log or what was said"}, a number shown without what it's compared to, a target mentioned without its progress.
- alert: something alarming in the data itself the ${ROLE[lineOfPlatform(platform)]} should know before sending, even if the draft is right: revenue or reach collapsing, nothing sent or posted, followers lost, a red deliverability flag, days with no data.
issue: what's wrong in one sentence. where: the line or section it's in (quote a few words). suggestion: the exact fix or what to check. Only real issues; no style nitpicks.
verdict: clean (nothing to fix or check), check (only checks or alerts), or fix (anything to fix).`;

// ─── What the report reads ─────────────────────────────────────────────────

type ReportRow = { id: string; kind: ChannelKind; platform: ChannelPlatform; period_start: string; period_end: string; client_id: string; owner_id: string | null; extras: string | null; metrics: Metrics | null; sections: Sections | null; message: string | null; chat: ChatTurn[] | null; work: { text?: string } | null; layout: unknown; manual_results: { stated?: Stated } | null };

async function context(admin: SupabaseClient, reportId: string) {
  const { data: r } = await admin.from("reports").select("id, kind, platform, period_start, period_end, client_id, owner_id, extras, metrics, sections, message, chat, work, layout, manual_results, clients(name, client_type), profiles!reports_owner_id_fkey(full_name)").eq("id", reportId).single();
  if (!r) throw new Error("Report not found");
  const row = r as unknown as ReportRow & { clients: { name: string; client_type?: string | null }; profiles: { full_name: string } | null };
  // This client's report style for the line (email or social), versioned: see src/lib/reports/style.ts
  const { styleRules } = await import("@/lib/reports/style");
  const { lineOfPlatform } = await import("@/lib/reports/style-core");
  const style = await styleRules(admin, row.client_id, lineOfPlatform(row.platform));
  const { data: last } = await admin.from("reports").select("period_start, sections, message, chat").eq("client_id", row.client_id).eq("platform", row.platform).eq("kind", row.kind).lt("period_start", row.period_start).in("status", ["posted", "submitted"]).order("period_start", { ascending: false }).limit(1).maybeSingle();
  return { r: row, client: row.clients.name, whiteLabel: isWhiteLabel(row.clients.client_type), owner: row.profiles?.full_name ?? null, prefs: style.map((x) => x.text), last };
}
type Ctx = Awaited<ReturnType<typeof context>>;

const day = (iso: string) => String(iso).slice(0, 10);
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const WORK_WORDS: Record<ChannelLine, RegExp> = { email: /email|klaviyo|flow|campaign|newsletter|sms|segment|subscriber|list|template|welcome|abandon/i, social: /social|post|reel|story|stories|instagram|facebook|carousel|organic|content|caption|tiktok|ugc|calendar/i };

/** The work behind the numbers on this line in the period: what was done, what is in progress, what was said, what was promised */
export async function channelWork(admin: SupabaseClient, clientId: string, line: ChannelLine, start: string, end: string) {
  const from = `${start}T00:00:00-05:00`;
  const to = `${end}T23:59:59-05:00`;
  const [made, making, talk, promises] = await Promise.all([
    admin.from("asana_tasks").select("name, format, section, completed_at").eq("client_id", clientId).gte("completed_at", from).lte("completed_at", to).limit(120),
    admin.from("asana_tasks").select("name, format, section").eq("client_id", clientId).eq("open", true).limit(120),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).in("source", ["call", "slack_external", "slack_internal", "gmail", "docs"]).gte("occurred_at", from).lte("occurred_at", to).order("occurred_at").limit(120),
    admin.from("call_commitments").select("what, status, due_at").eq("client_id", clientId).in("status", ["open", "briefed"]).limit(15),
  ]);
  const words = WORK_WORDS[line];
  const mine = <T extends { name: string; format?: string | null }>(xs: T[]) => xs.filter((x) => words.test(`${x.name} ${x.format ?? ""}`));
  const lines = [
    `<delivered_this_period>`,
    ...mine((made.data ?? []) as { name: string; format: string | null; completed_at: string }[]).map((x) => `- ${day(x.completed_at)}: ${clip(x.name, 120)}`),
    `</delivered_this_period>`,
    `<in_progress>`,
    ...mine((making.data ?? []) as { name: string; format: string | null; section: string | null }[]).map((x) => `- ${clip(x.name, 120)} (${x.section ?? "in progress"})`),
    `</in_progress>`,
    `<promises_in_motion>`,
    ...((promises.data ?? []) as { what: string; status: string; due_at: string }[]).map((p) => `- ${p.what} (${p.status}, due ${day(p.due_at)})`),
    `</promises_in_motion>`,
    `<said_this_period>`,
    ...((talk.data ?? []) as { source: string; occurred_at: string; author: string | null; title: string | null; body: string | null }[]).map((i) => `- ${day(i.occurred_at)} [${i.source === "slack_external" ? "client channel" : i.source === "slack_internal" ? "internal Slack" : i.source}${i.author ? `, ${i.author}` : ""}] ${clip(i.title, 80)}${i.title ? ": " : ""}${clip(i.body, 400)}`),
    `</said_this_period>`,
  ];
  return { text: lines.join("\n") };
}

async function clientBlock(admin: SupabaseClient, clientId: string) {
  const ctx = await clientContext(admin, clientId).catch(() => null);
  if (!ctx) return "";
  return `<client_context note="the Brand Bible, strategy and what is remembered about the client: informs the report, never quoted as internal">\n${contextBlock(ctx, undefined, { allotment: false }).slice(0, 14_000)}\n</client_context>`;
}

function sourcesBlock(c: Ctx, metrics: Metrics, work: string, voice: string, client = "") {
  // A social report's numbers include the figures the strategist entered where Meta gave none, and its team notes are given to the writer
  const m = metrics.platform === "social" ? withTeamFindings(metrics, c.r.sections) : metrics;
  const lastNext = (c.last?.sections as Sections | null)?.next ?? [];
  return [
    `<client>${c.client}</client>`,
    `<report_title>${channelTitle(c.client, c.r.kind, m)}</report_title>`,
    `<${ROLE[lineOfPlatform(c.r.platform)].replace(" ", "_")}>${c.owner ?? `the ${ROLE[lineOfPlatform(c.r.platform)]}`}</${ROLE[lineOfPlatform(c.r.platform)].replace(" ", "_")}>`,
    `<numbers>\n${channelMetricsText(m)}\n</numbers>`,
    `<work_log period="${c.r.period_start} to ${c.r.period_end}">\n${work}\n</work_log>`,
    lastSentBlock(c.last as Parameters<typeof lastSentBlock>[0]),
    lastNext.length ? `<what_the_last_report_said_was_next>\n${lastNext.map((x) => `- ${x}`).join("\n")}\n</what_the_last_report_said_was_next>` : "",
    m.platform === "social" ? teamFindingsPrompt(c.r.sections) : "",
    c.r.extras ? `<added_by_the_owner>\n${c.r.extras}\n</added_by_the_owner>` : "",
    c.prefs.length ? `<what_this_client_wants_in_a_report>\n${c.prefs.map((p) => `- ${p}`).join("\n")}\n</what_this_client_wants_in_a_report>` : "",
    pulledBlock(c.r.chat),
    client,
    voice,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Data the owner had the AI pull in the chat: real data the report may use */
function pulledBlock(chat: ChatTurn[] | null) {
  const turns = (chat ?? []).filter((t) => t.data);
  if (!turns.length) return "";
  let room = 30_000;
  const parts: string[] = [];
  for (const t of turns.slice().reverse()) {
    if ((room -= t.data!.length) < 0) break;
    parts.unshift(`<pulled at="${t.at.slice(0, 16)}" what="${(t.pulled ?? []).join("; ").replace(/"/g, "'")}">\n${t.data}\n</pulled>`);
  }
  return `<data_pulled_in_the_chat note="looked up live while revising; as real as the numbers above">\n${parts.join("\n")}\n</data_pulled_in_the_chat>`;
}

// ─── Numbers again, without writing ────────────────────────────────────────

/** The report's numbers worked out again from the synced data for its own dates (no AI, no call out): used to keep an unsent report current */
export async function freshChannelNumbers(admin: SupabaseClient, reportId: string) {
  const c = await context(admin, reportId);
  const was = c.r.metrics;
  const loaded = await loadChannelMetrics(admin, c.r.platform, c.r.client_id, c.r.kind, { start: c.r.period_start, end: c.r.period_end }, { images: false });
  if (!loaded) return null;
  // The owner's own figures (set in the chat) stay over the synced ones
  const fresh = applyStated(loaded, c.r.manual_results?.stated);
  // The email pictures were found when it was written: kept, so a refresh never costs a call
  if (fresh.platform === "klaviyo" && was?.platform === "klaviyo") for (const k of fresh.campaigns) k.image = was.campaigns.find((x) => x.id === k.id)?.image ?? null;
  return { was, metrics: fresh as Metrics, c };
}

// ─── Draft, QA, revise ─────────────────────────────────────────────────────

/** Checks a draft against the data and the work, and adds the plain data checks */
export async function qaChannelReport(admin: SupabaseClient, reportId: string): Promise<Qa> {
  const c = await context(admin, reportId);
  const m = c.r.metrics;
  if (!m) throw new Error("There are no numbers to check yet.");
  const out = await askJson<{ verdict: Qa["verdict"]; flags: QaFlag[] }>({
    agent: "report_qa",
    label: "channel report QA",
    system: c.whiteLabel ? `${QA_SYSTEM(c.r.platform)}\nThis client is white label (an agency partner passes the report on as their own): flag as fix any mention of Kaizen, Kaizen Marketing or Kaizen OS, any link to the agency's site or portal, and any other service raised.` : QA_SYSTEM(c.r.platform),
    schema: QA_SCHEMA,
    maxTokens: 8000,
    prompt: `${sourcesBlock(c, m, c.r.work?.text ?? "", "")}\n\n<draft_message>\n${c.r.message ?? ""}\n</draft_message>\n\n<draft_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</draft_sections>`,
  });
  const flags: QaFlag[] = [...dataFlags(m), ...emailMessageFlags(c.r.message, m, c.client, c.r.kind), ...out.flags];
  const verdict: Qa["verdict"] = flags.some((f) => f.severity === "fix") ? "fix" : flags.length ? "check" : "clean";
  const qa: Qa = { verdict, flags, checkedAt: new Date().toISOString() };
  await admin.from("reports").update({ qa, updated_at: new Date().toISOString() }).eq("id", reportId);
  return qa;
}

/** Draws and saves the top of each card campaign's email (never failing the draft, and never more than a minute) */
async function warmShots(admin: SupabaseClient, clientId: string, m: Metrics): Promise<void> {
  if (m.platform !== "klaviyo" || !m.detail) return;
  const ids = cardShotIds(m);
  if (!ids.length) return;
  const { ensureEmailShots } = await import("./email-shots");
  await Promise.race([ensureEmailShots(admin, clientId, ids, { fetch: true, budgetMs: 50_000 }).catch(() => null), new Promise((done) => setTimeout(done, 60_000))]);
}

/** Drafts (or redrafts) a channel report from scratch: numbers, work, voice and the client's context, then the QA */
export async function draftChannelReport(admin: SupabaseClient, reportId: string) {
  await admin.from("reports").update({ status: "drafting", error: null, updated_at: new Date().toISOString() }).eq("id", reportId);
  try {
    const c = await context(admin, reportId);
    const line = lineOfPlatform(c.r.platform);
    const loaded = await loadChannelMetrics(admin, c.r.platform, c.r.client_id, c.r.kind, { start: c.r.period_start, end: c.r.period_end });
    if (!loaded) throw new Error(`There are no ${line === "email" ? "email" : "social"} numbers for this client yet: connect it first.`);
    const metrics = applyStated(loaded, c.r.manual_results?.stated);
    // The tiles and columns picked on the client's last report on this line carry over (as an ads report's layout does)
    if (!c.r.layout) {
      const { data: prev } = await admin.from("reports").select("layout").eq("client_id", c.r.client_id).eq("platform", c.r.platform).is("target_id", null).neq("id", reportId).not("layout", "is", null).order("period_start", { ascending: false }).limit(1).maybeSingle();
      if (prev?.layout) await admin.from("reports").update({ layout: prev.layout }).eq("id", reportId);
    }
    // The campaign cards' pictures are drawn while the report is written, so the PDF only reads them
    const shots = warmShots(admin, c.r.client_id, metrics).catch(() => null);
    const [work, voice, client] = await Promise.all([channelWork(admin, c.r.client_id, line, c.r.period_start, c.r.period_end), voiceOf(admin, c.owner, c.r.client_id), clientBlock(admin, c.r.client_id)]);
    await admin.from("reports").update({ metrics, work, extra_metrics: null }).eq("id", reportId);
    c.r.metrics = metrics;
    const out = await askJson<{ message: string; sections: Sections }>({
      agent: "reporter",
      label: `${KIND_WORD(c.r.kind)} ${line} report`,
      clientId: c.r.client_id,
      system: forSource(writerSystem(c.r.kind, c.r.platform, c.whiteLabel), metrics),
      schema: c.r.platform === "social" ? SOCIAL_DRAFT_SCHEMA : engagementTemplate(metrics) ? ENGAGEMENT_DRAFT_SCHEMA : DRAFT_SCHEMA,
      maxTokens: 12000,
      prompt: `${sourcesBlock(c, metrics, work.text, voice, client)}\n\nWrite the ${KIND_WORD(c.r.kind)} ${channelName(c.r.platform).toLowerCase()} report for ${metrics.main.label}.`,
    });
    out.sections = carryTeamFindings(c.r.sections, plain(out.sections));
    out.message = noEmDashes(out.message);
    // The backstop: a white label client's report never names the agency, whatever the AI wrote
    if (c.whiteLabel) {
      out.message = forClient(out.message, true);
      out.sections = scrubSections(out.sections);
    }
    out.message = withTitle(out.message, channelTitle(c.client, c.r.kind, metrics));
    out.message = openWithHere(out.message);
    out.sections = dedupeSections(out.sections);
    await admin.from("reports").update({ message: out.message, sections: out.sections, message_basis: reportBasis(out.sections, c.r.extras), updated_at: new Date().toISOString() }).eq("id", reportId);
    // The QA runs before the owner hears about it, so the note they get says whether there's anything to fix
    await qaChannelReport(admin, reportId).catch(() => null);
    await shots;
    await admin.from("reports").update({ status: "draft", updated_at: new Date().toISOString() }).eq("id", reportId);
  } catch (e) {
    await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", reportId);
  }
}

const REVISE_SYSTEM = `You revise a client report with the person who will send it. They tell you what to change; you change exactly that, keep everything else as it was, and keep their voice. The same rules hold: every number from the data, the arc (what we did, what we're doing and why, what's next), nothing internal, no em dashes. If they ask for something the data or work log can't support, say so in reply and don't invent it.
reply: one or two plain sentences on what you changed. lesson: when the request is about what THIS client wants in their reports from now on ("they always want the flows broken out", "keep it to 5 bullets"), write it as one standing preference; otherwise "". Only lasting preferences, never one-off fixes.`;
const REVISE_SCHEMA = obj({ reply: S, message: S, sections: SECTIONS, lesson: S });
const PERIOD_RULE = `The report's dates are set by the app, never by you: don't write numbers for other dates into the report as if they were its period. Numbers you look up for other dates are only for comparisons, and always say their dates.`;

/** The owner asks for a change; the report is rewritten, the QA runs again, and a lasting preference is remembered */
export async function reviseChannelReport(admin: SupabaseClient, reportId: string, ask: string, by: string, opts: { /** Screenshots pasted with the ask */ images?: import("@/lib/chat-images").ChatImage[]; echo?: boolean; byId?: string | null; /** An export the owner attached in the chat: read with the ask, kept as data pulled */ file?: { name: string; text: string } } = {}) {
  const c = await context(admin, reportId);
  const m = c.r.metrics;
  if (!m) throw new Error("It hasn't been written yet.");
  const chat = c.r.chat ?? [];
  const pulled: { label: string; data: string }[] = [];
  const tools = await channelReportTools(admin, c.r, pulled, { id: opts.byId ?? null, name: by });
  // An attached export is real data for this report: the AI reads it, and it's kept with the turn like a lookup
  if (opts.file) pulled.push({ label: `File: ${opts.file.name}`, data: opts.file.text.slice(0, 12_000) });
  const today = todayIn();
  const period = { start: c.r.period_start, end: c.r.period_end };
  const prev = previousPeriod(period);
  const out = await askJsonWithTools<{ reply: string; message: string; sections: Sections; lesson: string }>({
    agent: "reporter",
    label: "revise channel report",
    clientId: c.r.client_id,
    system: `${forSource(writerSystem(c.r.kind, c.r.platform, c.whiteLabel), c.r.metrics)}\n\n${REVISE_SYSTEM}\n${OUTPUTS_RULE}\n${PERIOD_RULE}\n\n${channelToolsLine(c.r.platform)}`,
    schema: c.r.platform === "social" ? SOCIAL_REVISE_SCHEMA : engagementTemplate(c.r.metrics) ? ENGAGEMENT_REVISE_SCHEMA : REVISE_SCHEMA,
    tools,
    maxRounds: 6,
    maxTokens: 16000,
    images: opts.images ?? [],
    prompt: `<today timezone="America/New_York">${today}</today>\n<report_period>${rangeLabel(period, today)} (${period.start} to ${period.end}), compared with ${rangeLabel(prev, today)}. The PDF is drawn by the app for exactly these dates.</report_period>\n\n${sourcesBlock(c, m, c.r.work?.text ?? "", "")}\n\n<current_message>\n${c.r.message ?? ""}\n</current_message>\n<current_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</current_sections>\n\n<conversation>\n${chat
      .slice(-10)
      .map((t) => `${t.role === "user" ? "Owner" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>${opts.file ? `\n\n<attached_file name="${opts.file.name.replace(/"/g, "'")}">\n${opts.file.text.slice(0, 40_000)}\n</attached_file>` : ""}\n\nThe owner asks: ${ask.trim().slice(0, 2000)}${(opts.images ?? []).length ? `
(${opts.images!.length} screenshot${opts.images!.length === 1 ? " is" : "s are"} attached: look at ${opts.images!.length === 1 ? "it" : "them"} and answer from what you see.)` : ""}`,
  });
  const now = new Date().toISOString();
  const data = pulled.map((x) => `[${x.label}]\n${x.data}`).join("\n\n").slice(0, 20_000);
  out.sections = carryTeamFindings(c.r.sections, plain(out.sections));
  out.message = noEmDashes(out.message);
  if (c.whiteLabel) {
    out.message = forClient(out.message, true);
    out.sections = scrubSections(out.sections);
  }
  out.message = withTitle(out.message, channelTitle(c.client, c.r.kind, m));
  out.message = openWithHere(out.message);
  out.sections = dedupeSections(out.sections);
  // Read back what's being saved against what was there: the chat says which outputs changed, from the text itself
  const check = outputsCheck({ message: c.r.message, sections: c.r.sections }, out);
  const thumbs = await chatThumbs(opts.images).catch(() => []);
  const next: ChatTurn[] = [
    ...chat,
    ...(opts.echo === false ? [] : [{ role: "user" as const, text: ask.trim(), at: now, by, ...(thumbs.length ? { images: thumbs } : {}) }]),
    { role: "assistant" as const, text: `${out.reply.trim()}\n\n${check.line}`, at: now, ...(pulled.length ? { pulled: pulled.map((x) => x.label), data } : {}) },
  ].slice(-40);
  await admin.from("reports").update({ message: out.message, sections: out.sections, message_basis: reportBasis(out.sections, c.r.extras), chat: next, updated_at: now }).eq("id", reportId);
  if (out.lesson.trim()) await (await import("@/lib/reports/write")).rememberPref(admin, c.r.client_id, out.lesson.trim(), { line: (await import("@/lib/reports/style-core")).lineOfPlatform(c.r.platform), by: { id: opts.byId ?? null, name: by }, reportId, source: "studio_ask" }).catch(() => null);
  const qa = await qaChannelReport(admin, reportId).catch(() => null);
  return { chat: next, message: out.message, sections: out.sections, qa, lesson: out.lesson.trim() || null };
}

/** The owner edited the report by hand after its Slack message was written: the message is brought up to date with the report as it stands (same format and voice) */
export async function refreshChannelMessage(admin: SupabaseClient, reportId: string) {
  const { data: r } = await admin.from("reports").select("platform, message, sections, extras, clients(client_type)").eq("id", reportId).single();
  const whiteLabel = isWhiteLabel((r?.clients as unknown as { client_type?: string | null } | null)?.client_type);
  if (!r?.sections || !r.message?.trim()) return { message: r?.message ?? "", basis: reportBasis(r?.sections, r?.extras) };
  const out = await askJson<{ message: string }>({
    agent: "reporter",
    label: "refresh channel report message",
    override: { model: "sonnet", effort: "low" },
    system: `The owner edited their client report after its Slack message was written. Bring the Slack message up to date with the report exactly as it stands now: keep its format, structure, voice and length, and change only what the edits changed (a number, a point added or removed, a reworded line, a different plan). Every number must match the report. Slack formatting (*bold*, bullets) as it was. No em dashes.${whiteLabel ? `\n${WHITE_LABEL_RULE}` : ""}`,
    schema: obj({ message: S }),
    maxTokens: 4000,
    prompt: `<the_report_now>\n${JSON.stringify(r.sections)}${r.extras?.trim() ? `\nAlso: ${r.extras.trim()}` : ""}\n</the_report_now>\n\n<the_message_as_it_was>\n${withoutMentions(r.message)}\n</the_message_as_it_was>\n\nReturn the message, up to date.`,
  });
  const basis = reportBasis(r.sections, r.extras);
  out.message = openWithHere(forClient(noEmDashes(out.message), whiteLabel));
  await admin.from("reports").update({ message: out.message, message_basis: basis, updated_at: new Date().toISOString() }).eq("id", reportId);
  return { message: out.message, basis };
}

export { platformOfLine };
