import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock, type AgentKey } from "@/lib/ai";
import type { AuditResult } from "@/lib/audit";
import type { BusinessAuditResult } from "@/lib/business-audit";
import { businessItemPlatform, platformOf, type RebutPlatform } from "@/lib/rebut-permission";

// "Why?" on an audit item, a sprint move or a Google idea plan: execs, leads and buyers ask the agent that wrote it
// why it recommended this, and it answers from the audit's own numbers (or the winner the plan is built on) and the
// client page. Meta items are answered by the auditor, Google ones by the Google auditor (a Google idea plan by the
// Google launcher that wrote it). Team only, never shown to clients. When someone disagrees and explains why, the agent
// offers the lesson it would take from it; teaching it goes through the audit pushback loop
// (src/lib/audit-rebuttals.ts), so the next audits of the client learn it. Who may teach depends on the item's
// platform (src/lib/rebut-permission.ts).

export type WhyKind = "account" | "business" | "sprint" | "deploy";
export type WhyMessage = { id: string; role: "person" | "agent"; body: string; by: string | null; at: string; lesson: string | null; taught: boolean };

/** What one item is, where its numbers are, which agent wrote it, and where a lesson from it is kept */
type Item = {
  clientId: string;
  agent: AgentKey;
  /** The ad platform it's about: decides who may teach the agent from it */
  platform: RebutPlatform;
  title: string;
  text: string;
  summary: string;
  numbers: string;
  /** The audit finding a lesson attaches to, or the Google idea plan (null when the move didn't come from an audit) */
  teach: { kind: "account" | "business"; auditId: string; itemKey: string; finding: string } | { kind: "deploy"; deployId: string; finding: string } | null;
};

/** One item of an audit result by its key (action:3, cause:0, creative:1, test:2, watchout:1, channel:meta, verdict, budget) */
function pick(r: AuditResult | BusinessAuditResult, key: string): { title: string; text: string } | null {
  const [kind, raw] = key.split(":");
  const i = Number(raw);
  const res = r as AuditResult & BusinessAuditResult;
  const at = <T>(xs: T[] | undefined) => (Number.isInteger(i) ? (xs ?? [])[i] : undefined);
  const as = (title: string | undefined, x: unknown) => (title ? { title, text: JSON.stringify(x, null, 1) } : null);
  if (kind === "verdict") return as(r.verdict.headline, { verdict: r.verdict, diagnosis: r.diagnosis });
  if (kind === "budget") return res.budget ? as(res.budget.call, res.budget) : null;
  if (kind === "action") {
    const x = at(res.actions);
    // The IDs are ours, not the model's: leave them out of what it reads
    return x ? as(x.title, { ...x, objects: (x.objects ?? []).map((o) => `${o.type} "${o.name}"`) }) : null;
  }
  if (kind === "cause") return as(at(res.causes)?.title, at(res.causes));
  if (kind === "watchout") return as(at(res.watchouts)?.title, at(res.watchouts));
  if (kind === "test") return as(at(res.tests)?.name, at(res.tests));
  if (kind === "creative") return as(at(res.creative)?.concept, at(res.creative));
  // The creative analysis: its read, and the top and bottom ads it ranked (names and numbers, no pictures)
  if (kind === "creative-analysis" && res.creativeAnalysis) {
    const c = res.creativeAnalysis;
    const brief = (xs: typeof c.top) => xs.map((x) => ({ name: x.name, headline: x.headline, spend: x.spend, share: x.share, cpa: x.cpa, roas: x.roas, ctr: x.ctr, hookRate: x.hookRate, holdRate: x.holdRate, watchPct: x.watchPct, angle: x.angle, avatar: x.avatar, format: x.format, fatigue: x.fatigue }));
    return as(c.read?.common?.[0] ?? "Creative analysis", { read: c.read, average: c.average, target: c.target, top: brief(c.top), bottom: brief(c.bottom), traits: c.traits, fatiguing: c.fatiguing, gaps: c.gaps });
  }
  if (kind === "creative-analysis" && res.googleCreative) {
    const g = res.googleCreative;
    return as(g.read?.common?.[0] ?? "Creative analysis", { read: g.read, headlines: g.headlines, descriptions: g.descriptions, groups: g.groups, themes: g.themes, low: g.low });
  }
  if (kind === "channel") {
    const c = (res.channels ?? []).find((x) => x.channel === raw);
    return as(c?.headline, c);
  }
  return null;
}

