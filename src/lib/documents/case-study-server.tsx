import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { monthLabel, monthlySeries, seriesText, type DailyRow, type MonthPoint } from "@/lib/case-study-data";
import { conversionFor } from "@/lib/kpi/conversions";
import { caseStudyFileName, caseStudyReady, cleanCaseStudy, type CaseStudy } from "./case-study-core";
import { CaseStudyDocument } from "./case-study";

// A client case study, written from the client's own numbers and drawn in the case-study look: the facts (each ad
// account's months from the synced daily rows, email and store revenue, the client's context), the Strategist's
// write-up (client-ready: wins first, every number true, nothing invented, no prices or next steps), then the PDF, kept
// with the client's documents like any document Kaizen OS makes.

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const SCHEMA = obj({
  title: S,
  subtitle: S,
  period: S,
  industry: S,
  summary: S,
  challenge: S,
  approach: LIST,
  results: { type: "array", items: obj({ value: S, label: S, note: S }) },
  charts: { type: "array", items: obj({ title: S, kind: { type: "string", enum: ["bar", "line"] }, unit: { type: "string", enum: ["$", "%", "x", ""] }, points: { type: "array", items: obj({ label: S, value: { type: "number" } }) }, note: S }) },
  highlights: LIST,
  quote: { type: ["object", "null"], properties: { text: S, by: S }, required: ["text", "by"], additionalProperties: false },
});

const SYSTEM = `You write a client case study for Kaizen Marketing, a performance marketing agency: a client-ready PDF the agency sends to prospects and to the client. Lead with the wins and the story of how we got them; it's marketing material, so choose what to feature (leaving out a confusing chart or a weaker metric is fine), but every number must be true and come from the data given. Never invent a number, a quote or a result.
title: the client and the headline result ("Aldecoa Coffee: purchases up 64% at a lower cost"), under 90 characters. subtitle: one line on what we did. period: the months covered ("Jun to Nov 2026"). industry: a few words.
summary: 2 or 3 sentences, who they are and what changed. challenge: where they were and what was in the way. approach: 3 to 5 short steps of what Kaizen did (from the context: campaigns, creative, offers, structure).
results: 2 to 4 headline numbers (value like "+64%", "$31.29", "4.2x"; label; a short note with the before and after).
charts: 1 to 3 charts drawn from the monthly numbers given, each with at least 3 months: points labelled by month ("Jun"), unit "$" for money, "x" for ROAS, "%" for rates. Pick the ones that tell the story (results per month, cost per result going down, revenue or ROAS going up).
highlights: up to 5 short lines worth calling out. quote: only a real quote from the client found in the context, else null.
Never include prices, fees, retainers, "price to confirm", placeholders or next steps. Plain words, no em dashes. Refer to Kaizen's people by role, never by name.`;

/** Each ad account's months, email and store revenue, as text for the writer and as series for checking the charts */
export async function caseStudyFacts(admin: SupabaseClient, clientId: string, months = 6): Promise<{ text: string; series: Record<string, MonthPoint[]> }> {
  const since = new Date(Date.now() - months * 31 * 86_400_000).toISOString().slice(0, 10);
  const { data: targets } = await admin.from("kpi_targets").select("id, platform, label, conversion, ad_account_id, target").eq("client_id", clientId).eq("active", true).in("platform", ["meta", "google"]);
  const out: string[] = [];
  const series: Record<string, MonthPoint[]> = {};
  for (const t of targets ?? []) {
    if (!t.ad_account_id) continue;
    const account = String(t.ad_account_id).replace(/^act_/, "");
    const table = t.platform === "google" ? "google_campaign_daily" : "meta_campaign_daily";
    const { data: rows } = await admin.from(table).select("date, campaign_id, campaign_name, spend, actions, action_values").eq("ad_account_id", account).gte("date", since).limit(20000);
    const conv = conversionFor(String(t.conversion ?? ""));
    let daily = (rows ?? []) as DailyRow[];
    let types = t.platform === "google" ? ["conversions"] : (conv.types ?? []);
    // "Each campaign's own goal": counted the way the KPI board does (each campaign's goal, else its strongest result)
    if (conv.key === "campaign_goal") {
      const [{ toDays }, { goalsFor }] = await Promise.all([import("@/lib/kpi/calc"), import("@/lib/kpi/sync")]);
      const goals = await goalsFor(admin, account, String(t.platform));
      daily = toDays((rows ?? []) as Parameters<typeof toDays>[0], null, null, goals, String(t.platform)).map((d) => ({ date: d.date, spend: d.spend, actions: { campaign_goal: d.actions.campaign_goal ?? 0 }, action_values: { campaign_goal: d.values.campaign_goal ?? 0 } }));
      types = ["campaign_goal"];
    }
    const s = monthlySeries(daily, types);
    const key = `${t.platform === "google" ? "google_ads" : "meta_ads"}${t.label ? `_${String(t.label).replace(/\W+/g, "_")}` : ""}`;
    series[key] = s;
    out.push(seriesText(key, s, conv.key === "campaign_goal" ? "results (each campaign's own goal)" : conv.label.toLowerCase()));
  }
  const [{ data: email }, { data: store }] = await Promise.all([
    admin.from("klaviyo_daily").select("date, revenue").eq("client_id", clientId).gte("date", since).limit(400),
    admin.from("client_business_daily").select("date, revenue, orders, leads").eq("client_id", clientId).gte("date", since).limit(400),
  ]);
  const monthSum = (rows: { date: string; revenue?: number | string | null }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r.date).slice(0, 7), (m.get(String(r.date).slice(0, 7)) ?? 0) + (Number(r.revenue) || 0));
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  };
  const e = monthSum((email ?? []) as { date: string; revenue: number }[]);
  if (e.some(([, v]) => v > 0)) out.push(`<email_revenue_by_month>\n${e.map(([m, v]) => `- ${m} (${monthLabel(m)}): $${v.toFixed(0)}`).join("\n")}\n</email_revenue_by_month>`);
  const st = monthSum((store ?? []) as { date: string; revenue: number }[]);
  if (st.some(([, v]) => v > 0)) out.push(`<store_revenue_by_month>\n${st.map(([m, v]) => `- ${m} (${monthLabel(m)}): $${v.toFixed(0)}`).join("\n")}\n</store_revenue_by_month>`);
  return { text: out.filter(Boolean).join("\n\n"), series };
}

