import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, askJsonWithTools, clientContext, contextBlock, type AiTool } from "@/lib/ai";
import type { ChatTurn, Qa, QaFlag, Sections } from "@/lib/reports/write";
import { reportBasis } from "@/lib/reports/format";
import { forClient, isWhiteLabel, scrubSections, WHITE_LABEL_RULE } from "@/lib/reports/white-label";
import { openWithHere, withoutMentions } from "@/lib/reports/slack-text";
import { previousPeriod, rangeLabel, todayIn } from "@/lib/reports/period";
import { reportTools } from "@/lib/reports/tools";
import { voiceOf } from "@/lib/reports/work";
import { channelName, dataFlags, lineOfPlatform, platformOfLine, type ChannelKind, type ChannelLine, type ChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
import { loadChannelMetrics } from "./data";
import { channelMetricsText } from "./text";

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
  return { ...sections, headline: f(sections.headline), summary: f(sections.summary), did: sections.did.map(f), doing: sections.doing.map(f), next: sections.next.map(f), highlights: sections.highlights.map(f), takeaways: sections.takeaways?.map((t) => ({ title: f(t.title), text: f(t.text) })), stories: [] };
}

const ROLE: Record<ChannelLine, string> = { email: "email strategist", social: "social media manager" };

const TAKEAWAY_RULES = `takeaways: exactly three cards for the PDF, read from the numbers alone (the work and the plan stay in the message). Each: title (a bold claim of 3 to 7 words) and text (one or two sentences with the real numbers and what they are compared to). Plain and specific: no hype, no exclamation marks, no adjectives the numbers don't earn, no advice. Percent changes to one decimal.`;

/** What the writer is told, by line: the owner's role, what leads the report, what each number means */
function lineRules(platform: ChannelPlatform): string {
  if (platform === "klaviyo")
    return `Lead with attributed revenue for the period against the period before, and against the target when <numbers> gives one (say plainly how far along it is). Then the campaigns that mattered, by name, with their open and click rates and revenue; the flows and which earned most; list growth; and deliverability, honestly. If <numbers> carries an email health score, mention it once in plain words for the client: the score and its colour, what is lifting it, and what we are doing about the one or two checks holding it back. Never recite the weights, the formula or all seven checks, and say it is read over the last 30 days. Revenue is what Klaviyo attributes to email: never call it the store's total revenue and never claim email caused sales it doesn't show. Flow revenue is Klaviyo's last 30 days (as stated in <numbers>), not the period's own days: say "over the last 30 days" when you quote it. If a campaign has a preview picture, you may refer to it as a highlight. If a deliverability flag is red, say it plainly and what we're doing about it; if rates are healthy, say so in a line.`;
  return `Lead with follower growth and reach for the period against the period before, then views, the engagement rate (interactions over reach; if <numbers> says it isn't available, don't quote one) against the target when <numbers> gives one, how much we published, and the posts that did best and why they likely worked (format, topic, hook, from what the numbers and captions show). Never claim a post caused follower growth unless the numbers show it. Instagram and Facebook are counted from Meta's own account insights; say which platform a number is from when it matters.`;
}

