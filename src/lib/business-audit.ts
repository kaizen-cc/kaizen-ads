import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { loadClientKpis } from "@/lib/kpi/client";
import { kpiValue } from "@/lib/kpi/format";
import type { AuditResult } from "@/lib/audit";

// The whole business at once: every channel we run or have data for (Meta, Google, creative production, and what the
// client is telling us in Slack, email and calls), audited together on the client page. It reads the latest account
// audits rather than redoing them, and says where the business stands, what's behind it across channels, what to do
// and what to watch, in the same found / do / watch shape as an account audit.

export type BusinessChannel = "meta" | "google" | "creative" | "communication" | "business";
export type BusinessAuditResult = {
  verdict: { status: "off" | "at_risk" | "on_track" | "winning"; headline: string; summary: string };
  diagnosis: string;
  channels: { channel: BusinessChannel; status: "off" | "at_risk" | "on_track" | "winning" | "no_data"; headline: string; notes: string[] }[];
  causes: { title: string; channel: BusinessChannel; severity: "high" | "medium" | "low"; evidence: string[] }[];
  actions: { title: string; channel: BusinessChannel; owner: "media_buyer" | "creative" | "client" | "strategist" | "account_manager"; when: "now" | "this_week" | "next"; steps: string[]; why: string; impact: string }[];
  watchouts: { title: string; why: string }[];
  watch: string[];
  questions: string[];
};

const S = { type: "string" } as const;
const list = (items: object) => ({ type: "array", items }) as const;
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const;
const CHANNEL = { type: "string", enum: ["meta", "google", "creative", "communication", "business"] } as const;
const STATUS = ["off", "at_risk", "on_track", "winning"];

const SCHEMA = obj({
  verdict: obj({ status: { type: "string", enum: STATUS }, headline: S, summary: S }),
  diagnosis: S,
  channels: list(obj({ channel: CHANNEL, status: { type: "string", enum: [...STATUS, "no_data"] }, headline: S, notes: list(S) })),
  causes: list(obj({ title: S, channel: CHANNEL, severity: { type: "string", enum: ["high", "medium", "low"] }, evidence: list(S) })),
  actions: list(
    obj({
      title: S,
      channel: CHANNEL,
      owner: { type: "string", enum: ["media_buyer", "creative", "client", "strategist", "account_manager"] },
      when: { type: "string", enum: ["now", "this_week", "next"] },
      steps: list(S),
      why: S,
      impact: S,
    }),
  ),
  watchouts: list(obj({ title: S, why: S })),
  watch: list(S),
  questions: list(S),
});

const SYSTEM = `You are Kaizen Marketing's head of growth, auditing one client's whole business with us across every channel at once, for the team that runs it. Not one ad account: the business. Speak to the team directly, in the first person ("I found", "I'd"), plain and specific.
Read everything given: each paid channel's KPI against target and the latest account audit of it, creative production (what's moving, what's waiting on the client, the month's allotment, revisions), tiring ads, and the client page (Brand Bible, go-to-market strategy, intake, calls, Slack and email, memory).
Connect the channels: a Meta problem that is really a creative supply problem, Google limited by the same landing page, a client unhappy in Slack while the numbers look fine, budget split badly between platforms. Retention matters most: anything that puts the relationship at risk comes first.
Google: brand searches are not real winners; flag brand spend over 10% of the monthly Google budget, search impression share under 10% (not competitive: raise budget or cut keywords) and site conversion rate under 2% for ecommerce or 5% for lead gen (fix the page). Meta: a top-of-funnel ad with frequency under 1.25, good spend, an average CPM and an above-average CTR but no conversions is a conversation starter; never recommend pausing it, judge it by its ad set and campaign. Patterns across clients (patterns_across_clients): what's proven profitable for several businesses like this one. When one answers a root cause you found, recommend it as an action and cite it ("works for 3 of 4 home services businesses"), above all one this client isn't using yet; when this account is doing something marked Fails across clients, call it out.
If a channel has no data, say so (status no_data) instead of guessing. Respect the client's rules. Refer to people by role, never by name. No em dashes.

verdict: the whole business (off, at_risk, on_track, winning), a one-line headline and a 2 or 3 sentence summary.
diagnosis: 2 to 4 short paragraphs on why the business is where it is, across channels.
channels: one entry per channel (meta, google, creative, communication, and business for the overall picture: budget split, offer, site, seasonality), each with its status, a one-line headline and 1 to 4 notes with real numbers.
causes: the root causes across the business, most important first, with the channel, severity and evidence lines.
actions: 5 to 10 concrete moves, most important first, each with its channel, owner (media_buyer, creative, client, strategist or account_manager), when (now, this_week, next), short imperative steps, why and the expected impact. Name the thing; never vague.
watchouts: 2 to 5 things that could mislead us or break.
watch: the 3 to 5 numbers to watch over the next two weeks, each with the line that says it's working.
questions: what to ask the client that would change the plan.`;

