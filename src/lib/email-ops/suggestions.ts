import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { LIVE } from "@/lib/live";
import { clientKlaviyo } from "@/lib/klaviyo/store";
import { emailBrief } from "./chat";
import { performanceFacts, performanceText, pickMentions, SUGGEST_SCHEMA, toRows, upcomingMoments, type ContextItem, type Draft } from "./suggest-core";

// Campaign suggestions for an email client, written by the Email Strategist (the email_calendar skill) from three
// things: what past sends say worked (subject styles, offers, days, audiences), the moments coming up (holidays and
// seasons), and what the client has mentioned in Slack, email and calls (a launch, a promo, an event). Each one keeps the
// words it came from with a link, and is tracked in the app: new, in motion, done or dismissed, and whether it worked.
// The Email Designer (email_copy) adds subject line options. Nothing is built, sent or scheduled anywhere.

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
export const REFRESH_DAYS = 7;
const PER_RUN = 3;
const MAX_NEW = 6;

const SYSTEM = `You are Kaizen Marketing's Email Strategist, suggesting the next campaigns for one client's email program. Your reader is the email strategist who sends them.
You are given what past campaigns say worked (by subject style, send day, offer type and audience, with the number of sends behind each), the moments coming up, what the client has mentioned lately in Slack, email and calls (numbered), the suggestions already made, and the client page (Brand Bible, memory, calls).
Suggest up to ${MAX_NEW} campaigns worth sending, best first. Each is one campaign in a few sentences: the offer or angle, who gets it (name a real audience from the data when there is one), and the day it should go (sendOn, YYYY-MM-DD, never in the past; "" when it is not tied to a day).
origin: "performance" when it rests on what past sends proved; "calendar" when it is tied to one of the moments (set momentKey to that moment's key); "mention" when the client said something about a launch, promo or event (set mention to its number). A suggestion that rests on more than one still has one origin: pick the main one. Set momentKey "" and mention 0 when they do not apply.
evidence: 1 to 3 short lines with the real numbers or words behind the idea ("Question subjects opened 38% across 9 sends against a 29% baseline"). why: one sentence on why now.
Rules: use only the numbers given and never invent a benchmark or a result; a pattern with a handful of sends is a hint, say so. Do not repeat or lightly reword a suggestion already made. Respect the client's rules (claims to avoid, regulated categories) and never recommend sending harder to a list that is bouncing, complaining or unsubscribing. Never suggest an offer the client has not offered or mentioned: suggest testing the angle and let the client decide the price. A mention must really be about a campaign-worthy thing; skip small talk. Refer to people by role, never by name. No em dashes.`;

type Out = { suggestions: Draft[] };

/** Writes the client's next suggestions. Returns how many were new. Never throws for a missing Klaviyo (it says why). */
export async function generateSuggestions(admin: SupabaseClient, clientId: string): Promise<{ added: number; note?: string }> {
  const today = nyToday();
  const markState = (error: string | null) => admin.from("email_ops_state").upsert({ client_id: clientId, suggestions_at: new Date().toISOString(), suggestions_error: error, updated_at: new Date().toISOString() });
  const k = await clientKlaviyo(admin, clientId).catch(() => null);
  if (!k) return { added: 0, note: "No Klaviyo numbers yet: connect Klaviyo and let the first sync finish." };

  const [{ data: client }, { data: items }, { data: have }, ctx] = await Promise.all([
    admin.from("clients").select("name, industry, industry_detail, website").eq("id", clientId).maybeSingle(),
    admin.from("context_items").select("id, source, occurred_at, author, title, body, url").eq("client_id", clientId).in("source", ["slack_external", "slack_internal", "gmail", "call"]).gte("occurred_at", new Date(Date.now() - 45 * 86_400_000).toISOString()).order("occurred_at", { ascending: false }).limit(400),
    admin.from("email_suggestions").select("title, dedupe_key, status").eq("client_id", clientId).order("created_at", { ascending: false }).limit(80),
    emailBrief(admin, clientId).catch(() => null),
  ]);
  const facts = performanceFacts(k.campaigns.map((c) => ({ subject: c.subject, name: c.name, channel: c.channel, sendTime: c.sendTime, recipients: c.recipients, openRate: c.openRate, clickRate: c.clickRate, revenue: c.revenue, audiences: c.audiences })));
  const moments = upcomingMoments(today);
  const mentions = pickMentions((items ?? []) as ContextItem[]);
  const already = new Set(((have ?? []) as { dedupe_key: string | null }[]).map((h) => h.dedupe_key).filter((x): x is string => Boolean(x)));
  const name = (client?.name as string | null) ?? "the client";

  const out = await askJson<Out>({
    agent: "email_calendar",
    label: "email campaign suggestions",
    clientId,
    system: SYSTEM,
    schema: SUGGEST_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 12000,
    prompt: `Today is ${today}. Client: ${name}${client?.industry_detail || client?.industry ? ` (${client?.industry_detail ?? client?.industry})` : ""}.\n\n<past_sends sends="${facts.sends}">\n${performanceText(facts)}\n</past_sends>\n\n<moments_coming_up>\n${moments.map((m) => `- key ${m.key}: ${m.name} on ${m.date} (${m.note})`).join("\n") || "(none in the next weeks)"}\n</moments_coming_up>\n\n<client_mentions note="what the client said lately; quote nothing yourself, cite the number">\n${mentions.map((m) => `[${m.n}] ${m.at.slice(0, 10)} ${m.origin}${m.who ? ` (${m.who})` : ""}: ${m.text}`).join("\n") || "(nothing about promotions or launches)"}\n</client_mentions>\n\n<already_suggested>\n${((have ?? []) as { title: string; status: string }[]).slice(0, 30).map((h) => `- ${h.title} [${h.status}]`).join("\n") || "(none)"}\n</already_suggested>\n\n${ctx?.text ?? ""}\n\nSuggest the next campaigns for ${name}.`,
  });

  const rows = toRows(out.suggestions ?? [], mentions, moments, today, already);
  // Subject line options from the Email Designer, in the client's voice (best effort: a miss leaves none)
  const subjects = await subjectOptions(admin, clientId, name, rows.map((r) => ({ title: r.title, idea: r.idea })), facts, ctx?.text ?? "").catch(() => [] as string[][]);
  let added = 0;
  for (const [i, r] of rows.entries()) {
    const { error } = await admin.from("email_suggestions").insert({ client_id: clientId, ...r, subjects: subjects[i] ?? [] });
    // The same moment or idea already exists (the unique key): fine
    if (!error) added++;
    else if (error.code !== "23505") console.error("email suggestion", error.message);
  }
  await markState(null);
  return { added };
}