function writerSystem(kind: ChannelKind, platform: ChannelPlatform, whiteLabel = false): string {
  const line = lineOfPlatform(platform);
  const base = `You draft a ${kind} ${channelName(platform).toLowerCase()} report for a client of Kaizen Marketing, a marketing agency, as the ${ROLE[line]} who runs this channel for the client. The ${ROLE[line]} reads it, may edit it, and sends it as themselves, so it must sound exactly like them: match the voice, warmth, length, formatting and habits in their examples (greeting, how they introduce numbers, headers, bullets, sign-off). If there are no examples, write warm, plain and confident. This is not a paid ads report: ignore any guidance meant for ad accounts, budgets, ROAS or cost per result.
Every report follows the same arc: what we did, what we're doing now and why, and what comes next. Its job is to show the client the work behind the numbers, not just the numbers.
Accuracy above everything: every number you write must come from the numbers given, rounded the way the ${ROLE[line]} rounds; never estimate, never invent a figure, a campaign, a post, a change or a plan. Comparisons say against what ("vs September", "vs the week before"). If results are down, say it plainly and say what we're doing about it; never spin. Only mention work that is in the work log or what the ${ROLE[line]} added (group many small edits into what they amount to). Never mention internal things: team members other than the client's own people, Kaizen Ads, AI, audits by name, internal Slack, other clients. Never use em dashes; use a comma, a colon or a new sentence.
${lineRules(platform)}
message: the ${kind === "weekly" ? "Slack message to the client channel" : "Slack post that goes with the monthly report"}, in Slack formatting (*bold* for short section headers, "• " for bullets, line breaks; no # headings, no emojis unless the ${ROLE[line]} uses them). Always open with <!here> (Slack's @here, written exactly like that) and then the greeting: never a person's mention (no <@U…> code, no name with @). ${kind === "weekly" ? "Open with the headline numbers for the week against the week before, then what we did, then what's next. Keep it as short as the examples." : "A short, warm note that the monthly report is ready, the two or three numbers that matter most for the month against the month before, one line on the biggest thing we did and the biggest thing coming up; the link is added after."}
sections: the same content, structured, for the PDF and the report page: headline (one line, the main takeaway), summary (2 to 4 sentences, the numbers in context), did (what we did, 3 to 7 bullets), doing (what we're doing now and why, 2 to 5), next (what comes next, 2 to 5), highlights (2 to 4 short numeric callouts).
${TAKEAWAY_RULES}`;
  return whiteLabel ? `${base}\n${WHITE_LABEL_RULE}` : base;
}

const QA_SYSTEM = (platform: ChannelPlatform) => `You are the QA for client reports at Kaizen Marketing, a marketing agency. Before the ${ROLE[lineOfPlatform(platform)]} sees a draft of this ${channelName(platform).toLowerCase()} report, you check it as if the client's trust depended on it. Compare the draft (message and sections) with the source data, the work log and what the ${ROLE[lineOfPlatform(platform)]} added.
Flag:
- fix: a number that doesn't match the data or the math (percent changes, rates), a wrong period or comparison, a campaign, post, change or plan that isn't in the sources, revenue described as the store's total instead of attributed email revenue (email), an engagement rate quoted when the data says it isn't available (social), a client-facing mention of something internal (team names other than the client's, AI, Kaizen Ads, other clients), an em dash, an email health score or check value that doesn't match the numbers.
- check: something the ${ROLE[lineOfPlatform(platform)]} should confirm before sending: a claim that's only loosely supported, wording that could read badly to the client, a missing part of the arc (did, doing, next), a number shown without what it's compared to, a target mentioned without its progress.
- alert: something alarming in the data itself the ${ROLE[lineOfPlatform(platform)]} should know before sending, even if the draft is right: revenue or reach collapsing, nothing sent or posted, followers lost, a red deliverability flag, days with no data.
issue: what's wrong in one sentence. where: the line or section it's in (quote a few words). suggestion: the exact fix or what to check. Only real issues; no style nitpicks.
verdict: clean (nothing to fix or check), check (only checks or alerts), or fix (anything to fix).`;

// ─── What the report reads ─────────────────────────────────────────────────

type ReportRow = { id: string; kind: ChannelKind; platform: ChannelPlatform; period_start: string; period_end: string; client_id: string; owner_id: string | null; extras: string | null; metrics: Metrics | null; sections: Sections | null; message: string | null; chat: ChatTurn[] | null; work: { text?: string } | null };

