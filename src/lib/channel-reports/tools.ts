import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiTool } from "@/lib/ai";
import { reportTools, type Pulled } from "@/lib/reports/tools";
import { shiftDay } from "@/lib/reports/period";
import { channelName, type ChannelKind, type ChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
import { loadChannelMetrics } from "./data";
import { channelMetricsText } from "./text";
import { applyStated, EMAIL_STATED, mergeStated, SOCIAL_STATED, statedFrom, type Stated } from "./stated";

// What an email or social report's chat can look up while it works, all read only, the way the ads report chat reaches
// its ad account: the client's Klaviyo (the account's health, campaigns and automated emails for any dates, one email as
// it was sent) or its Facebook and Instagram (followers, reach, the posts), a trend of any of the report's numbers by
// week or month, these numbers for any other dates, the earlier reports on the line, and everything on file for the
// client (the overview, a search of Slack, email, Drive and calls, the recorded calls). The owner's own figures go on
// the report with set_reported_numbers. Each lookup is noted, so the owner sees where a number came from.

type Metrics = EmailMetrics | SocialMetrics;
type Report = { id: string; client_id: string; platform: ChannelPlatform; kind: ChannelKind; period_start: string; period_end: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 10);
const etDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

const EMAIL_TREND = ["revenue", "campaign_revenue", "flow_revenue", "orders", "open_rate", "click_rate", "campaigns_sent", "list_growth"] as const;
const SOCIAL_TREND = ["followers", "reach", "views", "interactions", "engagement_rate", "posts"] as const;

/** One of the report's numbers, read off its metrics (rates in percent) */
function trendValue(m: Metrics, metric: string): number | null {
  if (m.platform === "klaviyo") {
    const n = m.now;
    if (metric === "revenue") return r2(n.revenue);
    if (metric === "campaign_revenue") return r2(n.campaignRevenue);
    if (metric === "flow_revenue") return r2(n.flowRevenue);
    if (metric === "orders") return m.detail?.orders.now ?? null;
    if (metric === "open_rate") return pct(m.detail?.campaign.open.now ?? n.openRate);
    if (metric === "click_rate") return pct(m.detail?.campaign.click.now ?? n.clickRate);
    if (metric === "campaigns_sent") return n.campaignsSent;
    if (metric === "list_growth") return m.list.net;
    return null;
  }
  const n = m.now;
  if (metric === "followers") return n.followers;
  if (metric === "reach") return n.reach;
  if (metric === "views") return n.views;
  if (metric === "interactions") return n.interactions;
  if (metric === "engagement_rate") return pct(n.rate);
  if (metric === "posts") return n.posts;
  return null;
}

/** The weeks (Monday to Sunday) or calendar months ending with the report's own, oldest first */
function periodsBack(end: string, grain: "week" | "month", n: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  if (grain === "week") {
    for (let i = n - 1; i >= 0; i--) {
      const e = shiftDay(end, -7 * i);
      out.push({ start: shiftDay(e, -6), end: e });
    }
    return out;
  }
  let monthEnd = end;
  for (let i = 0; i < n; i++) {
    const start = `${monthEnd.slice(0, 8)}01`;
    out.unshift({ start, end: monthEnd });
    monthEnd = shiftDay(start, -1);
  }
  return out;
}

export async function channelReportTools(admin: SupabaseClient, r: Report, pulled: Pulled[], who: { id: string | null; name: string | null }): Promise<AiTool[]> {
  const base = await reportTools(admin, { client_id: r.client_id, platform: r.platform, kpi_targets: null }, pulled, who);
  // The client's context and calls are the same as an ads report's; the ad account lookups and the ads trend aren't
  const keep = new Set(["client_overview", "search_client", "recent_calls", "read_call"]);
  const note = (label: string, data: unknown) => {
    pulled.push({ label, data: (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 12_000) });
    return data;
  };
  const email = r.platform === "klaviyo";
  const tools: AiTool[] = [
    ...base.filter((t) => keep.has(t.name)),
    {
      name: "earlier_reports",
      description: `This client's earlier ${channelName(r.platform).toLowerCase()} reports that were sent (newest first): the period, the Slack message and the sections. Use it when asked to follow the last report's format or compare with what was reported before.`,
      input_schema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 6 }, kind: { type: "string", enum: ["any", "weekly", "monthly"] } }, additionalProperties: false },
      run: async (input) => {
        let q = admin.from("reports").select("kind, period_start, period_end, message, sections").eq("client_id", r.client_id).eq("platform", r.platform).in("status", ["posted", "submitted"]).neq("id", r.id).order("period_end", { ascending: false }).limit(Math.min(6, Number(input.count) || 2));
        if (input.kind === "weekly" || input.kind === "monthly") q = q.eq("kind", input.kind);
        const { data } = await q;
        return note(`Earlier reports (${data?.length ?? 0})`, data ?? []);
      },
    },
    {
      name: "numbers_for_dates",
      description: "The same numbers this report uses, worked out for other dates (against the same number of days just before): for a comparison, a longer view or something the owner asks about. Always say the dates you looked up.",
      input_schema: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD, not after yesterday" } }, required: ["start", "end"], additionalProperties: false },
      run: async (input) => {
        const start = String(input.start ?? "");
        const end = String(input.end ?? "");
        if (!DAY.test(start) || !DAY.test(end) || start > end) throw new Error("Give a start and an end day (YYYY-MM-DD), the start first.");
        const m = await loadChannelMetrics(admin, r.platform, r.client_id, "weekly", { start, end }, { images: false });
        if (!m) throw new Error("There are no numbers for the client to look up.");
        return note(`${channelName(r.platform)} numbers, ${start} to ${end}`, channelMetricsText(m));
      },
    },
    {
      name: "trend",
      description: `One of the report's numbers week by week or month by month, ending with the report's own period, counted exactly as the report counts it (rates in percent). Use it for a longer view, a "since we started" line or to say whether a move is a trend.`,
      input_schema: {
        type: "object",
        properties: { metric: { type: "string", enum: email ? [...EMAIL_TREND] : [...SOCIAL_TREND] }, grain: { type: "string", enum: ["week", "month"] }, periods: { type: "integer", minimum: 2, maximum: 12 } },
        required: ["metric", "grain", "periods"],
        additionalProperties: false,
      },
      run: async (input) => {
        const grain = input.grain === "month" ? "month" : "week";
        const n = Math.min(12, Math.max(2, Number(input.periods) || 5));
        const list = periodsBack(r.period_end, grain, n);
        const rows = [];
        for (const p of list) {
          const m = await loadChannelMetrics(admin, r.platform, r.client_id, grain === "month" ? "monthly" : "weekly", p, { images: false }).catch(() => null);
          rows.push({ start: p.start, end: p.end, value: m ? trendValue(m, String(input.metric)) : null });
        }
        return note(`${String(input.metric).replace(/_/g, " ")} by ${grain} (${rows.length})`, rows);
      },
    },
    {
      name: "set_reported_numbers",
      description: `Sets the report's numbers to figures the owner explicitly gave you in this chat (for example "${email ? "Klaviyo shows $12,400 and 310 orders for the month" : "Instagram shows 14,200 followers"}"), so the tiles, tables and PDF change too, not only the text. Use it ONLY for numbers the owner states; never for a number you looked up, worked out or guessed. Give only what they gave${email ? " (money in the account's currency, counts as whole numbers)" : " (the engagement rate in percent, 4.2 for 4.2%)"}, and where they read it (source). After it returns, write the message and sections from the numbers it returns, and tell the owner which numbers you set.`,
      input_schema: {
        type: "object",
        properties: {
          ...Object.fromEntries((email ? EMAIL_STATED : SOCIAL_STATED).map((k) => [k, { type: "number", description: `${k.replace(/_/g, " ")}, only if the owner gave it` }])),
          source: { type: "string", description: email ? "Where they read it, e.g. Klaviyo, Shopify" : "Where they read it, e.g. Instagram, Meta Business Suite" },
          note: { type: "string", description: "Anything the owner said about where the numbers came from" },
        },
        required: ["source"],
        additionalProperties: false,
      },
      run: async (input) => {
        const values = statedFrom(r.platform, input as Record<string, unknown>);
        if (!Object.keys(values).length) return { ok: false, error: "No number the owner gave was passed." };
        const { data: row } = await admin.from("reports").select("status, metrics, manual_results").eq("id", r.id).maybeSingle();
        if (!row?.metrics) return { ok: false, error: "This report has no numbers yet." };
        if (row.status === "posted") return { ok: false, error: "It's already gone out." };
        const was = ((row.manual_results ?? null) as { stated?: Stated } | null)?.stated ?? null;
        const stated = mergeStated(was, { values, source: String(input.source ?? "the owner").slice(0, 80), note: input.note ? String(input.note).slice(0, 300) : null, by: who.id, byName: who.name, at: new Date().toISOString() });
        const metrics = applyStated(row.metrics as Metrics, stated);
        await admin.from("reports").update({ manual_results: { ...((row.manual_results ?? {}) as object), stated }, metrics, updated_at: new Date().toISOString() }).eq("id", r.id);
        note("Numbers set from the owner's message", `${Object.entries(values).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")} (${stated.source})`);
        return { ok: true, saved: `Set from ${stated.source}. The tiles, tables and PDF now show them.`, the_numbers_now: channelMetricsText(metrics) };
      },
    },
  ];

  if (email) {
    tools.push(
      {
        name: "email_marketing",
        description:
          "The client's email and SMS from Klaviyo (read only, synced daily): the last 30 days' attributed revenue against the 30 before, open and click rates, the health pulse (share of the store's revenue, revenue per recipient, cadence, unsubscribe and spam rates, list growth), the key automated emails' coverage, red/amber/green health findings with what to do, subject line patterns, list change by week, lists and segments, and the best and weakest campaigns of the last 90 days. Use it for how the account is doing beyond the report's dates and what the list answers.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        run: async () => {
          const { clientKlaviyo, topAndBottom } = await import("@/lib/klaviyo/store");
          const { subjectPatterns, weeklyListChange } = await import("@/lib/kaizen-ai/email-insights");
          const k = await clientKlaviyo(admin, r.client_id);
          if (!k) throw new Error("No Klaviyo numbers for this client: it isn't connected, or the first read hasn't run.");
          const best = topAndBottom(k);
          return note("Klaviyo account, last 30 days", {
            data_through: k.through,
            currency: k.currency ?? "USD",
            last_30_days: { revenue: r2(k.now.revenue), campaign_revenue: r2(k.now.campaignRevenue), flow_revenue: r2(k.now.flowRevenue), campaigns_sent: k.now.campaignsSent, open_rate_pct: pct(k.now.openRate), click_rate_pct: pct(k.now.clickRate), unsubscribe_rate_pct: pct(k.now.unsubscribeRate), spam_rate_pct: pct(k.now.spamRate), share_of_store_revenue_pct: pct(k.now.share), revenue_per_recipient: r2(k.now.revenuePerRecipient), campaigns_per_week: k.now.cadence, list_growth: k.now.listGrowth },
            the_30_days_before: { revenue: r2(k.before.revenue), campaigns_sent: k.before.campaignsSent, open_rate_pct: pct(k.before.openRate), click_rate_pct: pct(k.before.clickRate) },
            health: k.health.map((h) => ({ tone: h.tone === "bad" ? "red" : h.tone === "warn" ? "amber" : "green", finding: h.title, detail: h.detail, what_to_do: h.action })),
            key_automated_emails: k.keyFlows.map((f) => ({ flow: f.label, state: f.state, matched: f.flows.map((x) => x.name) })),
            subject_line_patterns_90d: subjectPatterns(k.campaigns.filter((x) => x.sendTime && x.sendTime.slice(0, 10) >= shiftDay(k.today, -89))),
            list_change_by_week: weeklyListChange(k.daily).slice(-13),
            lists_and_segments: k.audiences.filter((a) => a.profiles != null).slice(0, 12).map((a) => ({ name: a.name, kind: a.kind, profiles: a.profiles, growth_30d: a.growth?.change ?? null })),
            best_campaigns_90d: best.top.map((x) => ({ id: x.id, sent: x.sendTime?.slice(0, 10) ?? null, name: x.name, subject: x.subject, recipients: x.recipients, open_rate_pct: pct(x.openRate), revenue: r2(x.revenue) })),
            weakest_campaigns_90d: best.bottom.map((x) => ({ id: x.id, sent: x.sendTime?.slice(0, 10) ?? null, name: x.name, subject: x.subject, recipients: x.recipients, open_rate_pct: pct(x.openRate), click_rate_pct: pct(x.clickRate), revenue: r2(x.revenue) })),
          });
        },
      },
      {
        name: "klaviyo_campaigns",
        description: "The campaigns sent between two dates (the last 120 days are kept), each with its id, name, subject line, preview text, audiences, recipients, open and click rate, orders, revenue, unsubscribes and spam complaints. Use it for any campaign question, a comparison between campaigns, or before klaviyo_campaign_preview.",
        input_schema: { type: "object", properties: { since: { type: "string", description: "YYYY-MM-DD" }, until: { type: "string", description: "YYYY-MM-DD" }, channel: { type: "string", enum: ["email", "sms"] } }, required: ["since", "until"], additionalProperties: false },
        run: async (input) => {
          const since = String(input.since ?? "");
          const until = String(input.until ?? "");
          if (!DAY.test(since) || !DAY.test(until) || since > until) throw new Error("Dates must be YYYY-MM-DD, since before until.");
          const { clientKlaviyo } = await import("@/lib/klaviyo/store");
          const k = await clientKlaviyo(admin, r.client_id);
          if (!k) throw new Error("No Klaviyo numbers for this client yet.");
          const list = k.campaigns.filter((x) => etDay(x.sendTime) >= since && etDay(x.sendTime) <= until && (!input.channel || x.channel === input.channel));
          return note(`Klaviyo campaigns · ${since} to ${until} (${list.length})`, list.slice(0, 60).map((x) => ({ id: x.id, sent: etDay(x.sendTime), channel: x.channel, name: x.name, subject: x.subject, preview: x.previewText, audiences: x.audiences, recipients: x.recipients, open_rate_pct: pct(x.openRate), click_rate_pct: pct(x.clickRate), orders: x.conversions, revenue: r2(x.revenue), unsubscribes: x.unsubscribes, spam_complaints: x.spamComplaints })));
        },
      },
      {
        name: "klaviyo_flows",
        description: "The automated emails (flows): each one's status and trigger, revenue over 30 and 90 days, recipients, open and click rates, and, when they're stored, its numbers for any dates. Use it for automated email questions; in anything the client reads call them automated emails.",
        input_schema: { type: "object", properties: { since: { type: "string", description: "YYYY-MM-DD, optional: the flows' own numbers between two dates" }, until: { type: "string", description: "YYYY-MM-DD, optional" } }, additionalProperties: false },
        run: async (input) => {
          const { clientKlaviyo } = await import("@/lib/klaviyo/store");
          const k = await clientKlaviyo(admin, r.client_id);
          if (!k) throw new Error("No Klaviyo numbers for this client yet.");
          const since = DAY.test(String(input.since ?? "")) ? String(input.since) : null;
          const until = DAY.test(String(input.until ?? "")) ? String(input.until) : null;
          const days: Record<string, { recipients: number; orders: number; revenue: number }> = {};
          if (since && until && since <= until) {
            const { data } = await admin.from("klaviyo_flow_daily").select("flow_id, recipients, conversions, revenue").eq("client_id", r.client_id).gte("date", since).lte("date", until).limit(5000);
            for (const d of (data ?? []) as { flow_id: string; recipients: number; conversions: number; revenue: number }[]) {
              const t = (days[d.flow_id] ??= { recipients: 0, orders: 0, revenue: 0 });
              t.recipients += Number(d.recipients) || 0;
              t.orders += Number(d.conversions) || 0;
              t.revenue += Number(d.revenue) || 0;
            }
          }
          return note(`Klaviyo automated emails${since && until ? ` · ${since} to ${until}` : ""}`, k.flows.slice(0, 30).map((f) => ({ id: f.id, name: f.name, status: f.status, trigger: f.trigger, revenue_30d: r2(f.revenue30), revenue_90d: r2(f.revenue90), recipients_30d: f.recipients30, open_rate_30d_pct: pct(f.openRate30), click_rate_30d_pct: pct(f.clickRate30), ...(days[f.id] ? { in_those_dates: { recipients: days[f.id].recipients, orders: days[f.id].orders, revenue: r2(days[f.id].revenue) } } : {}) })));
        },
      },
      {
        name: "klaviyo_campaign_preview",
        description: "One campaign as it was sent, by its id from klaviyo_campaigns: the subject line, preview text and the email's words. Use it to say what a campaign was about or why it likely worked.",
        input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (input) => {
          const { campaignPreview } = await import("@/lib/klaviyo/store");
          const got = await campaignPreview(admin, r.client_id, String(input.id));
          if (!got.ok) throw new Error(got.error);
          const p = got.preview;
          return note(`Klaviyo · campaign ${input.id}`, { channel: p.channel, subject: p.subject, preview: p.previewText, words: String(p.body ?? "").replace(/\s+/g, " ").slice(0, 6000) });
        },
      },
    );
  } else {
    tools.push({
      name: "organic_social",
      description: "The client's organic social from Facebook and Instagram (read only, synced daily; no ads): followers and growth, reach, views, engagement rate against the period before, posts with their counts (likes, comments, shares, saves, reach), the top and weakest posts, the format mix, posting rhythm and red/amber/green health findings with what to do. Use it for a longer view than the report's dates, what to post more of, or whether the cadence is right.",
      input_schema: { type: "object", properties: { days: { type: "integer", minimum: 7, maximum: 90, description: "The period in days, through today (default 30)" }, top_posts: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false },
      run: async (input) => {
        const { clientSocial } = await import("@/lib/social/store");
        const { organicSocialReport } = await import("@/lib/kaizen-ai/social-report");
        const d = await clientSocial(admin, r.client_id);
        if (!d) throw new Error("No Facebook or Instagram numbers for this client yet: the Page or Instagram isn't linked, or the first read hasn't run.");
        const days = Math.min(90, Math.max(7, Number(input.days) || 30));
        return note(`Organic social, last ${days} days`, organicSocialReport(d, { days, top: Math.min(10, Math.max(1, Number(input.top_posts) || 3)) }));
      },
    });
  }
  return tools;
}

/** What the tools can reach, in one line for the prompt */
export function channelToolsLine(platform: ChannelPlatform) {
  const reach = platform === "klaviyo" ? "the client's Klaviyo (the account's health, campaigns and automated emails for any dates, one campaign as it was sent)" : "the client's Facebook and Instagram (followers, reach, the posts, over any days)";
  return `You can look things up before you answer: ${reach}; a trend of any of the report's numbers by week or month; these numbers for any other dates; this client's earlier reports on this line; and everything on file for the client (the Brand Bible, Slack, email, Drive, recorded calls with transcripts). When the owner asks for a number, a comparison, something said on a call or in Slack, or an earlier report's format, use the tools; never say you can't reach them. Numbers you pull are real data: use them exactly and say the dates; the report's own numbers and dates stay as the app drew them. When the owner gives you numbers themselves, set them with set_reported_numbers so the tiles and PDF change too; never use it for a number you looked up or guessed. What's in Slack, email, calls and internal notes informs the report; nothing internal goes into what the client reads.`;
}
