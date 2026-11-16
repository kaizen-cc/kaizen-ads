"use server";

import { requireStaff } from "@/lib/auth";
import { campaignRows, flowRows, type BCampaign, type BFlow } from "@/lib/email-breakdown";
import { createClient } from "@/lib/supabase/server";

// The campaigns and live flows under an account's score, read when its sheet opens on the KPI board (the board itself
// only carries the scores). Read through the person's session, so it holds only clients they can see.

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export async function loadEmailBreakdown(clientId: string): Promise<{ ok: true; campaigns: BCampaign[]; flows: BFlow[] } | { ok: false; error: string }> {
  await requireStaff();
  const db = await createClient();
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const [camps, flows] = await Promise.all([
    db.from("klaviyo_campaigns").select("campaign_id, name, channel, send_time, recipients, open_rate, click_rate, revenue, subject, preview_text").eq("client_id", clientId).gte("send_time", since).order("send_time", { ascending: false }).limit(300),
    db.from("klaviyo_flows").select("flow_id, name, status, recipients_30, open_rate_30, click_rate_30, revenue_30, recipients_90, open_rate_90, click_rate_90, revenue_90").eq("client_id", clientId).limit(200),
  ]);
  if (camps.error || flows.error) return { ok: false, error: "Couldn't read this account's campaigns and flows." };
  return {
    ok: true,
    campaigns: campaignRows((camps.data ?? []).map((c) => ({ id: c.campaign_id as string, name: (c.name as string | null) ?? "(untitled)", channel: (c.channel as string | null) ?? "email", sendTime: (c.send_time as string | null) ?? null, recipients: num(c.recipients), openRate: numOrNull(c.open_rate), clickRate: numOrNull(c.click_rate), revenue: num(c.revenue), subject: (c.subject as string | null) ?? null, previewText: (c.preview_text as string | null) ?? null }))),
    flows: flowRows((flows.data ?? []).map((f) => ({ id: f.flow_id as string, name: (f.name as string | null) ?? "(untitled)", status: (f.status as string | null) ?? null, recipients30: num(f.recipients_30), openRate30: numOrNull(f.open_rate_30), clickRate30: numOrNull(f.click_rate_30), revenue30: num(f.revenue_30), recipients90: num(f.recipients_90), openRate90: numOrNull(f.open_rate_90), clickRate90: numOrNull(f.click_rate_90), revenue90: num(f.revenue_90) }))),
  };
}
