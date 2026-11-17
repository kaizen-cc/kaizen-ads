import "server-only";
import { BACKFILL_DAYS, dayIn, emptyStats, rates, rollupDays, sumSince, type CampaignInfo, type SeriesRow, type Stats } from "../klaviyo/core";
import { campaignRow, dayRow, errText, r4, save, saveFlowDays, shift } from "../klaviyo/store";
import { ProviderError, customerioKeyProblem, isCioRegion, type CioRegion } from "../email-providers/core";
import type { ConnRow, ProviderDef, ReadOut } from "../email-providers/runner";
import { automationDaily, eventPage, getWorkspace, listAutomations, listBroadcasts, listNewsletters, listSegments, segmentCount, sendTotals, type Cio } from "./api";
import { channelOfType, dailyStats, eventDays, flowStatus, sendId, statsOfSeries, type CioSend } from "./core";

// Customer.io as a source for the shared email tables. One-time sends (newsletters) and broadcasts -> klaviyo_campaigns
// (source 'customerio'), automations -> klaviyo_flows with their daily numbers in klaviyo_flow_daily, segments with their
// customer counts -> klaviyo_audiences, the daily totals -> klaviyo_daily. The App API reports message metrics only, no
// revenue: conversions are the `converted` counts, and revenue stays unmeasured unless the client's purchase event is named
// on the connection (revenue_event), whose value is then read from the activity log (guaranteed for 30 days only) and
// reported as that day's revenue (all of the event's value, not attributed to a message).

const SOURCE = "customerio";

const ctx = (conn: ConnRow, key: string): Cio => ({ key, region: isCioRegion(conn.region) ? conn.region : "us" });

/** Metrics for each send inside the window, one call each; a send whose metrics fail is kept without numbers */
async function readSends(c: Cio, sends: CioSend[], sinceIso: string) {
  const out: { send: CioSend; stats: Stats; channel: string }[] = [];
  for (const s of sends.filter((x) => x.sentAt && x.sentAt >= sinceIso)) {
    try {
      const m = await sendTotals(c, s.kind, s.id);
      out.push({ send: s, stats: statsOfSeries(m.series), channel: channelOfType(m.type) });
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw e;
      out.push({ send: s, stats: emptyStats(), channel: "email" });
    }
  }
  return out;
}