const n0 = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Run one business audit (the row is made by the caller) */
export async function runBusinessAudit(admin: SupabaseClient, id: string) {
  const { data: b } = await admin.from("business_audits").select("id, client_id").eq("id", id).single();
  if (!b) return;
  const step = (s: string) => admin.from("business_audits").update({ step: s }).eq("id", id);
  try {
    await step("Reading every channel");
    const clientId = b.client_id as string;
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [ctx, { data: client }, kpis, { data: audits }, { data: requests }, { data: usage }, { data: fatigue }, { rebuttalsBlock }] = await Promise.all([
      clientContext(admin, clientId),
      admin.from("clients").select("name, services").eq("id", clientId).single(),
      loadClientKpis(admin, clientId).catch(() => []),
      admin.from("account_audits").select("target_id, created_at, result").eq("client_id", clientId).eq("status", "ready").order("created_at", { ascending: false }).limit(10),
      admin.from("board_requests").select("number, title, format, stage, stage_entered_at, created_at, launched_at, internal_rounds, client_rounds, minutes_over").eq("client_id", clientId).is("deleted_at", null).gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString()).limit(200),
      admin.from("client_allotment_usage").select("images_per_month, videos_per_month, images_used, videos_used").eq("client_id", clientId).maybeSingle(),
      admin.from("ad_fatigue").select("ad_name, severity").eq("client_id", clientId).in("state", ["open", "refreshing"]).limit(15),
      import("@/lib/audit-rebuttals"),
    ]);
    if (!ctx || !client) throw new Error("Client not found");

    // Each paid channel: its KPI against target and the latest account audit of it
    const latest = new Map<string, { created_at: string; result: AuditResult }>();
    for (const a of audits ?? []) if (!latest.has(a.target_id as string)) latest.set(a.target_id as string, { created_at: a.created_at as string, result: a.result as AuditResult });
    const paid = kpis
      .map((k) => {
        const a = latest.get(k.id);
        const d14 = k.windows.d14;
        return `<kpi platform="${k.platform}"${k.label ? ` label="${k.label}"` : ""}>
${k.conversionLabel}: target ${kpiValue(k.target, k.roas)}; 14 days ${kpiValue(d14?.value, k.roas)}${k.deviation != null ? ` (${Math.round(k.deviation * 100)}% ${k.deviation > 0 ? "worse" : "better"} than target)` : ""}; 30 days ${kpiValue(k.windows.d30?.value, k.roas)}, spend $${n0(k.windows.d30?.spend ?? 0)}; status ${k.status}${k.vsMonth != null ? `; vs last month ${Math.round(k.vsMonth * 100)}% ${k.vsMonth > 0 ? "worse" : "better"}` : ""}${k.budget ? `; monthly budget $${n0(k.budget)}` : ""}${k.pace ? `; pacing ${JSON.stringify(k.pace).slice(0, 200)}` : ""}
${a ? `Latest account audit (${a.created_at.slice(0, 10)}): ${a.result.verdict.headline}. ${a.result.verdict.summary}\nRoot causes: ${a.result.causes.map((c) => `${c.title} (${c.severity})`).join("; ")}\nIts top moves: ${a.result.actions.slice(0, 5).map((x) => x.title).join("; ")}` : "No account audit yet."}
</kpi>`;
      })
      .join("\n");

    const reqs = requests ?? [];
    const byStage = reqs.reduce<Record<string, number>>((m, r) => ((m[r.stage as string] = (m[r.stage as string] ?? 0) + 1), m), {});
    const late = reqs.filter((r) => Number(r.minutes_over) > 0 && r.stage !== "launched").length;
    const recent = reqs.filter((r) => String(r.created_at) >= since30);
    const clientRounds = recent.reduce((x, r) => x + Number(r.client_rounds ?? 0), 0);
    const creative = `<creative_production last_90_days="${reqs.length} requests">
By stage: ${Object.entries(byStage).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}. Running late: ${late}.
Last 30 days: ${recent.length} requests, ${clientRounds} rounds of client changes, ${recent.filter((r) => r.launched_at).length} launched.
${usage ? `This month's allotment: ${usage.images_used}/${usage.images_per_month ?? "no cap"} images, ${usage.videos_used}/${usage.videos_per_month ?? "no cap"} videos.` : "No creative allotment set."}
Tiring ads: ${(fatigue ?? []).map((f) => `${f.ad_name} (${f.severity})`).join("; ") || "none flagged"}.
</creative_production>`;
    const pushback = await rebuttalsBlock(admin, clientId).catch(() => "");

    await step("Auditing the whole business");
    const out = await askJson<BusinessAuditResult>({
      agent: "auditor",
      label: `business audit ${client.name}`,
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 24000,
      prompt: `${contextBlock(ctx)}

<services>${((client.services ?? []) as string[]).join(", ") || "not set"}</services>

<paid_channels>
${paid || "(no KPI targets set on any ad account)"}
</paid_channels>

${creative}
${pushback ? `\n${pushback}\n` : ""}
Today is ${new Date().toISOString().slice(0, 10)}. Audit ${client.name}'s whole business with us.`,
    });
    const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\s*—\s*/g, ", "));
    await admin
      .from("business_audits")
      .update({ status: "ready", step: null, result: clean(out), inputs: { kpis: kpis.length, accountAudits: latest.size, requests: reqs.length, fatigue: fatigue?.length ?? 0 }, finished_at: new Date().toISOString() })
      .eq("id", id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("business_audits").update({ status: "failed", step: null, error: message, finished_at: new Date().toISOString() }).eq("id", id);
  }
}
