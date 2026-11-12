import "server-only";
import { addStats, KLAVIYO_BASE,KLAVIYO_REVISION, REPORT_STATS, SERIES_STATS, errorText, nextLink, parseAccount, parseAudiences, parseCampaigns, parseFlows, parseSeriesReport, parseValuesReport, metricIds, parseCampaignMessages, placedOrderId, redactKey, reportWait, retryDecision, type AudienceInfo, type CampaignInfo, type FlowInfo, type KlaviyoAccount, type SeriesRow, type ValuesRow } from "./core";
import { aggregateBody, parseMetricAggregate, type DayValue } from "./insights";

// Klaviyo's REST API, read only: GET calls and the Reporting API's POST queries (which read, never change anything).
// One private key per client account. Every call carries the pinned revision, waits and retries on 429 (Retry-After)
// and 5xx with backoff, and never puts the key in an error, a log or the database in plain text.

export class KlaviyoError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The Reporting API allows 2 queries a minute per account: the last one's time, per key, in this process
const lastReport = new Map<string, number>();

async function call(key: string, path: string, init: { method?: "GET" | "POST"; body?: unknown; report?: boolean } = {}): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${KLAVIYO_BASE}${path}`;
  if (!url.startsWith(KLAVIYO_BASE)) throw new KlaviyoError("Refused a link outside Klaviyo's API.", null);
  for (let attempt = 0; ; attempt++) {
    if (init.report) {
      const wait = reportWait(lastReport.get(key) ?? null, Date.now());
      if (wait) await sleep(wait);
      lastReport.set(key, Date.now());
    }
    let status: number | null = null;
    let retryAfter: string | null = null;
    let json: unknown = null;
    try {
      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: KLAVIYO_REVISION, accept: "application/vnd.api+json", ...(init.body ? { "content-type": "application/vnd.api+json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      json = await res.json().catch(() => null);
      if (res.ok) return json;
    } catch (e) {
      if (attempt >= 3) throw new KlaviyoError(redactKey(`Klaviyo didn't answer: ${e instanceof Error ? e.message : String(e)}`, key), null);
    }
    const next = retryDecision({ status, retryAfter, attempt });
    if (!next.retry) throw new KlaviyoError(redactKey(status ? errorText(status, json) : "Klaviyo didn't answer.", key), status);
    await sleep(next.waitMs);
  }
}

/** Every page of a GET list, following links.next (at most `pages`) */
async function pagesOf<T>(key: string, path: string, parse: (json: unknown) => T[], pages = 10, stop?: (rows: T[]) => boolean): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < pages; i++) {
    const json = await call(key, next);
    const rows = parse(json);
    out.push(...rows);
    if (stop?.(rows)) break;
    next = nextLink(json);
  }
  return out;
}

/** The account a key belongs to: checks the key works at all (accounts:read) */
export async function getAccount(key: string): Promise<KlaviyoAccount> {
  const acc = parseAccount(await call(key, "/api/accounts/"));
  if (!acc) throw new KlaviyoError("Klaviyo didn't say which account this key belongs to.", null);
  return acc;
}

/** Campaigns of one channel, newest first, back to `since` (ISO); a recent read looks at fewer pages */
export async function listCampaigns(key: string, channel: "email" | "sms", since: string, pages = 8): Promise<CampaignInfo[]> {
  const q = new URLSearchParams({ filter: `equals(messages.channel,'${channel}')`, include: "campaign-messages", sort: "-created_at" });
  const rows = await pagesOf(key, `/api/campaigns/?${q}`, (j) => parseCampaigns(j, channel), pages);
  return rows.filter((c) => !c.sendTime || c.sendTime >= since);
}

export async function listFlows(key: string): Promise<FlowInfo[]> {
  const q = new URLSearchParams({ "fields[flow]": "name,status,archived,trigger_type,created,updated", filter: "equals(archived,false)" });
  return pagesOf(key, `/api/flows/?${q}`, parseFlows, 10);
}

export async function listAudiences(key: string, kind: "list" | "segment"): Promise<AudienceInfo[]> {
  return pagesOf(key, kind === "list" ? "/api/lists/" : "/api/segments/", (j) => parseAudiences(j, kind), 15);
}

/** One list or segment with its profile count (a slower call: 1 a second, 15 a minute) */
export async function audienceSize(key: string, kind: "list" | "segment", id: string): Promise<number | null> {
  const json = await call(key, `/api/${kind === "list" ? "lists" : "segments"}/${encodeURIComponent(id)}/?additional-fields[${kind}]=profile_count`);
  return parseAudiences(json, kind)[0]?.profileCount ?? null;
}

/** The "Placed Order" metric's id: the conversion every revenue number is read on */
export async function placedOrderMetric(key: string): Promise<string | null> {
  let next: string | null = "/api/metrics/";
  for (let i = 0; next && i < 10; i++) {
    const json = await call(key, next);
    const id = placedOrderId(json);
    if (id) return id;
    next = nextLink(json);
  }
  return null;
}