/** The Strategist writes the case study from the facts and the client's context; notes are what the person asked for */
export async function writeCaseStudy(admin: SupabaseClient, client: { id: string; name: string }, notes: string): Promise<CaseStudy> {
  const [{ text: numbers }, brief] = await Promise.all([caseStudyFacts(admin, client.id), import("@/lib/handoff").then((m) => m.accountBrief(admin, client.id, null)).then((b) => b.text.slice(0, 60_000)).catch(() => "")]);
  const raw = await askJson<Record<string, unknown>>({
    agent: "strategist",
    label: "case study",
    clientId: client.id,
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 8000,
    prompt: `<client>${client.name}</client>\n\n<monthly_numbers note="the only numbers you may use">\n${numbers || "none synced"}\n</monthly_numbers>\n\n<context>\n${brief}\n</context>${notes ? `\n\n<what_they_asked_for>\n${notes}\n</what_they_asked_for>` : ""}\n\nWrite the case study for ${client.name}.`,
  });
  return cleanCaseStudy({ ...raw, client: client.name }, { client: client.name });
}

export type MadeCaseStudy = { id: string; version: number; title: string; fileName: string; href: string; download: string; client: string; bytes: Uint8Array };

/** Draws the case study and keeps it with the client's documents (a new version of `id` when given) */
export async function makeCaseStudy(admin: SupabaseClient, me: { id: string }, client: { id: string; name: string }, cs: CaseStudy, id?: string | null): Promise<MadeCaseStudy> {
  if (!caseStudyReady(cs)) throw new Error("The case study has nothing to show yet: it needs a title, the story and at least one number.");
  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, mark] = await Promise.all([reportBrand(admin, client.id).catch(() => null), agencyLogo()]);
  const pdf = new Uint8Array(await renderToBuffer(<CaseStudyDocument input={{ cs, brand: { logo: brand?.logo ?? null, agencyLogo: mark } }} />));
  const prior = id ? await admin.from("kaizen_documents").select("id, version, client_document_id").eq("id", id).maybeSingle() : { data: null };
  const docId = (prior.data?.id as string | undefined) ?? crypto.randomUUID();
  const version = Number(prior.data?.version ?? 0) + 1;
  const fileName = caseStudyFileName(cs);
  const path = `${client.id}/kaizen/${docId}/v${version}.pdf`;
  const { error } = await admin.storage.from("client-docs").upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Couldn't save the case study: ${error.message}`);
  const entry = { client_id: client.id, kind: "file", name: fileName, path, mime: "application/pdf", bytes: pdf.length, title: `Case study: ${cs.title}`.slice(0, 200), summary: cs.summary.slice(0, 600) || null, text: [cs.title, cs.summary, cs.challenge, ...cs.approach, ...cs.results.map((r) => `${r.value} ${r.label}`), ...cs.highlights].join("\n"), status: "ready", via: "assistant", uploaded_by: me.id };
  let clientDocId = (prior.data?.client_document_id as string | null | undefined) ?? null;
  if (clientDocId) await admin.from("client_documents").update(entry).eq("id", clientDocId);
  else clientDocId = ((await admin.from("client_documents").insert(entry).select("id").single()).data?.id as string | undefined) ?? null;
  const now = new Date().toISOString();
  const { error: saveErr } = await admin.from("kaizen_documents").upsert({ id: docId, client_id: client.id, profile_id: me.id, kind: "case_study", title: cs.title, content: cs, bucket: "client-docs", path, file_name: fileName, version, placeholders: [], client_document_id: clientDocId, updated_at: now });
  if (saveErr) throw new Error(`Couldn't keep the case study: ${saveErr.message}`);
  const href = `/api/documents/${docId}`;
  return { id: docId, version, title: cs.title, fileName, href, download: `${href}?download=1`, client: client.name, bytes: pdf };
}
