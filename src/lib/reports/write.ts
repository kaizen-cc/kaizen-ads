import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, type AgentKey } from "@/lib/ai";
import { metricsText, reportMetrics, type ReportMetrics } from "./metrics";
import { voiceOf, workDone } from "./work";

// Writing a client report: the numbers (reportMetrics), the work behind them (workDone), the buyer's own voice (their
// recaps in client channels), what this client likes in a report (learned from past edits), and what the buyer added
// (sales from the CRM, other channels). Every draft and every revision is checked by the QA before the buyer sees it.
// The structure is always the same: what we did, what we're doing now and why, what comes next.

export type Sections = { headline: string; summary: string; did: string[]; doing: string[]; next: string[]; highlights: string[] };
export type QaFlag = { severity: "fix" | "check" | "alert"; issue: string; where: string; suggestion: string };
export type Qa = { verdict: "clean" | "check" | "fix"; flags: QaFlag[]; checkedAt: string };
export type ChatTurn = { role: "user" | "assistant"; text: string; at: string; by?: string };

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SECTIONS = obj({ headline: S, summary: S, did: LIST, doing: LIST, next: LIST, highlights: LIST });
const DRAFT_SCHEMA = obj({ message: S, sections: SECTIONS });

const agentFor = (platform: string): AgentKey => (platform === "google" ? "google_reporter" : "reporter");

function writerSystem(kind: "weekly" | "monthly" | "custom", platform: string): string {
  const where = platform === "google" ? "Google Ads" : "Meta Ads";
  if (kind === "custom")
    return writerSystem("weekly", platform)
      .replace(/a weekly (Meta Ads|Google Ads) report/, `an on-demand ${where} recap (the client asked where things stand, for the dates given)`)
      .replace("Open with the headline numbers for the last 7 days against the week before (and where the month stands)", "Open with the headline numbers for the dates asked about against the same number of days just before");
  return `You draft a ${kind === "weekly" ? "weekly" : "monthly"} ${where} report for a client of Kaizen Marketing, a paid social agency, as the media buyer who runs the account. The buyer reads it, may edit it, and sends it as themselves, so it must sound exactly like them: match the voice, warmth, length, formatting and habits in their examples (greeting, how they introduce numbers, headers, bullets, sign-off). If there are no examples, write warm, plain and confident.
Every report follows the same arc: what we did, what we're doing now and why, and what comes next. Its job is to show the client the work behind the numbers, not just the numbers.
Accuracy above everything: every number you write must come from the numbers given, rounded the way the buyer rounds; never estimate, never invent a figure, an ad, a change or a plan. Comparisons say against what ("vs the week before", "vs August"). If results are down, say it plainly and say what we're doing about it; never spin. Only mention work that's in the work log, the sprint, or what the buyer added; group many small edits into what they amount to ("tightened budgets on the low-performing ad sets"). Never mention internal things: team members other than the client's own people, Kaizen Ads, AI, audits by name, allotments, internal Slack, other clients.
message: the ${kind === "weekly" ? "Slack message to the client channel" : "Slack post that goes with the monthly report link"}, in Slack formatting (*bold* for short section headers, "• " for bullets, line breaks; no # headings, no emojis unless the buyer uses them). ${kind === "weekly" ? "Open with the headline numbers for the last 7 days against the week before (and where the month stands), then what we did this week, the top creative with its preview link when there is one, and what's next. Keep it as short as the buyer's own recaps." : "A short, warm note that the monthly recap is ready, the two or three numbers that matter most for the month against the month before, one line on the biggest thing we did and the biggest thing coming up; the link is added after."}
sections: the same content, structured, for the PDF and the report page: headline (one line, the main takeaway), summary (2 to 4 sentences, the numbers in context), did (what we did, 3 to 7 bullets), doing (what we're doing now and why, 2 to 5), next (what comes next, 2 to 5), highlights (2 to 4 short numeric callouts, e.g. "14 leads at $84.21, down 56%").`;
}

