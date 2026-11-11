import "server-only";
import { KLAVIYO_BASE, KLAVIYO_REVISION, REPORT_STATS, SERIES_STATS, errorText, nextLink, parseAccount, parseAudiences, parseCampaigns, parseFlows, parseSeriesReport, parseValuesReport, placedOrderId, redactKey, reportWait, retryDecision, type AudienceInfo, type CampaignInfo, type FlowInfo, type KlaviyoAccount, type SeriesRow, type ValuesRow } from "./core";

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

/** flow-series-report, daily: each flow's counts per day */
export async function flowSeries(key: string, metricId: string, timeframe: { key: string } | { start: string; end: string }): Promise<SeriesRow[]> {
  const body = { data: { type: "flow-series-report", attributes: { statistics: [...SERIES_STATS], timeframe, interval: "daily", conversion_metric_id: metricId } } };
  const out = new Map<string, SeriesRow>();
  let next: string | null = "/api/flow-series-reports/";
  for (let i = 0; next && i < 5; i++) {
    const json = await call(key, next, { method: "POST", body, report: true });
    for (const r of parseSeriesReport(json)) {
      const had = out.get(r.id);
      out.set(r.id, had ? { id: r.id, days: [...had.days, ...r.days] } : r);
    }
    next = nextLink(json);
  }
  return [...out.values()];
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