async function context(admin: SupabaseClient, reportId: string) {
  const { data: r } = await admin.from("reports").select("id, kind, platform, period_start, period_end, client_id, owner_id, extras, metrics, sections, message, chat, work, clients(name, client_type), profiles!reports_owner_id_fkey(full_name)").eq("id", reportId).single();
  if (!r) throw new Error("Report not found");
  const row = r as unknown as ReportRow & { clients: { name: string; client_type?: string | null }; profiles: { full_name: string } | null };
  const { data: prefs } = await admin.from("client_report_prefs").select("notes").eq("client_id", row.client_id).maybeSingle();
  const { data: last } = await admin.from("reports").select("period_start, sections").eq("client_id", row.client_id).eq("platform", row.platform).eq("kind", row.kind).lt("period_start", row.period_start).in("status", ["posted", "submitted"]).order("period_start", { ascending: false }).limit(1).maybeSingle();
  return { r: row, client: row.clients.name, whiteLabel: isWhiteLabel(row.clients.client_type), owner: row.profiles?.full_name ?? null, prefs: ((prefs?.notes ?? []) as string[]).slice(-20), last };
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

function sourcesBlock(c: Ctx, m: Metrics, work: string, voice: string, client = "") {
  const lastNext = (c.last?.sections as Sections | null)?.next ?? [];
  return [
    `<client>${c.client}</client>`,
    `<${ROLE[lineOfPlatform(c.r.platform)].replace(" ", "_")}>${c.owner ?? `the ${ROLE[lineOfPlatform(c.r.platform)]}`}</${ROLE[lineOfPlatform(c.r.platform)].replace(" ", "_")}>`,
    `<numbers>\n${channelMetricsText(m)}\n</numbers>`,
    `<work_log period="${c.r.period_start} to ${c.r.period_end}">\n${work}\n</work_log>`,
    lastNext.length ? `<what_the_last_report_said_was_next>\n${lastNext.map((x) => `- ${x}`).join("\n")}\n</what_the_last_report_said_was_next>` : "",
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
  const fresh = await loadChannelMetrics(admin, c.r.platform, c.r.client_id, c.r.kind, { start: c.r.period_start, end: c.r.period_end }, { images: false });
  if (!fresh) return null;
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
    system: c.whiteLabel ? `${QA_SYSTEM(c.r.platform)}\nThis client is white label (an agency partner passes the report on as their own): flag as fix any mention of Kaizen, Kaizen Marketing or Kaizen Ads, any link to the agency's site or portal, and any other service raised.` : QA_SYSTEM(c.r.platform),
    schema: QA_SCHEMA,
    maxTokens: 8000,
    prompt: `${sourcesBlock(c, m, c.r.work?.text ?? "", "")}\n\n<draft_message>\n${c.r.message ?? ""}\n</draft_message>\n\n<draft_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</draft_sections>`,
  });
  const flags: QaFlag[] = [...dataFlags(m), ...out.flags];
  const verdict: Qa["verdict"] = flags.some((f) => f.severity === "fix") ? "fix" : flags.length ? "check" : "clean";
  const qa: Qa = { verdict, flags, checkedAt: new Date().toISOString() };
  await admin.from("reports").update({ qa, updated_at: new Date().toISOString() }).eq("id", reportId);
  return qa;
}

