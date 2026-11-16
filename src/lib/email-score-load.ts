import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { etToday, shiftDay } from "@/lib/channel-kpis/calc";
import { scoreFromRows, type EmailScoreResult, type ScoreCampaign, type ScoreDay, type ScoreFlow } from "./email-score-calc";

// Loads each client's email account score from the synced Klaviyo tables: the last 30 days, New York dates. Pass the
// server client for an all-clients read (the Overview, reports, audits) or a person's session (RLS then limits it).

export type { EmailScoreResult } from "./email-score-calc";

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const nyDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function groupBy<T>(rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => T) {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.client_id as string;
    const l = m.get(k);
    if (l) l.push(f(r));
    else m.set(k, [f(r)]);
  }
  return m;
}

/** Scores for these clients; a client with no synced rows at all is left out of the map (nothing to score) */
export async function loadEmailScores(admin: SupabaseClient, clientIds: string[]): Promise<Map<string, EmailScoreResult>> {
  const out = new Map<string, EmailScoreResult>();
  if (!clientIds.length) return out;
  const to = etToday();
  const from = shiftDay(to, -29);
  const [days, camps, flows] = await Promise.all([
    readAll<Record<string, unknown>>((a, b) => admin.from("klaviyo_daily").select("client_id, date, revenue, store_revenue, campaign_recipients, flow_recipients").in("client_id", clientIds).gte("date", from).lte("date", to).order("client_id").order("date").range(a, b)),
    // A day of slack either side of the window, then cut to New York dates below
    readAll<Record<string, unknown>>((a, b) =>
      admin
        .from("klaviyo_campaigns")
        .select("client_id, campaign_id, channel, send_time, recipients, delivered, bounced, spam_complaints, unsubscribes, opens_unique, open_rate, click_rate")
        .in("client_id", clientIds)
        .gte("send_time", `${shiftDay(from, -1)}T00:00:00Z`)
        .lte("send_time", `${shiftDay(to, 1)}T23:59:59Z`)
        .order("client_id")
        .order("campaign_id")
        .range(a, b),
    ),
    readAll<Record<string, unknown>>((a, b) => admin.from("klaviyo_flows").select("client_id, flow_id, status, recipients_30, open_rate_30, click_rate_30").in("client_id", clientIds).order("client_id").order("flow_id").range(a, b)),
  ]);
  const inWindow = camps.filter((c) => {
    const d = c.send_time ? nyDay(c.send_time as string) : "";
    return d >= from && d <= to;
  });
  const dayBy = groupBy(days, (r): ScoreDay => ({ revenue: num(r.revenue), storeRevenue: numOrNull(r.store_revenue), campaignRecipients: num(r.campaign_recipients), flowRecipients: num(r.flow_recipients) }));
  const campBy = groupBy(inWindow, (r): ScoreCampaign => ({ channel: (r.channel as string | null) ?? null, recipients: num(r.recipients), delivered: num(r.delivered), bounced: num(r.bounced), spam: num(r.spam_complaints), unsubscribes: num(r.unsubscribes), opens: num(r.opens_unique), openRate: numOrNull(r.open_rate), clickRate: numOrNull(r.click_rate) }));
  const flowBy = groupBy(flows, (r): ScoreFlow => ({ status: (r.status as string | null) ?? null, recipients30: num(r.recipients_30), openRate30: numOrNull(r.open_rate_30), clickRate30: numOrNull(r.click_rate_30) }));
  for (const id of clientIds) {
    if (!dayBy.has(id) && !campBy.has(id) && !flowBy.has(id)) continue;
    out.set(id, scoreFromRows({ days: dayBy.get(id) ?? [], campaigns: campBy.get(id) ?? [], flows: flowBy.get(id) ?? [] }, { from, to }));
  }
  return out;
}

export async function loadEmailScore(admin: SupabaseClient, clientId: string): Promise<EmailScoreResult | null> {
  return (await loadEmailScores(admin, [clientId])).get(clientId) ?? null;
}