const summaryOf = (r: AuditResult | BusinessAuditResult) => `${r.verdict.headline}\n${r.verdict.summary}\n\n${r.diagnosis}`;

/** The item, read with the access given (the viewer's own session, so only what they can see) */
export async function whyItem(db: SupabaseClient, kind: WhyKind, auditId: string, itemKey: string): Promise<Item | null> {
  if (kind === "account") {
    const { data: a } = await db.from("account_audits").select("client_id, result, numbers, inputs, kpi_targets(platform)").eq("id", auditId).maybeSingle();
    const r = a?.result as AuditResult | null;
    const it = r ? pick(r, itemKey) : null;
    if (!a || !r || !it) return null;
    const platform = platformOf((a.kpi_targets as unknown as { platform: string } | null)?.platform);
    return { clientId: a.client_id as string, agent: platform === "google" ? "google_auditor" : "auditor", platform, ...it, summary: summaryOf(r), numbers: (a.numbers as string | null) ?? "", teach: { kind: "account", auditId, itemKey, finding: it.title } };
  }
  if (kind === "business") {
    const { data: b } = await db.from("business_audits").select("client_id, result, numbers").eq("id", auditId).maybeSingle();
    const r = b?.result as BusinessAuditResult | null;
    const it = r ? pick(r, itemKey) : null;
    if (!b || !r || !it) return null;
    // A Google item (its channel, cause or action) is the Google auditor's; the rest the auditor's
    const platform = businessItemPlatform(r, itemKey);
    return { clientId: b.client_id as string, agent: platform === "google" ? "google_auditor" : "auditor", platform, ...it, summary: summaryOf(r), numbers: (b.numbers as string | null) ?? "", teach: { kind: "business", auditId, itemKey, finding: it.title } };
  }
  if (kind === "deploy") {
    // A Google idea taken to this client: the plan the Google launcher wrote, and the winner it's built on
    const { data: d } = await db.from("google_deploys").select("client_id, kind, note, plan, idea, status").eq("id", auditId).maybeSingle();
    const plan = d?.plan as { summary?: string; why?: string } | null;
    if (!d || !plan || itemKey !== "plan") return null;
    const title = plan.summary || "The plan for this Google idea";
    return {
      clientId: d.client_id as string,
      agent: "google_launcher",
      platform: "google",
      title,
      text: JSON.stringify({ kind: d.kind, status: d.status, asked_for: d.note, plan }, null, 1),
      summary: plan.why ?? "",
      numbers: `<the_winner_it_is_built_on>\n${JSON.stringify(d.idea, null, 1)}\n</the_winner_it_is_built_on>`,
      teach: { kind: "deploy", deployId: auditId, finding: title },
    };
  }
  // A sprint move: its own words, and the audit it came from for the numbers
  const { data: s } = await db
    .from("sprint_actions")
    .select("id, title, steps, why, impact, watch, source, audit_index, business_audit_id, objects, optimization_sprints(client_id, audit_id, kpi_targets(platform))")
    .eq("id", auditId)
    .maybeSingle();
  if (!s) return null;
  const sp = s.optimization_sprints as unknown as { client_id: string; audit_id: string | null; kpi_targets: { platform: string } | null } | null;
  if (!sp) return null;
  const platform = platformOf(sp.kpi_targets?.platform);
  const fromBusiness = s.source === "business_audit" && s.business_audit_id;
  const auditFrom = fromBusiness ? (s.business_audit_id as string) : sp.audit_id;
  const { data: src } = auditFrom ? await db.from(fromBusiness ? "business_audits" : "account_audits").select("result, numbers").eq("id", auditFrom).maybeSingle() : { data: null };
  const r = src?.result as AuditResult | BusinessAuditResult | null;
  const text = JSON.stringify({ title: s.title, steps: s.steps, why: s.why, impact: s.impact, how_the_daily_check_judges_it: s.watch, objects: ((s.objects ?? []) as { type: string; name: string }[]).map((o) => `${o.type} "${o.name}"`) }, null, 1);
  // A move from an audit teaches that audit's finding; one the buyer added teaches the account audit behind the sprint
  const itemKeyThere = s.source !== "buyer" && s.audit_index != null ? `action:${s.audit_index}` : `sprint:${s.id}`;
  return {
    clientId: sp.client_id,
    // A Google sprint's moves are the Google auditor's, even the ones the business audit added
    agent: platform === "google" ? "google_auditor" : "auditor",
    platform,
    title: s.title as string,
    text,
    summary: r ? summaryOf(r) : "",
    numbers: (src?.numbers as string | null) ?? "",
    teach: auditFrom ? { kind: fromBusiness ? "business" : "account", auditId: auditFrom, itemKey: itemKeyThere, finding: s.title as string } : null,
  };
}