const QA_SYSTEM = `You are the QA for client reports at Kaizen Marketing, a paid social agency. Before a buyer sees a draft, you check it as if the client's trust depended on it. Compare the draft (message and sections) with the source data, the work log and what the buyer added. Flag:
- fix: a number that doesn't match the data or the math (percent changes, cost per result = spend / results, ROAS = revenue / spend), a wrong period or comparison, an ad, change or plan that isn't in the sources, a client-facing mention of something internal (team names other than the client's, AI, Kaizen Ads, other clients), a broken or missing preview link it refers to.
- check: something the buyer should confirm before sending: a claim that's only loosely supported, wording that could read badly to the client, a missing section of the arc (did, doing, next), a number shown without what it's compared to.
- alert: something alarming in the data itself the buyer should know before sending, even if the draft is right: results collapsing, spend with no results, spend far past budget, tracking that looks broken (clicks but zero results for days, a sudden zero), days with no data, a big swing that needs an explanation.
issue: what's wrong in one sentence. where: the line or section it's in (quote a few words). suggestion: the exact fix or what to check. Only real issues; no style nitpicks. verdict: clean (nothing to fix or check), check (only checks or alerts), or fix (anything to fix).`;
const QA_SCHEMA = obj({ verdict: { type: "string", enum: ["clean", "check", "fix"] }, flags: { type: "array", items: obj({ severity: { type: "string", enum: ["fix", "check", "alert"] }, issue: S, where: S, suggestion: S }) } });

/** Plain checks on the data, before any AI: what the QA must never miss. */
function dataFlags(m: ReportMetrics): QaFlag[] {
  const out: QaFlag[] = [];
  if (m.gaps.length) out.push({ severity: "alert", issue: `No data for ${m.gaps.length} day${m.gaps.length === 1 ? "" : "s"} in the period (${m.gaps.slice(0, 4).join(", ")}${m.gaps.length > 4 ? "…" : ""}).`, where: "Data", suggestion: "Check the account was delivering and synced (Pull now on the KPI board) before sending." });
  if (m.main.spend > 0 && m.main.results === 0) out.push({ severity: "alert", issue: `$${m.main.spend.toFixed(2)} spent with no ${m.conversion.toLowerCase()} recorded.`, where: "Data", suggestion: "Check tracking, and that the KPI counts the right conversion, before reporting zero." });
  if (m.compare.results > 4 && m.main.results < m.compare.results * 0.4) out.push({ severity: "alert", issue: `${m.conversion} fell from ${m.compare.results} to ${m.main.results}.`, where: "Data", suggestion: "Make sure the report explains why and what we're doing about it." });
  if (m.mtd && m.monthlyBudget && m.mtd.spend > m.monthlyBudget) out.push({ severity: "alert", issue: `Month to date spend ($${m.mtd.spend.toFixed(0)}) is already past the $${m.monthlyBudget.toFixed(0)} monthly budget.`, where: "Data", suggestion: "Confirm the budget with the client, or say how spend is being brought in line." });
  if (m.main.spend === 0) out.push({ severity: "alert", issue: "Nothing spent in the period.", where: "Data", suggestion: "If the account is paused on purpose, the report should say so." });
  return out;
}