/** campaign-values-report for a timeframe: one row per campaign, its messages added up */
export async function campaignValues(key: string, metricId: string, timeframe: { key: string } | { start: string; end: string }): Promise<ValuesRow[]> {
  const body = { data: { type: "campaign-values-report", attributes: { statistics: [...REPORT_STATS], timeframe, conversion_metric_id: metricId } } };
  return reportPages(key, "/api/campaign-values-reports/", body, (j) => parseValuesReport(j, "campaign"));
}

/** flow-values-report for a timeframe: one row per flow */
export async function flowValues(key: string, metricId: string, timeframe: { key: string } | { start: string; end: string }): Promise<ValuesRow[]> {
  const body = { data: { type: "flow-values-report", attributes: { statistics: [...REPORT_STATS], timeframe, conversion_metric_id: metricId } } };
  return reportPages(key, "/api/flow-values-reports/", body, (j) => parseValuesReport(j, "flow"));
}

/**
 * flow-series-report, daily: each flow's counts per day. Klaviyo refuses a daily interval over more than 60 days
 * (a 400), so a longer stretch must come as several timeframes (seriesChunks); their days are merged here.
 */
export async function flowSeries(key: string, metricId: string, timeframe: { key: string } | { start: string; end: string } | { start: string; end: string }[]): Promise<SeriesRow[]> {
  const frames = Array.isArray(timeframe) ? timeframe : [timeframe];
  const out = new Map<string, SeriesRow>();
  for (const tf of frames) {
    const body = { data: { type: "flow-series-report", attributes: { statistics: [...SERIES_STATS], timeframe: tf, interval: "daily", conversion_metric_id: metricId } } };
    let next: string | null = "/api/flow-series-reports/";
    for (let i = 0; next && i < 5; i++) {
      const json = await call(key, next, { method: "POST", body, report: true });
      for (const r of parseSeriesReport(json)) {
        const had = out.get(r.id);
        out.set(r.id, had ? mergeSeries(had, r) : r);
      }
      next = nextLink(json);
    }
  }
  return [...out.values()];
}

/** One flow's days from two answers, a day in both added up once per answer (pieces never overlap) */
function mergeSeries(a: SeriesRow, b: SeriesRow): SeriesRow {
  const by = new Map(a.days.map((d) => [d.date, d]));
  for (const d of b.days) {
    const had = by.get(d.date);
    by.set(d.date, had ? { date: d.date, stats: addStats(had.stats, d.stats), sms: (had.sms ?? 0) + (d.sms ?? 0) } : d);
  }
  return { id: a.id, days: [...by.values()].sort((x, y) => x.date.localeCompare(y.date)) };
}

/** The account's metrics the pulse reads, by name: Placed Order (Shopify's first), and list joins and leaves */
export async function pulseMetrics(key: string): Promise<{ placedOrder: string | null; subscribed: string | null; unsubscribed: string | null }> {
  const all: unknown[] = [];
  let next: string | null = "/api/metrics/";
  for (let i = 0; next && i < 10; i++) {
    const json = await call(key, next);
    const d = (json as { data?: unknown[] } | null)?.data;
    if (Array.isArray(d)) all.push(...d);
    next = nextLink(json);
  }
  return metricIds({ data: all });
}

/** One metric's daily totals (sum of value and count) in [from, to], calendar days in the account's time zone */
export async function metricDaily(key: string, metricId: string, from: string, to: string, tz: string | null): Promise<DayValue[]> {
  const out = new Map<string, DayValue>();
  let next: string | null = "/api/metric-aggregates/";
  for (let i = 0; next && i < 5; i++) {
    const json = await call(key, next, { method: "POST", body: aggregateBody(metricId, from, to, tz) });
    for (const d of parseMetricAggregate(json)) {
      const had = out.get(d.date);
      out.set(d.date, had ? { date: d.date, value: had.value + d.value, count: had.count + d.count } : d);
    }
    next = nextLink(json);
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What a campaign looked like: its first message (channel, SMS body, subject) and, for email, the template's HTML
 * (GET /api/campaign-messages/{id}/template: the HTML as Klaviyo renders it, template tags left in). Reads only.
 */
export async function campaignContent(key: string, campaignId: string): Promise<{ messageId: string | null; channel: string | null; subject: string | null; previewText: string | null; body: string | null; html: string | null; text: string | null }> {
  const msgs = await call(key, `/api/campaigns/${encodeURIComponent(campaignId)}/campaign-messages/`);
  const first = parseCampaignMessages(msgs)[0];
  if (!first) return { messageId: null, channel: null, subject: null, previewText: null, body: null, html: null, text: null };
  let html: string | null = null;
  let text: string | null = null;
  if (first.channel !== "sms") {
    const t = (await call(key, `/api/campaign-messages/${encodeURIComponent(first.id)}/template/`)) as { data?: { attributes?: { html?: string; text?: string } } } | null;
    html = t?.data?.attributes?.html ?? null;
    text = t?.data?.attributes?.text ?? null;
  }
  return { messageId: first.id, channel: first.channel, subject: first.subject, previewText: first.previewText, body: first.body, html, text };
}

async function reportPages(key: string, path: string, body: unknown, parse: (json: unknown) => ValuesRow[]): Promise<ValuesRow[]> {
  const out: ValuesRow[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < 5; i++) {
    const json = await call(key, next, { method: "POST", body, report: true });
    out.push(...parse(json));
    next = nextLink(json);
  }
  return out;
}
