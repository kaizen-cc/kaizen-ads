import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { metricsText, reportMetrics, type ReportMetrics } from "@/lib/reports/metrics";

// The client's live dashboard in their portal: every account we run for them (Meta, Google), for any dates they pick,
// counted exactly as their reports count it (each campaign's own result), with the period before to compare, day by
// day, campaign by campaign and their best ads. Reports are the story; this is where they can dig in. They can ask
// about the numbers; a question that shows a worry ("why did conversions drop?") goes to their buyer.

export type DashboardPart = {
  platform: "meta" | "google";
  conversion: string;
  target: number | null;
  roasKpi: boolean;
  main: ReportMetrics["main"];
  compare: ReportMetrics["compare"];
  daily: NonNullable<ReportMetrics["daily"]>;
  campaigns: { name: string; spend: number; results: number; costPerResult: number | null; roas: number | null; ctr: number | null; result: string | null }[];
  topAds: { id: string; name: string; spend: number; results: number; costPerResult: number | null; ctr: number | null; link: string | null; image: string | null; body: string | null; headline: string | null; cta: string | null; url: string | null }[];
};

/** Every day we have, per account: any range's hero, tiles and chart are drawn from this in the browser, instantly */
export type DashboardHistory = { start: string; firstData: string | null; parts: { platform: "meta" | "google"; conversion: string; target: number | null; roasKpi: boolean; daily: DashboardPart["daily"] }[] };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const after = (d: string) => ymd(new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000));

export async function dashboardData(admin: SupabaseClient, clientId: string, range: { start: string; end: string }): Promise<DashboardPart[]> {
  const { data: targets } = await admin
    .from("kpi_targets")
    .select("id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, target, monthly_budget, excluded_campaigns, campaign_results")
    .eq("client_id", clientId)
    .eq("active", true)
    .not("ad_account_id", "is", null);
  const parts = await Promise.all(
    (targets ?? []).map(async (t) => {
      const m = await reportMetrics(admin, t as never, "custom", after(range.end), range, { daily: true }).catch(() => null);
      if (!m) return null;
      return {
        platform: m.platform,
        conversion: m.conversion,
        target: m.target,
        roasKpi: m.roasKpi,
        main: m.main,
        compare: m.compare,
        daily: m.daily ?? [],
        campaigns: m.campaigns.slice(0, 25).map((c) => ({ name: c.name, spend: c.spend, results: c.results, costPerResult: c.costPerResult, roas: c.roas, ctr: c.ctr, result: c.result ?? null })),
        topAds: m.topAds.map((a) => ({ id: a.id, name: a.name, spend: a.spend, results: a.results, costPerResult: a.costPerResult, ctr: a.ctr, link: a.link, image: a.image, body: a.copy?.body ?? null, headline: a.copy?.headline ?? null, cta: a.copy?.cta ?? null, url: a.copy?.url ?? null })),
      } satisfies DashboardPart;
    }),
  );
  return parts.filter((p): p is DashboardPart => Boolean(p)).sort((a, b) => (a.platform === "meta" ? -1 : 1) - (b.platform === "meta" ? -1 : 1));
}

/**
 * Two years of days (or since the data starts), per account, and when we started with them: the first day a campaign
 * we named (Kaizen in its name) spent, else the first day of data, else when they were added.
 */
export async function dashboardHistory(admin: SupabaseClient, clientId: string): Promise<DashboardHistory> {
  const { accountRows } = await import("@/lib/kpi/sync");
  const [{ data: c }, { data: targets }] = await Promise.all([
    admin.from("clients").select("created_at, reonboarded_at").eq("id", clientId).single(),
    admin
      .from("kpi_targets")
      .select("id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, target, monthly_budget, excluded_campaigns, campaign_results")
      .eq("client_id", clientId)
      .eq("active", true)
      .not("ad_account_id", "is", null),
  ]);
  const yesterday = ymd(new Date(Date.now() - 86_400_000));
  const from = ymd(new Date(Date.now() - 730 * 86_400_000));
  let ours: string | null = null;
  let first: string | null = null;
  const parts = await Promise.all(
    (targets ?? []).map(async (t) => {
      const rows = (await accountRows(admin, t.ad_account_id as string, t.platform === "google" ? "google" : "meta").catch(() => [])) as { date: string; spend: number | string; campaign_name: string | null }[];
      for (const r of rows) {
        if (!(Number(r.spend) > 0) || r.date < from) continue;
        if (!first || r.date < first) first = r.date;
        if (/kaizen|kzn/i.test(r.campaign_name ?? "") && (!ours || r.date < ours)) ours = r.date;
      }
      const m = await reportMetrics(admin, t as never, "custom", after(yesterday), { start: from, end: yesterday }, { lite: true, daily: true }).catch(() => null);
      return m ? { platform: m.platform, conversion: m.conversion, target: m.target, roasKpi: m.roasKpi, daily: m.daily ?? [] } : null;
    }),
  );
  const added = ((c?.reonboarded_at ?? c?.created_at) as string | undefined)?.slice(0, 10) ?? yesterday;
  return {
    start: ours ?? first ?? added,
    firstData: first,
    parts: parts.filter((p): p is NonNullable<typeof p> => Boolean(p)).sort((a, b) => (a.platform === "meta" ? -1 : 1) - (b.platform === "meta" ? -1 : 1)),
  };
}