async function read({ admin, conn, key, window, step }: Parameters<ProviderDef["read"]>[0]): Promise<ReadOut> {
  const c = ctx(conn, key);
  const clientId = conn.client_id;
  const full = window === "full";
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const from = full ? shift(today, -(BACKFILL_DAYS - 1)) : shift(today, -6);
  const from30 = shift(today, -29);
  // The automations' daily numbers start far enough back for the 30 days (and the 90 on a full read)
  const seriesFrom = full ? from : shift(today, -30);
  const sinceIso = new Date(Date.parse(`${shift(today, full ? -120 : -8)}T00:00:00Z`)).toISOString();
  const now = new Date().toISOString();

  await step(8, "Reading the sends");
  const newsletters = await listNewsletters(c, sinceIso, full ? 6 : 1);
  const broadcasts = await listBroadcasts(c).catch(() => []);
  const sends = await readSends(c, [...newsletters, ...broadcasts], sinceIso);

  await step(30, "Reading the automations");
  const automations = await listAutomations(c).catch((e) => {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw e;
    return null;
  });
  const series: SeriesRow[] = [];
  let seriesError: string | null = null;
  for (const [i, a] of (automations ?? []).entries()) {
    if (full) await step(30 + Math.round((i / Math.max(1, automations?.length ?? 1)) * 35), "Reading the automations");
    try {
      const m = await automationDaily(c, a.id, seriesFrom);
      series.push({ id: a.id, days: dailyStats(m.series, seriesFrom) });
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw e;
      seriesError ??= `${a.name}: ${errText(e).slice(0, 120)}`;
    }
  }

  // The client's purchase event, when named: its value is the revenue (read from the activity log)
  let revenueRead: boolean | null = conn.revenue_event ? false : null;
  let eventByDay = new Map<string, { revenue: number; orders: number }>();
  let storeError: string | null = null;
  if (conn.revenue_event) {
    await step(68, "Reading the purchase event");
    try {
      const events: { at: string; value: number | null }[] = [];
      let next: string | null = null;
      let complete = false;
      for (let i = 0; i < 25; i++) {
        const page = await eventPage(c, conn.revenue_event, next);
        events.push(...page.events);
        if (!page.next || !page.events.length) {
          complete = true;
          break;
        }
        next = page.next;
      }
      eventByDay = new Map(eventDays(events, (iso) => dayIn(iso, tz), complete).map((d) => [d.date, d]));
      // Events found but none carrying a number: the value's property name isn't one this reads
      revenueRead = events.some((e) => e.value != null);
      if (events.length && !revenueRead) storeError = `The "${conn.revenue_event}" events carry no revenue, total, value, amount or price property.`;
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw e;
      storeError = errText(e).slice(0, 200);
    }
  }

  let segments: { id: string; name: string; count: number | null }[] = [];
  if (full) {
    await step(80, "Counting the segments");
    const list = await listSegments(c).catch(() => null);
    if (list) {
      segments = [];
      for (const s of list.slice(0, 25)) {
        segments.push({ ...s, count: await segmentCount(c, s.id).catch(() => null) });
      }
    }
  }

  await step(90, "Saving");
  const campaigns: { info: CampaignInfo; stats: Stats }[] = sends.map(({ send, stats, channel }) => ({ info: { id: sendId(send), name: send.name, channel, status: send.state, sendTime: send.sentAt, audienceIds: [], subject: null, previewText: null, archived: false }, stats }));
  const campaignRows = campaigns.map((x) => campaignRow(clientId, x.info, x.stats, new Map(), now, SOURCE));
  await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");

  const live = (automations ?? []).filter((a) => series.some((s) => s.id === a.id) || !full);
  const flowRows = live.map((a) => {
    const s = series.find((x) => x.id === a.id);
    const d30 = s ? sumSince(s, from30) : emptyStats();
    const a30 = rates(d30);
    const base = { client_id: clientId, flow_id: a.id, name: a.name, status: flowStatus(a), trigger_type: null, recipients_30: d30.recipients, open_rate_30: r4(a30.openRate), click_rate_30: r4(a30.clickRate), conversions_30: d30.conversions, updated_at: now, source: SOURCE };
    if (!full || !s) return base;
    const d90 = sumSince(s, from);
    const a90 = rates(d90);
    return { ...base, recipients_90: d90.recipients, open_rate_90: r4(a90.openRate), click_rate_90: r4(a90.clickRate), conversions_90: d90.conversions };
  });
  if (automations) await save(admin, "klaviyo_flows", flowRows, "client_id,flow_id");
  if (series.length) await saveFlowDays(admin, clientId, series, full ? from : from30, now);

  const days = rollupDays({ campaigns: campaigns.map((x) => ({ sendTime: x.info.sendTime, channel: x.info.channel, stats: x.stats })), flows: series, tz, from, to: today });
  // A day the purchase event covers carries its revenue and orders; the rest are left as they were (never zeroed by this read)
  const withEvent = days.filter((d) => eventByDay.has(d.date)).map((d) => ({ ...dayRow(clientId, d, now, SOURCE), revenue: eventByDay.get(d.date)!.revenue, conversions: eventByDay.get(d.date)!.orders }));
  const rest = days.filter((d) => !eventByDay.has(d.date)).map((d) => dayRow(clientId, d, now, SOURCE));
  if (conn.revenue_event) {
    await save(admin, "klaviyo_daily", withEvent, "client_id,date");
    const bare = rest.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !["revenue", "conversions", "campaign_revenue", "flow_revenue", "sms_revenue"].includes(k))));
    await save(admin, "klaviyo_daily", bare, "client_id,date");
  } else await save(admin, "klaviyo_daily", rest, "client_id,date");

  if (full && segments.length) {
    await save(admin, "klaviyo_audiences", segments.map((s) => ({ client_id: clientId, audience_id: s.id, kind: "segment", name: s.name, profile_count: s.count, updated_at: now, source: SOURCE })), "client_id,audience_id");
    const snap = segments.filter((s) => s.count != null).map((s) => ({ client_id: clientId, audience_id: s.id, date: today, profile_count: s.count }));
    if (snap.length) await admin.from("klaviyo_audience_sizes").upsert(snap, { onConflict: "client_id,audience_id,date" });
    await admin.from("klaviyo_audiences").delete().eq("client_id", clientId).lt("updated_at", now);
  }
  // Automations deleted in Customer.io go here too
  if (full && automations?.length) await admin.from("klaviyo_flows").delete().eq("client_id", clientId).lt("updated_at", now);
  return { revenueRead, campaigns: campaignRows.length, flows: flowRows.length, audiences: segments.length, days: days.length, seriesError, storeError };
}

export const CUSTOMERIO: ProviderDef = {
  id: "customerio",
  table: "customerio_connections",
  keyProblem: customerioKeyProblem,
  async check(key, extra) {
    const tryRegion = async (region: CioRegion) => ({ ...(await getWorkspace({ key, region })), region });
    let w: Awaited<ReturnType<typeof tryRegion>>;
    try {
      w = await tryRegion(extra.region ?? "us");
    } catch (e) {
      // No region chosen and the US host refused it: the workspace may live in the EU
      if (!extra.region && e instanceof ProviderError && (e.status === 401 || e.status === 403)) w = await tryRegion("eu");
      else throw e;
    }
    return { id: w.id, name: w.name, timezone: null, currency: null, region: w.region };
  },
  read,
  refused: (e) => e instanceof ProviderError && e.status === 401,
  // One call per send and per automation, spaced 150ms: a few minutes at most
  costMs: (w) => (w === "full" ? 120_000 : 40_000),
};