async function context(admin: SupabaseClient, reportId: string) {
  const { data: r } = await admin
    .from("reports")
    .select("id, kind, platform, period_start, period_end, client_id, target_id, owner_id, extras, metrics, work, sections, message, chat, clients(name), kpi_targets(id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, target, monthly_budget), profiles!reports_owner_id_fkey(full_name)")
    .eq("id", reportId)
    .single();
  if (!r) throw new Error("Report not found");
  const client = (r.clients as unknown as { name: string }).name;
  const target = r.kpi_targets as unknown as Parameters<typeof reportMetrics>[1];
  const owner = (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null;
  const { data: prefs } = await admin.from("client_report_prefs").select("notes").eq("client_id", r.client_id).maybeSingle();
  const { data: last } = await admin.from("reports").select("period_start, sections").eq("target_id", r.target_id).eq("kind", r.kind).lt("period_start", r.period_start).in("status", ["posted", "submitted"]).order("period_start", { ascending: false }).limit(1).maybeSingle();
  return { r, client, target, owner, prefs: ((prefs?.notes ?? []) as string[]).slice(-20), last };
}

function sourcesBlock(c: Awaited<ReturnType<typeof context>>, metrics: ReportMetrics, work: string, voice: string) {
  const lastNext = (c.last?.sections as Sections | null)?.next ?? [];
  return [
    `<client>${c.client}</client>`,
    `<buyer>${c.owner ?? "the buyer"}</buyer>`,
    `<numbers>\n${metricsText(metrics)}\n</numbers>`,
    `<work_log period="${c.r.period_start} to ${c.r.period_end}">\n${work}\n</work_log>`,
    lastNext.length ? `<what_the_last_report_said_was_next>\n${lastNext.map((x) => `- ${x}`).join("\n")}\n</what_the_last_report_said_was_next>` : "",
    c.r.extras ? `<added_by_the_buyer>\n${c.r.extras}\n</added_by_the_buyer>` : "",
    c.prefs.length ? `<what_this_client_wants_in_a_report>\n${c.prefs.map((p) => `- ${p}`).join("\n")}\n</what_this_client_wants_in_a_report>` : "",
    voice,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Checks a draft against the data and the work, and adds the plain data checks. */
export async function qaReport(admin: SupabaseClient, reportId: string): Promise<Qa> {
  const c = await context(admin, reportId);
  const metrics = c.r.metrics as ReportMetrics;
  const work = ((c.r as unknown as { work?: { text?: string } }).work?.text) ?? "";
  const out = await askJson<{ verdict: Qa["verdict"]; flags: QaFlag[] }>({
    agent: "report_qa",
    label: "report QA",
    system: QA_SYSTEM,
    schema: QA_SCHEMA,
    maxTokens: 8000,
    prompt: `${sourcesBlock(c, metrics, work, "")}\n\n<draft_message>\n${c.r.message ?? ""}\n</draft_message>\n\n<draft_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</draft_sections>`,
  });
  const flags = [...dataFlags(metrics), ...out.flags];
  const verdict: Qa["verdict"] = flags.some((f) => f.severity === "fix") ? "fix" : flags.length ? "check" : "clean";
  const qa: Qa = { verdict, flags, checkedAt: new Date().toISOString() };
  await admin.from("reports").update({ qa, updated_at: new Date().toISOString() }).eq("id", reportId);
  return qa;
}

/** Drafts (or redrafts) a report from scratch: numbers, work, voice, then the QA. */
export async function draftReport(admin: SupabaseClient, reportId: string) {
  await admin.from("reports").update({ status: "drafting", error: null, updated_at: new Date().toISOString() }).eq("id", reportId);
  try {
    const c = await context(admin, reportId);
    const kind = c.r.kind as "weekly" | "monthly" | "custom";
    const today = new Date(`${c.r.period_end}T12:00:00Z`);
    today.setUTCDate(today.getUTCDate() + 1);
    const range = kind === "custom" ? { start: c.r.period_start as string, end: c.r.period_end as string } : undefined;
    const [metrics, voice] = await Promise.all([reportMetrics(admin, c.target, kind, today.toISOString().slice(0, 10), range), voiceOf(admin, c.owner, c.r.client_id)]);
    const work = await workDone(admin, c.target, metrics.main.start, metrics.main.end);
    await admin.from("reports").update({ metrics, work }).eq("id", reportId);
    const out = await askJson<{ message: string; sections: Sections }>({
      agent: agentFor(c.r.platform),
      label: `${kind} report`,
      system: writerSystem(kind, c.r.platform),
      schema: DRAFT_SCHEMA,
      maxTokens: 12000,
      prompt: `${sourcesBlock(c, metrics, work.text, voice)}\n\nWrite the ${kind === "custom" ? `recap for ${metrics.main.label}` : `${kind} report`}.`,
    });
    await admin.from("reports").update({ message: out.message, sections: out.sections, updated_at: new Date().toISOString() }).eq("id", reportId);
    // The QA runs before the buyer hears about it, so the note they get says whether there's anything to fix
    await qaReport(admin, reportId).catch(() => null);
    await admin.from("reports").update({ status: "draft", updated_at: new Date().toISOString() }).eq("id", reportId);
  } catch (e) {
    await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", reportId);
  }
}

const REVISE_SYSTEM = `You revise a client report with the media buyer who will send it. They tell you what to change; you change exactly that, keep everything else as it was, and keep their voice. The same rules hold: every number from the data, the arc (what we did, what we're doing and why, what's next), nothing internal. If they ask for something the data or work log can't support, say so in reply and don't invent it.
reply: one or two plain sentences on what you changed. lesson: when the request is about what THIS client wants in their reports from now on ("they always want lead quality", "keep it to 5 bullets", "no CPM, they don't care"), write it as one standing preference; otherwise "". Only lasting preferences, never one-off fixes.`;
const REVISE_SCHEMA = obj({ reply: S, message: S, sections: SECTIONS, lesson: S });

/** The buyer asks for a change; the report is rewritten, the QA runs again, and a lasting preference is remembered. */
export async function reviseReport(admin: SupabaseClient, reportId: string, ask: string, by: string) {
  const c = await context(admin, reportId);
  const metrics = c.r.metrics as ReportMetrics;
  const work = ((c.r as unknown as { work?: { text?: string } }).work?.text) ?? "";
  const chat = (c.r.chat ?? []) as ChatTurn[];
  const out = await askJson<{ reply: string; message: string; sections: Sections; lesson: string }>({
    agent: agentFor(c.r.platform),
    label: "revise report",
    system: `${writerSystem(c.r.kind as "weekly" | "monthly" | "custom", c.r.platform)}\n\n${REVISE_SYSTEM}`,
    schema: REVISE_SCHEMA,
    maxTokens: 12000,
    prompt: `${sourcesBlock(c, metrics, work, "")}\n\n<current_message>\n${c.r.message ?? ""}\n</current_message>\n<current_sections>\n${JSON.stringify(c.r.sections ?? {})}\n</current_sections>\n\n<conversation>\n${chat
      .slice(-10)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe buyer asks: ${ask.trim().slice(0, 2000)}`,
  });
  const now = new Date().toISOString();
  const next: ChatTurn[] = [...chat, { role: "user" as const, text: ask.trim(), at: now, by }, { role: "assistant" as const, text: out.reply, at: now }].slice(-40);
  await admin.from("reports").update({ message: out.message, sections: out.sections, chat: next, updated_at: now }).eq("id", reportId);
  if (out.lesson.trim()) await rememberPref(admin, c.r.client_id, out.lesson.trim());
  const qa = await qaReport(admin, reportId).catch(() => null);
  return { chat: next, message: out.message, sections: out.sections, qa, lesson: out.lesson.trim() || null };
}

/** A standing preference for this client's reports (not repeated). */
export async function rememberPref(admin: SupabaseClient, clientId: string, note: string) {
  const { data } = await admin.from("client_report_prefs").select("notes").eq("client_id", clientId).maybeSingle();
  const notes = (data?.notes ?? []) as string[];
  if (notes.some((n) => n.toLowerCase() === note.toLowerCase())) return;
  await admin.from("client_report_prefs").upsert({ client_id: clientId, notes: [...notes, note].slice(-30), updated_at: new Date().toISOString() });
}