/** Drafts (or redrafts) a channel report from scratch: numbers, work, voice and the client's context, then the QA */
export async function draftChannelReport(admin: SupabaseClient, reportId: string) {
  await admin.from("reports").update({ status: "drafting", error: null, updated_at: new Date().toISOString() }).eq("id", reportId);
  try {
    const c = await context(admin, reportId);
    const line = lineOfPlatform(c.r.platform);
    const metrics = await loadChannelMetrics(admin, c.r.platform, c.r.client_id, c.r.kind, { start: c.r.period_start, end: c.r.period_end });
    if (!metrics) throw new Error(`There are no ${line === "email" ? "Klaviyo" : "social"} numbers for this client yet: connect it first.`);
    const [work, voice, client] = await Promise.all([channelWork(admin, c.r.client_id, line, c.r.period_start, c.r.period_end), voiceOf(admin, c.owner, c.r.client_id), clientBlock(admin, c.r.client_id)]);
    await admin.from("reports").update({ metrics, work, extra_metrics: null }).eq("id", reportId);
    c.r.metrics = metrics;
    const out = await askJson<{ message: string; sections: Sections }>({
      agent: "reporter",
      label: `${c.r.kind} ${line} report`,
      clientId: c.r.client_id,
      system: writerSystem(c.r.kind, c.r.platform, c.whiteLabel),
      schema: DRAFT_SCHEMA,
      maxTokens: 12000,
      prompt: `${sourcesBlock(c, metrics, work.text, voice, client)}\n\nWrite the ${c.r.kind} ${channelName(c.r.platform).toLowerCase()} report for ${metrics.main.label}.`,
    });
    out.sections = plain(out.sections);
    out.message = noEmDashes(out.message);
    // The backstop: a white label client's report never names the agency, whatever the AI wrote
    if (c.whiteLabel) {
      out.message = forClient(out.message, true);
      out.sections = scrubSections(out.sections);
    }
    out.message = openWithHere(out.message);
    await admin.from("reports").update({ message: out.message, sections: out.sections, message_basis: reportBasis(out.sections, c.r.extras), updated_at: new Date().toISOString() }).eq("id", reportId);
    // The QA runs before the owner hears about it, so the note they get says whether there's anything to fix
    await qaChannelReport(admin, reportId).catch(() => null);
    await admin.from("reports").update({ status: "draft", updated_at: new Date().toISOString() }).eq("id", reportId);
  } catch (e) {
    await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", reportId);
  }
}

const REVISE_SYSTEM = `You revise a client report with the person who will send it. They tell you what to change; you change exactly that, keep everything else as it was, and keep their voice. The same rules hold: every number from the data, the arc (what we did, what we're doing and why, what's next), nothing internal, no em dashes. If they ask for something the data or work log can't support, say so in reply and don't invent it.
reply: one or two plain sentences on what you changed. lesson: when the request is about what THIS client wants in their reports from now on ("they always want the flows broken out", "keep it to 5 bullets"), write it as one standing preference; otherwise "". Only lasting preferences, never one-off fixes.`;
const REVISE_SCHEMA = obj({ reply: S, message: S, sections: SECTIONS, lesson: S });
const PERIOD_RULE = `The report's dates are set by the app, never by you: don't write numbers for other dates into the report as if they were its period. Numbers you look up for other dates are only for comparisons, and always say their dates.`;

/** The lookups the chat has for a channel report: the client's context and calls, the earlier reports on the line, and any other dates of the same numbers */
async function channelTools(admin: SupabaseClient, c: Ctx, pulled: { label: string; data: string }[], who: { id: string | null; name: string | null }): Promise<AiTool[]> {
  const base = await reportTools(admin, { client_id: c.r.client_id, platform: c.r.platform, kpi_targets: null }, pulled, who);
  // Only the ones that make no sense for an ad account are left out (its trend, the numbers the buyer sets by hand, Meta, Google, Motion)
  const keep = new Set(["client_overview", "search_client", "recent_calls", "read_call"]);
  const note = (label: string, data: unknown) => {
    pulled.push({ label, data: (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 12_000) });
    return data;
  };
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  return [
    ...base.filter((t) => keep.has(t.name)),
    {
      name: "earlier_reports",
      description: "This client's earlier reports on this line that were sent (newest first): the period, the Slack message and the sections. Use it when asked to follow the last report's format or compare with what was reported before.",
      input_schema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 6 } }, additionalProperties: false },
      run: async (input) => {
        const { data } = await admin.from("reports").select("kind, period_start, period_end, message, sections").eq("client_id", c.r.client_id).eq("platform", c.r.platform).in("status", ["posted", "submitted"]).order("period_end", { ascending: false }).limit(Math.min(6, Number(input.count) || 2));
        return note(`Earlier reports (${data?.length ?? 0})`, data ?? []);
      },
    },
    {
      name: "numbers_for_dates",
      description: `The same numbers this report uses, worked out for other dates (against the same number of days just before): for a comparison, a longer view or something the owner asks about. Always say the dates you looked up.`,
      input_schema: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD, not after yesterday" } }, required: ["start", "end"], additionalProperties: false },
      run: async (input) => {
        const start = String(input.start ?? "");
        const end = String(input.end ?? "");
        if (!DAY.test(start) || !DAY.test(end) || start > end) throw new Error("Give a start and an end day (YYYY-MM-DD), the start first.");
        const m = await loadChannelMetrics(admin, c.r.platform, c.r.client_id, "weekly", { start, end }, { images: false });
        if (!m) throw new Error("There are no numbers for the client to look up.");
        return note(`${channelName(c.r.platform)} numbers, ${start} to ${end}`, channelMetricsText(m));
      },
    },
  ];
}

