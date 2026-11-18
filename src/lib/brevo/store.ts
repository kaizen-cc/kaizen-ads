import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BACKFILL_DAYS, dayIn, emptyStats, rollupDays, type Stats } from "../klaviyo/core";
import { sanitizeEmailHtml } from "../klaviyo/insights";
import { campaignRow, dayRow, errText, save, shift } from "../klaviyo/store";
import { ProviderError, brevoKeyProblem, redactSecret } from "../email-providers/core";
import { keyOfConn, type ConnRow, type ProviderDef, type ReadOut } from "../email-providers/runner";
import { BREVO_ATTRIBUTION_BATCH } from "./core";
import { brevoAttribution, brevoCampaignContent, getBrevoAccount, listBrevoAudiences, listBrevoCampaigns } from "./api";

// Brevo as a source for the shared email tables. campaigns -> klaviyo_campaigns (source 'brevo'), lists and segments ->
// klaviyo_audiences, the daily totals -> klaviyo_daily from each campaign's send day. Brevo's public API v3 has no
// endpoint that lists automation workflows (checked against the API index at developers.brevo.com), so klaviyo_flows
// gets no Brevo rows and the flow checks stay unmeasured. Revenue comes from the ecommerce attribution endpoint; when it
// answers with an error (no store connected to Brevo) revenue_read is false and revenue checks stay unmeasured.

const SOURCE = "brevo";

async function read({ admin, conn, key, window, step, depth }: Parameters<ProviderDef["read"]>[0]): Promise<ReadOut> {
  const clientId = conn.client_id;
  const full = window === "full";
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const depthDays = depth ?? BACKFILL_DAYS;
  const from = full ? shift(today, -(depthDays - 1)) : shift(today, -6);
  const since = new Date(Date.parse(`${shift(today, full ? -(depthDays + 30) : -8)}T00:00:00Z`)).toISOString();
  const now = new Date().toISOString();

  await step(10, "Reading the campaigns");
  const email = await listBrevoCampaigns(key, "email", since, full ? Math.max(8, Math.ceil(depthDays / 12)) : 1);
  // SMS is optional on a Brevo plan: a refusal there never stops the email read
  const sms = await listBrevoCampaigns(key, "sms", since, full ? Math.max(4, Math.ceil(depthDays / 60)) : 1).catch(() => []);
  const sent = [...email, ...sms].filter((c) => c.sendTime);

  await step(40, "Reading what each campaign earned");
  let revenueRead: boolean | null = null;
  let attribution = new Map<string, { orders: number; revenue: number }>();
  if (sent.length) {
    try {
      attribution = await brevoAttribution(
        key,
        sent.filter((c) => c.channel !== "sms").map((c) => c.id),
        sent.filter((c) => c.channel === "sms").map((c) => c.id),
        BREVO_ATTRIBUTION_BATCH,
      );
      revenueRead = true;
    } catch (e) {
      // A refused key stops the read; anything else (no store connected, a plan without it) only leaves revenue unmeasured
      if (e instanceof ProviderError && e.status === 401) throw e;
      revenueRead = false;
    }
  }

  let audiences: Awaited<ReturnType<typeof listBrevoAudiences>> = [];
  let audiencesOk = false;
  if (full) {
    await step(60, "Counting the lists and segments");
    audiences = await listBrevoAudiences(key, "list");
    const segs = await listBrevoAudiences(key, "segment").catch(() => null);
    if (segs) audiences.push(...segs);
    audiencesOk = true;
  }
  let names: Map<string, string>;
  if (full) names = new Map(audiences.map((a) => [a.id, a.name]));
  else {
    const { data } = await admin.from("klaviyo_audiences").select("audience_id, name").eq("client_id", clientId);
    names = new Map((data ?? []).map((a) => [a.audience_id as string, (a.name as string | null) ?? (a.audience_id as string)]));
  }

  await step(80, "Saving");
  const statsOf = (c: (typeof sent)[number]): Stats => {
    const a = attribution.get(`${c.channel === "sms" ? "sms_campaign" : "email_campaign"}:${c.id}`);
    return { ...(c.stats ?? emptyStats()), conversions: a?.orders ?? 0, revenue: a?.revenue ?? 0 };
  };
  const rows = sent.map((c) => campaignRow(clientId, c, statsOf(c), names, now, SOURCE));
  await save(admin, "klaviyo_campaigns", rows, "client_id,campaign_id");
  const days = rollupDays({ campaigns: sent.map((c) => ({ sendTime: c.sendTime, channel: c.channel, stats: statsOf(c) })), flows: [], tz, from, to: today });
  await save(admin, "klaviyo_daily", days.map((d) => dayRow(clientId, d, now, SOURCE)), "client_id,date");
  if (full && audiencesOk) {
    await save(
      admin,
      "klaviyo_audiences",
      audiences.map((a) => ({ client_id: clientId, audience_id: a.id, kind: a.kind, name: a.name, profile_count: a.profileCount, updated_at: now, source: SOURCE })),
      "client_id,audience_id",
    );
    const snap = audiences.filter((a) => a.profileCount != null).map((a) => ({ client_id: clientId, audience_id: a.id, date: today, profile_count: a.profileCount }));
    if (snap.length) await admin.from("klaviyo_audience_sizes").upsert(snap, { onConflict: "client_id,audience_id,date" });
    // Lists and segments deleted in Brevo go here too
    if (audiences.length) await admin.from("klaviyo_audiences").delete().eq("client_id", clientId).lt("updated_at", now);
  }
  return { revenueRead, campaigns: rows.length, flows: 0, audiences: audiences.length, days: days.length, seriesError: null, storeError: null };
}

export const BREVO: ProviderDef = {
  id: "brevo",
  table: "brevo_connections",
  keyProblem: brevoKeyProblem,
  async check(key) {
    const a = await getBrevoAccount(key);
    return { id: a.id, name: a.name, timezone: null, currency: null };
  },
  read,
  refused: (e) => e instanceof ProviderError && e.status === 401,
  // About 10 calls on a full read, 3 on a recent one, each spaced a little
  costMs: (w) => (w === "full" ? 60_000 : 20_000),
};

/** A Brevo campaign's email for the hover preview: HTML made safe on the way in, cached like Klaviyo's */
export async function brevoPreview(admin: SupabaseClient, clientId: string, campaignId: string) {
  const { data: row } = await admin.from("brevo_connections").select("*").eq("client_id", clientId).maybeSingle();
  if (!row) return { ok: false as const, error: "Brevo isn't connected for this client." };
  const key = keyOfConn(row as ConnRow);
  if (!key) return { ok: false as const, error: "The Brevo key can't be read: replace it in Team & setup." };
  try {
    const c = await brevoCampaignContent(key, campaignId);
    const html = c.html ? sanitizeEmailHtml(c.html) : null;
    if (!html) return { ok: false as const, error: "Brevo has no email content for this campaign." };
    const fetchedAt = new Date().toISOString();
    await admin.from("klaviyo_previews").upsert({ client_id: clientId, campaign_id: campaignId, channel: "email", subject: c.subject, preview_text: c.previewText, html, body: null, fetched_at: fetchedAt }, { onConflict: "client_id,campaign_id" });
    return { ok: true as const, preview: { channel: "email", subject: c.subject, previewText: c.previewText, html, body: null as string | null, fetchedAt } };
  } catch (e) {
    return { ok: false as const, error: redactSecret(errText(e), key).slice(0, 200) };
  }
}