/** Three subject line options for each suggestion (the Email Designer's email_copy skill) */
async function subjectOptions(admin: SupabaseClient, clientId: string, name: string, ideas: { title: string; idea: string }[], facts: ReturnType<typeof performanceFacts>, context: string): Promise<string[][]> {
  if (!ideas.length) return [];
  const out = await askJson<{ options: { n: number; subjects: string[] }[] }>({
    agent: "email_copy",
    label: "email subject line options",
    clientId,
    system:
      "You are Kaizen Marketing's Email Designer. For each campaign idea, write 3 subject line options in the client's voice, each a different angle, within the client's rules about claims. Lean on the subject styles that did well for this client and avoid the ones that did badly; keep each under 55 characters unless the data says longer works. No bait, no misleading claims, no all caps. Refer to people by role, never by name. No em dashes.",
    schema: { type: "object", properties: { options: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, subjects: { type: "array", items: { type: "string" } } }, required: ["n", "subjects"], additionalProperties: false } } }, required: ["options"], additionalProperties: false },
    maxTokens: 4000,
    prompt: `Client: ${name}.\n\n<what_worked>\n${performanceText(facts)}\n</what_worked>\n\n${context}\n\n<ideas>\n${ideas.map((d, i) => `${i + 1}. ${d.title}: ${d.idea}`).join("\n")}\n</ideas>\n\nWrite the subject options for each idea by number.`,
  });
  return ideas.map((_, i) => (out.options.find((o) => o.n === i + 1)?.subjects ?? []).map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 3));
}

/** The scheduled step: a few connected clients whose suggestions are a week old (or never written), oldest first */
export async function refreshSuggestions(admin: SupabaseClient, budgetMs = 500_000) {
  const until = Date.now() + budgetMs;
  const { data: conns } = await admin.from("klaviyo_connections").select("client_id, clients!inner(archived_at, status)").eq("status", "active").is("clients.archived_at", null).in("clients.status", [...LIVE]);
  const ids = ((conns ?? []) as { client_id: string }[]).map((c) => c.client_id);
  if (!ids.length) return { due: 0, ran: 0 };
  const { data: state } = await admin.from("email_ops_state").select("client_id, suggestions_at").in("client_id", ids);
  const at = new Map((state ?? []).map((s) => [s.client_id as string, (s.suggestions_at as string | null) ?? ""]));
  const stale = new Date(Date.now() - REFRESH_DAYS * 86_400_000).toISOString();
  const due = ids.filter((id) => !(at.get(id) ?? "") || (at.get(id) as string) < stale).sort((a, b) => (at.get(a) ?? "").localeCompare(at.get(b) ?? ""));
  let ran = 0;
  for (const id of due.slice(0, PER_RUN)) {
    if (Date.now() > until - 150_000) break;
    try {
      await generateSuggestions(admin, id);
    } catch (e) {
      // Remember the miss so one broken client does not block the others every hour
      await admin.from("email_ops_state").upsert({ client_id: id, suggestions_at: new Date().toISOString(), suggestions_error: (e instanceof Error ? e.message : String(e)).slice(0, 300), updated_at: new Date().toISOString() });
    }
    ran++;
  }
  return { due: due.length, ran };
}