/** One item's thread, oldest first */
export async function whyThread(db: SupabaseClient, auditId: string, itemKey: string): Promise<WhyMessage[]> {
  const { data } = await db.from("audit_item_messages").select("id, role, body, lesson, taught_at, created_at, profiles!audit_item_messages_author_id_fkey(full_name)").eq("audit_id", auditId).eq("item_key", itemKey).order("created_at").limit(200);
  return (data ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as WhyMessage["role"],
    body: m.body as string,
    by: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    at: m.created_at as string,
    lesson: (m.lesson as string | null) || null,
    taught: Boolean(m.taught_at),
  }));
}

/** How many messages each item of an audit (or each sprint move) has, for the "Why?" buttons */
export async function whyCounts(db: SupabaseClient, auditIds: string[]): Promise<Record<string, number>> {
  if (!auditIds.length) return {};
  const { data } = await db.from("audit_item_messages").select("audit_id, item_key").in("audit_id", auditIds).limit(5000);
  const out: Record<string, number> = {};
  for (const m of data ?? []) out[`${m.audit_id}|${m.item_key}`] = (out[`${m.audit_id}|${m.item_key}`] ?? 0) + 1;
  return out;
}

const SYSTEM = `You wrote this audit item: the audit of this client's account (or whole business) and the plan built from it. Someone on the Kaizen team (an exec, a lead or the account's buyer) is asking about one item: why you recommended it, what it's based on, or they disagree. Answer as the auditor who wrote it, in the first person ("I saw", "I'd"), plain and direct, to a senior media buyer.
Argue from the audit's own numbers you're given: quote the exact figures, campaigns, ad sets or ads behind the item, and the client page when it matters (their rules, what they told us, client memory). Say plainly when the numbers are thin or when the item went further than the data supports. Never invent a number that isn't in what you were given.
Keep it short: 2 to 6 sentences, or a few short lines when listing evidence. No headings.
When the person disagrees and gives a reason (something about the account, the client or the business you didn't weigh, or a read of the data that holds up), take it seriously: say whether it changes your call and what you'd do instead. If it's a lasting lesson for future audits of this client, set disagrees true and write lesson: one sentence written as a conditional rule the next audit can follow ("When the account runs a seasonal promo, don't read its first week's CPA against target; wait for 14 days"), true beyond this week, no numbers that will go stale, no names. Otherwise disagrees false and lesson empty. If they're wrong, say why with the numbers, kindly, and leave lesson empty.
Refer to people by role, never by name. No em dashes.`;

/** The same, for a Google item: the Google auditor names campaigns, ad groups, keywords and search terms */
const GOOGLE_SYSTEM = SYSTEM.replace("campaigns, ad sets or ads behind the item", "campaigns, ad groups, keywords or search terms behind the item (impression share, quality scores, bidding targets when they matter)");