/** The owner asks for a change; the report is rewritten, the QA runs again, and a lasting preference is remembered */
export async function reviseChannelReport(admin: SupabaseClient, reportId: string, ask: string, by: string, opts: { echo?: boolean; byId?: string | null } = {}) {
  const c = await context(admin, reportId);
  const m = c.r.metrics;
  if (!m) throw new Error("It hasn't been written yet.");
  const chat = c.r.chat ?? [];
  const pulled: { label: string; data: string }[] = [];
  const tools = await channelTools(admin, c, pulled, { id: opts.byId ?? null, name: by });
  const today = todayIn();
  const period = { start: c.r.period_start, end: c.r.period_end };
  const prev = previousPeriod(period);
  const out = await askJsonWithTools<{ reply: string; message: string; sections: Sections; lesson: string }>({
    agent: "reporter",
    label: "revise channel report",
    clientId: c.r.client_id,
    system: `${writerSystem(c.r.kind, c.r.platform, c.whiteLabel)}\n\n${REVISE_SYSTEM}\n${PERIOD_RULE}\n\nYou can look things up before you answer: everything on file for the client (the Brand Bible, calls, Slack, email, Drive), this client's earlier reports on this line, and these numbers for any other dates. Numbers you pull are real data: use them exactly and say the dates.`,
    schema: REVISE_SCHEMA,
    tools,
    maxRounds: 6,
    maxTokens: 16000,
    prompt: `<today timezone="America/New_York">${today}</today>\n<report_period>${rangeLabel(period, today)} (${period.start} to ${period.end}), compared with ${rangeLabel(prev, today)}. The PDF is drawn by the app for exactly these dates.</report_period>\n\n${sourcesBlock(c, m, c.r.work?.text ?? "", "")}\n\n<current_message>\n${c.r.message ?? ""}\n</current_message>\n<current_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</current_sections>\n\n<conversation>\n${chat
      .slice(-10)
      .map((t) => `${t.role === "user" ? "Owner" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe owner asks: ${ask.trim().slice(0, 2000)}`,
  });
  const now = new Date().toISOString();
  const data = pulled.map((x) => `[${x.label}]\n${x.data}`).join("\n\n").slice(0, 20_000);
  const next: ChatTurn[] = [
    ...chat,
    ...(opts.echo === false ? [] : [{ role: "user" as const, text: ask.trim(), at: now, by }]),
    { role: "assistant" as const, text: out.reply, at: now, ...(pulled.length ? { pulled: pulled.map((x) => x.label), data } : {}) },
  ].slice(-40);
  out.sections = plain(out.sections);
  out.message = noEmDashes(out.message);
  if (c.whiteLabel) {
    out.message = forClient(out.message, true);
    out.sections = scrubSections(out.sections);
  }
  out.message = openWithHere(out.message);
  await admin.from("reports").update({ message: out.message, sections: out.sections, message_basis: reportBasis(out.sections, c.r.extras), chat: next, updated_at: now }).eq("id", reportId);
  if (out.lesson.trim()) await (await import("@/lib/reports/write")).rememberPref(admin, c.r.client_id, out.lesson.trim());
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
