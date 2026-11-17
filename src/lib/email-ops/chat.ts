import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subjectPatterns, weeklyListChange } from "@/lib/kaizen-ai/email-insights";
import { clientKlaviyo } from "@/lib/klaviyo/store";
import { auditDigest, type EmailAuditResult } from "./audit-core";
import { emailScoreOf } from "./score";

// What the client chat knows about an email client when the person is on the email team: the Klaviyo numbers and the
// email score (the same digest the audit reads), the subject line patterns and list change the Kaizen AI email tool
// uses, the latest audit and sprint, and the campaign ideas still open. It answers as the Email Strategist (the
// email_desk skill), with the email agents' core behind it.

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * What the email desk reads about the client besides Klaviyo: the shared context only (Brand Bible, what to remember)
 * and the last 45 days of Slack, email and calls. Never the full account brief, which carries ad performance and KPIs
 * the email positions are not allowed to see (the same rule as the Kaizen AI tools).
 */
export async function emailBrief(admin: SupabaseClient, clientId: string): Promise<{ name: string; text: string }> {
  const { channelBrief } = await import("@/lib/kaizen-ai/tools");
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [shared, { data: items }, { data: c }] = await Promise.all([
    channelBrief(admin, clientId),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).in("source", ["slack_external", "slack_internal", "gmail", "call"]).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(80),
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
  ]);
  const lines = (items ?? []).map((i) => `- ${String(i.occurred_at).slice(0, 10)} [${i.source}${i.author ? `, ${i.author}` : ""}] ${i.title ?? ""}: ${String(i.body ?? "").replace(/\s+/g, " ").slice(0, 600)}`);
  return { name: (c?.name as string | null) ?? "the client", text: `${shared}\n\n<last_45_days>\n${lines.join("\n")}\n</last_45_days>` };
}

/** The text block the email desk reads, or a plain note when there is no Klaviyo data yet */
export async function emailDeskBlock(admin: SupabaseClient, clientId: string): Promise<string> {
  const [k, score] = await Promise.all([clientKlaviyo(admin, clientId).catch(() => null), emailScoreOf(admin, clientId).catch(() => null)]);
  if (!k) return "<email_account>\nNo email numbers for this client yet: it is not connected, or the first sync has not finished. Say so, and say that a lead or an exec connects it on the client's Team & setup.\n</email_account>";
  const today = nyToday();
  const { data: client } = await admin.from("clients").select("name").eq("id", clientId).maybeSingle();
  const name = (client?.name as string | null) ?? "the client";
  const patterns = subjectPatterns(k.campaigns.filter((c) => c.sendTime && c.sendTime.slice(0, 10) >= shift(today, -89)));
  const list = weeklyListChange(k.daily).slice(-8);
  const [{ data: audit }, { data: sprint }, { data: ideas }] = await Promise.all([
    admin.from("email_audits").select("id, created_at, score, result, done").eq("client_id", clientId).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("email_sprints").select("id, baseline, latest, email_sprint_actions(title, status)").eq("client_id", clientId).eq("status", "active").maybeSingle(),
    admin.from("email_suggestions").select("title, idea, status, send_on").eq("client_id", clientId).in("status", ["new", "in_motion"]).order("created_at", { ascending: false }).limit(8),
  ]);
  const parts: string[] = [score ? auditDigest(name, score, k, today) : "<email_account>The email score could not be worked out yet.</email_account>"];
  parts.push(`<subject_line_patterns_90d note="send-weighted, traits with at least 3 sends">\n${patterns.map((p) => `- ${p.trait}: ${p.campaigns} sends, open ${p.open_rate_pct ?? "n/a"}%, click ${p.click_rate_pct ?? "n/a"}%, revenue per recipient ${p.revenue_per_recipient ?? "n/a"}`).join("\n") || "(too few sends)"}\n</subject_line_patterns_90d>`);
  parts.push(`<list_change_by_week>\n${list.map((w) => `- week of ${w.week_starting}: +${w.subscribed} joined, -${w.unsubscribed} left`).join("\n") || "(no list metrics)"}\n</list_change_by_week>`);
  if (audit) {
    const r = audit.result as EmailAuditResult | null;
    const ticked = Object.keys((audit.done ?? {}) as object).length;
    parts.push(`<latest_email_audit ran="${String(audit.created_at).slice(0, 10)}" score="${audit.score ?? "?"}" actions_ticked="${ticked}">\n${r?.verdict ? `Verdict: ${r.verdict.headline}. ${r.verdict.summary}\nDiagnosis: ${r.diagnosis}` : ""}\n${(r?.actions ?? []).slice(0, 8).map((a, i) => `- Action (${a.when}, ${a.owner}${(audit.done as Record<string, unknown>)?.[String(i)] ? ", done" : ""}): ${a.title}. ${a.why}`).join("\n")}\n</latest_email_audit>`);
  }
  if (sprint) {
    const acts = (sprint.email_sprint_actions ?? []) as { title: string; status: string }[];
    const b = (sprint.baseline as { score?: number } | null)?.score;
    const l = (sprint.latest as { score?: number } | null)?.score;
    parts.push(`<email_sprint score_at_start="${b ?? "?"}" score_now="${l ?? "?"}">\n${acts.map((a) => `- [${a.status}] ${a.title}`).join("\n")}\n</email_sprint>`);
  }
  if ((ideas ?? []).length) parts.push(`<open_campaign_ideas>\n${(ideas ?? []).map((i) => `- ${i.title}${i.send_on ? ` (send by ${i.send_on})` : ""} [${i.status}]: ${String(i.idea).slice(0, 220)}`).join("\n")}\n</open_campaign_ideas>`);
  return parts.join("\n\n");
}

/** The ads client desk's prompt with its ad account sections cut, and the email desk's rules in their place */
export function emailDeskSystem(adsSystem: string): string {
  const head = adsSystem.split("\nChanges in the ad account")[0].replace(/If they ask you to run an audit[^\n]*/, 'If they ask you to run an audit, say they can start one from the client\'s Email tab, under "Audit and ideas".');
  return `${head}

You are talking with the email team about this client's Klaviyo email program. You answer as Kaizen's Email Strategist: read <email_account> (the email score and its seven checks, the last 30 days against the 30 before, key flows, campaigns, lists), the subject line patterns, the list change, the latest audit, the sprint and the open campaign ideas, and argue from those numbers. Name the check and its bar when you explain the score (attributed revenue 30%, revenue per recipient $0.15, deliverability 65, campaign open 30% and click 1%, flow open 35% and click 1.5%; green from 80, yellow from 60, red under). When the data is thin, say so. Say what you would do next and who does it (the email strategist, the email designer, the email builder, the client). Nothing can be sent, edited or scheduled in Klaviyo from here: when they ask for that, say the email team makes the move in Klaviyo, and offer to put it on the audit's plan or say what to do.
Set change.wanted false and launch.wanted false with "" fields: nothing in an ad account is changed or launched from the email desk.`;
}