/** A Google idea plan: the Google launcher wrote it for this client from another account's winner */
const DEPLOY_SYSTEM = `You wrote this plan: a winning Google ad, keyword or search term from another Kaizen account, taken to this client as ad copy, a campaign or keywords, from their Brand Bible, Google go-to-market strategy and the sub-vertical's Google playbook. Someone on the Kaizen team (an exec, the Head of Google or the client's Google buyer) is asking why you wrote it this way, what it's based on, or they disagree. Answer as the Google Ads buyer who wrote it, in the first person, plain and direct, to a senior Google Ads buyer.
Argue from the winner's own numbers you're given, the plan itself and the client page (their rules, offer, what they told us, client memory). Say plainly when the winner's numbers are thin for this client or when the plan reaches further than they support. Never invent a number that isn't in what you were given.
Keep it short: 2 to 6 sentences, or a few short lines when listing evidence. No headings.
When the person disagrees and gives a reason (something about the client, their market, their account or Google Ads you didn't weigh), take it seriously: say whether it changes the plan and what you'd write instead. If it's a lasting lesson for the next plans and changes you make for this client, set disagrees true and write lesson: one sentence written as a conditional rule ("When the client only serves one city, keep borrowed keywords to phrase and exact match with the city in them"), true beyond this plan, no numbers that will go stale, no names. Otherwise disagrees false and lesson empty. If they're wrong, say why, kindly, and leave lesson empty.
Refer to people by role, never by name. No em dashes.`;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, disagrees: { type: "boolean" }, lesson: { type: "string" } },
  required: ["answer", "disagrees", "lesson"],
  additionalProperties: false,
};

/** Ask the agent that wrote the item; the question and its answer are kept on the item's thread. */
export async function askWhy(admin: SupabaseClient, o: { kind: WhyKind; auditId: string; itemKey: string; item: Item; question: string; by: string }) {
  const question = o.question.trim().slice(0, 2000);
  const history = await whyThread(admin, o.auditId, o.itemKey);
  const { data: asked, error } = await admin
    .from("audit_item_messages")
    .insert({ client_id: o.item.clientId, audit_kind: o.kind, audit_id: o.auditId, item_key: o.itemKey, role: "person", body: question, author_id: o.by })
    .select("id, created_at")
    .single();
  if (error || !asked) throw new Error(error?.message ?? "Couldn't save the question.");
  const ctx = await clientContext(admin, o.item.clientId);
  const out = await askJson<{ answer: string; disagrees: boolean; lesson: string }>({
    agent: o.item.agent,
    label: "audit why",
    clientId: o.item.clientId,
    system: o.kind === "deploy" ? DEPLOY_SYSTEM : o.item.platform === "google" ? GOOGLE_SYSTEM : SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    // Someone is waiting on it: think, but not for minutes
    override: { effort: "medium" },
    prompt: `${ctx ? contextBlock(ctx) : ""}

<what_the_audit_read>
${o.item.numbers || "(the numbers this audit read weren't kept: it ran before they were stored; answer from the item and the audit's summary, and say so if a number is needed)"}
</what_the_audit_read>

<${o.kind === "deploy" ? "why_the_plan_said" : "the_audit_said"}>
${o.item.summary}
</${o.kind === "deploy" ? "why_the_plan_said" : "the_audit_said"}>

<the_item>
${o.item.text}
</the_item>
${history.length ? `\n<the_thread_so_far>\n${history.map((m) => `${m.role === "agent" ? "You" : "Team"}: ${m.body}`).join("\n\n")}\n</the_thread_so_far>\n` : ""}
Team: ${question}`,
  });
  const clean = (s: string) => s.replace(/\s*—\s*/g, ", ").trim();
  const lesson = out.disagrees && o.item.teach ? clean(out.lesson).slice(0, 1000) : "";
  const { data: answered } = await admin
    .from("audit_item_messages")
    .insert({ client_id: o.item.clientId, audit_kind: o.kind, audit_id: o.auditId, item_key: o.itemKey, role: "agent", body: clean(out.answer).slice(0, 6000), lesson: lesson || null })
    .select("id, created_at")
    .single();
  return { askedId: asked.id as string, answerId: (answered?.id as string | undefined) ?? null, answer: clean(out.answer), lesson: lesson || null, at: (answered?.created_at as string | undefined) ?? new Date().toISOString() };
}