const S = { type: "string" };
const SCHEMA = { type: "object", properties: { answer: S, flag: { type: "boolean" }, topic: S }, required: ["answer", "flag", "topic"], additionalProperties: false };

/** A client's question about their numbers, answered from the dashboard's data; a worry goes to their buyer */
export async function askDashboard(admin: SupabaseClient, clientId: string, who: { name: string; contactId: string | null }, question: string, range: { start: string; end: string }) {
  const [{ data: c }, parts, { data: b }, { data: earlier }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    dashboardData(admin, clientId, range),
    admin.from("client_brand_bibles").select("read_this_first").eq("client_id", clientId).maybeSingle(),
    admin.from("dashboard_questions").select("question, answer").eq("client_id", clientId).order("created_at", { ascending: false }).limit(6),
  ]);
  if (!c) throw new Error("Not found");
  const numbers = parts.map((p) => `<account platform="${p.platform}">\n${metricsText({ ...p, kind: "custom", mtd: null, mtdCompare: null, monthlyBudget: null, dataThrough: null, gaps: [], campaigns: p.campaigns, topAds: [] } as unknown as ReportMetrics)}\nBy day: ${p.daily.map((d) => `${d.date} $${d.spend} ${d.results}`).join("; ")}\n</account>`).join("\n");
  const out = await askJson<{ answer: string; flag: boolean; topic: string }>({
    agent: "reporter",
    label: `client dashboard question ${c.name}`,
    override: { model: "sonnet", effort: "low" },
    system: `You answer a client's question about their own ad results on their Kaizen dashboard, from the numbers given only. Plain, warm, short (two to five sentences), specific (use the numbers), honest when something is down, and never blame the client. Explain what the number means and the likely reason when the data shows it; don't promise results, dates or changes, and don't invent anything that isn't in the numbers. If it's something only their team can answer (strategy, budget, what's changing next), say their media buyer will follow up.
flag: true when the question shows a concern, frustration, confusion about performance or a request for change ("why did conversions drop?", "this seems expensive", "can we try X?"), so their buyer hears it today; false for a plain look-up. topic: when flagged, a few words for the buyer ("conversion rate drop"), else "".`,
    schema: SCHEMA,
    maxTokens: 2000,
    prompt: [
      `<client>${c.name}</client>`,
      `<dates>${range.start} to ${range.end} (compared with the same number of days before)</dates>`,
      numbers || "No ad accounts with data for these dates.",
      b?.read_this_first ? `<about_them_internal_never_quote>\n${String(b.read_this_first).slice(0, 3000)}\n</about_them_internal_never_quote>` : "",
      earlier?.length ? `<earlier_questions>\n${earlier.reverse().map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n")}\n</earlier_questions>` : "",
      `Their question: ${question.trim().slice(0, 1500)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const { data: row } = await admin
    .from("dashboard_questions")
    .insert({ client_id: clientId, contact_id: who.contactId, asked_by: who.name, question: question.trim().slice(0, 1500), answer: out.answer, range, flagged: out.flag, topic: out.topic || null })
    .select("id, question, answer, flagged, created_at")
    .single();
  if (out.flag) {
    const [{ data: buyers }, { data: leads }] = await Promise.all([
      admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
      admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
    ]);
    const ids = [...new Set([...(buyers ?? []).map((x) => x.profile_id as string), ...(leads ?? []).map((x) => x.id as string)])];
    if (ids.length)
      await admin.from("notifications").upsert(
        ids.map((id) => ({
          profile_id: id,
          kind: "client",
          title: `${c.name} is asking about ${out.topic || "their results"}`.slice(0, 200),
          body: `${who.name} asked on their dashboard: "${question.trim().slice(0, 300)}". The AI told them: ${out.answer.slice(0, 500)}`,
          href: `/clients/${c.slug}`,
          client_id: clientId,
          key: `dashboard-question:${row?.id ?? Date.now()}`,
          priority: "critical",
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
  return row;
}
