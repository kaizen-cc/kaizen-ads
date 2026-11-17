// Customer.io (App API) in Kaizen Ads: the plain parts, kept apart from the network and the database so they can be
// tested. Every endpoint and field was checked against https://docs.customer.io/integrations/api/app/ (the page is
// named beside each constant). Read only: nothing here sends, edits or triggers anything in Customer.io.

import { emptyStats, type Stats } from "../klaviyo/core";

/**
 * GET /v1/workspaces: { workspaces: [{ id, name, people, ... }] }, the cheap check that a key works and the account it
 * belongs to. https://docs.customer.io/integrations/api/app/tag/workspaces/listWorkspaces/
 */
export const CIO_WORKSPACES = "/v1/workspaces";
/** GET /v1/campaigns: automations, { campaigns: [{ id, name, active, state, created, updated, first_started, tags }] } (no query parameters). https://docs.customer.io/integrations/api/app/tag/automations/listCampaigns/ */
export const CIO_CAMPAIGNS = "/v1/campaigns";
/**
 * GET /v1/campaigns/{id}/metrics: version=2 with res (days), start and end (Unix seconds) and tz; answers
 * { start, end, res, metric: { series: { sent: [...], delivered: [...], opened: [...], clicked: [...], converted: [...],
 * bounced, spammed, unsubscribed, human_opened, ... } } }, each series oldest first. Version 1 (period, steps) is the older
 * form. https://docs.customer.io/integrations/api/app/tag/automations/campaignMetrics/
 */
export const CIO_CAMPAIGN_METRICS = (id: string) => `/v1/campaigns/${encodeURIComponent(id)}/metrics`;
/** GET /v1/broadcasts: { broadcasts: [{ id, name, type, state, active, created, updated, first_started, tags }] }. https://docs.customer.io/integrations/api/app/tag/broadcasts/listBroadcasts/ */
export const CIO_BROADCASTS = "/v1/broadcasts";
/** GET /v1/broadcasts/{id}/metrics: period (hours, days, weeks, months), steps (2 or more; 12 months, 45 days...), type. https://docs.customer.io/integrations/api/app/tag/broadcasts/broadcastMetrics/ */
export const CIO_BROADCAST_METRICS = (id: string) => `/v1/broadcasts/${encodeURIComponent(id)}/metrics`;
/** GET /v1/newsletters: one-time sends, limit, sort (asc or desc), start (the previous answer's `next`); { newsletters: [{ id, name, type, created, updated, sent_at, tags, send_state }], next }. https://docs.customer.io/integrations/api/app/tag/newsletters/listNewsletters/ */
export const CIO_NEWSLETTERS = "/v1/newsletters";
/** GET /v1/newsletters/{id}/metrics: period, steps, type; { metric: { series, type } }. https://docs.customer.io/integrations/api/app/tag/newsletter-metrics/getNewsletterMetrics/ */
export const CIO_NEWSLETTER_METRICS = (id: string) => `/v1/newsletters/${encodeURIComponent(id)}/metrics`;
/** GET /v1/segments: { segments: [{ id, name, description, state, type, tags }] }. https://docs.customer.io/integrations/api/app/tag/segments/listSegments/ */
export const CIO_SEGMENTS = "/v1/segments";
/** GET /v1/segments/{id}/customer_count: { count, segment_id }. https://docs.customer.io/integrations/api/app/tag/segments/getSegmentCount/ */
export const CIO_SEGMENT_COUNT = (id: string) => `/v1/segments/${encodeURIComponent(id)}/customer_count`;
/**
 * GET /v1/activities: type, name (the event's name), limit (default 10, max 100), start (the previous answer's `next`);
 * { activities: [{ id, type, name, timestamp, data, ... }], next }. Only the last 30 days are guaranteed. This is how a
 * configured revenue event is read: the App API has no revenue report of its own.
 * https://docs.customer.io/integrations/api/app/tag/activities/listActivities/
 */
export const CIO_ACTIVITIES = "/v1/activities";

/** Most endpoints are limited to 10 requests a second; a 429 carries Retry-After (https://docs.customer.io/integrations/api/app/#rate-limits) */
export const CIO_GAP_MS = 150;

/** Property names a purchase event commonly carries its value in, tried in this order (the real name is checked once a key is connected) */
export const REVENUE_KEYS = ["revenue", "total", "value", "amount", "order_total", "total_price", "price"] as const;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
};

export function cioErrorText(status: number, json: unknown): string {
  const first = obj(arr(obj(json).errors)[0]);
  const detail = str(first.detail) ?? str(first.message) ?? str(obj(json).meta && obj(obj(json).meta).error);
  if (status === 401) return "Customer.io refused this key. Check it was copied whole, hasn't been deleted, and that the region is right.";
  if (status === 403) return "Customer.io says this key can't read that. Create a new App API key with access to the workspace.";
  if (status === 429) return "Customer.io is rate limiting this account right now. It's tried again on the next sync.";
  return `Customer.io answered ${status}${detail ? `: ${detail}` : ""}`;
}

export type CioWorkspace = { id: string; name: string | null };
export function parseWorkspaces(json: unknown): CioWorkspace | null {
  const w = obj(arr(obj(json).workspaces)[0]);
  const id = str(w.id);
  return id ? { id, name: str(w.name) } : null;
}

/** Unix seconds (or a numeric string) as an ISO instant; null when it isn't one */
export function isoOfUnix(v: unknown): string | null {
  const x = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(x) || x <= 0) return null;
  // Milliseconds are told from seconds by size
  const ms = x > 1e12 ? x : x * 1000;
  return new Date(ms).toISOString();
}

export type CioAutomation = { id: string; name: string; active: boolean; state: string | null; firstStarted: string | null };
export function parseAutomations(json: unknown): CioAutomation[] {
  return arr(obj(json).campaigns)
    .map((raw) => {
      const c = obj(raw);
      const id = str(c.id);
      return id ? { id, name: str(c.name) ?? "(untitled)", active: c.active === true, state: str(c.state), firstStarted: isoOfUnix(c.first_started) } : null;
    })
    .filter((c): c is CioAutomation => c !== null);
}

/** An automation as the flows table says its status: live when it is active, else what Customer.io says (draft, stopped...) */
export const flowStatus = (a: Pick<CioAutomation, "active" | "state">) => (a.active ? "live" : (a.state ?? "draft"));

export type CioSend = { id: string; kind: "newsletter" | "broadcast"; name: string; sentAt: string | null; state: string | null };

export function parseBroadcasts(json: unknown): CioSend[] {
  return arr(obj(json).broadcasts)
    .map((raw): CioSend | null => {
      const b = obj(raw);
      const id = str(b.id);
      return id ? { id, kind: "broadcast", name: str(b.name) ?? "(untitled)", sentAt: isoOfUnix(b.first_started), state: str(b.state) } : null;
    })
    .filter((b): b is CioSend => b !== null);
}

export function parseNewsletters(json: unknown): { rows: CioSend[]; next: string | null } {
  const root = obj(json);
  const rows = arr(root.newsletters)
    .map((raw): CioSend | null => {
      const x = obj(raw);
      const id = str(x.id);
      return id ? { id, kind: "newsletter", name: str(x.name) ?? "(untitled)", sentAt: isoOfUnix(x.sent_at), state: str(x.send_state) } : null;
    })
    .filter((x): x is CioSend => x !== null);
  return { rows, next: str(root.next) };
}

/** The shared campaign id of a send: kinds never share an id */
export const sendId = (s: Pick<CioSend, "id" | "kind">) => `${s.kind}-${s.id}`;

export type CioSeries = Record<string, number[]>;

/** A metrics answer's series, each as a list of counts (metric.series, oldest first) */
export function parseSeries(json: unknown): { series: CioSeries; type: string | null } {
  const m = obj(obj(json).metric);
  const series: CioSeries = {};
  for (const [k, v] of Object.entries(obj(m.series))) series[k] = arr(v).map(n);
  return { series, type: str(m.type) };
}

const total = (s: CioSeries, k: string, from = 0) => (s[k] ?? []).slice(from).reduce((a, b) => a + b, 0);

/**
 * A series' counts (all of it, or from a day index on) as the shared Stats. Opens and clicks are capped at what was
 * delivered, so a rate never passes 100%. Customer.io reports no revenue: conversions come from `converted`.
 */
export function statsOfSeries(s: CioSeries, from = 0): Stats {
  const sent = total(s, "sent", from) || total(s, "attempted", from);
  const delivered = total(s, "delivered", from) || sent;
  const cap = (x: number) => Math.min(x, delivered || x);
  return { ...emptyStats(), recipients: sent, delivered, opensUnique: cap(total(s, "opened", from)), clicksUnique: cap(total(s, "clicked", from)), unsubscribes: total(s, "unsubscribed", from), bounced: total(s, "bounced", from), spamComplaints: total(s, "spammed", from), conversions: total(s, "converted", from) };
}

/** One stat row per day of a v2 daily series that starts on `startDay` (YYYY-MM-DD, in the tz the call asked for) */
export function dailyStats(s: CioSeries, startDay: string): { date: string; stats: Stats }[] {
  const len = Math.max(0, ...Object.values(s).map((v) => v.length));
  const out: { date: string; stats: Stats }[] = [];
  for (let i = 0; i < len; i++) {
    const date = new Date(Date.parse(`${startDay}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const col: CioSeries = {};
    for (const [k, v] of Object.entries(s)) col[k] = [v[i] ?? 0];
    out.push({ date, stats: statsOfSeries(col) });
  }
  return out;
}

/** The channel a send went out on, from its metrics' type: twilio is SMS, everything else counts as email unless it names push or in-app */
export const channelOfType = (t: string | null): string => (t === "twilio" ? "sms" : t === "push" || t === "in_app" || t === "slack" || t === "webhook" ? t : "email");

export type CioSegment = { id: string; name: string };
export function parseSegments(json: unknown): CioSegment[] {
  return arr(obj(json).segments)
    .map((raw) => {
      const s = obj(raw);
      const id = str(s.id);
      return id ? { id, name: str(s.name) ?? "(untitled)" } : null;
    })
    .filter((s): s is CioSegment => s !== null);
}
export const parseSegmentCount = (json: unknown): number | null => (obj(json).count == null ? null : n(obj(json).count));

/** The value a purchase event carries: the first of REVENUE_KEYS holding a number, in the event's data (or its nested data) */
export function eventValue(data: unknown): number | null {
  const d = obj(data);
  for (const scope of [d, obj(d.data), obj(d.attributes)])
    for (const k of REVENUE_KEYS) {
      const v = scope[k];
      if (v != null && v !== "" && Number.isFinite(Number(v))) return Number(v);
    }
  return null;
}

export type CioEventPage = { events: { at: string; value: number | null }[]; next: string | null };
/** GET /v1/activities answered for one event name: when each happened and what it was worth */
export function parseEventActivities(json: unknown): CioEventPage {
  const root = obj(json);
  const events = arr(root.activities)
    .map((raw) => {
      const a = obj(raw);
      const at = isoOfUnix(a.timestamp);
      return at ? { at, value: eventValue(a.data) } : null;
    })
    .filter((e): e is { at: string; value: number | null } => e !== null);
  return { events, next: str(root.next) };
}

/**
 * Each day's value and count of an event, only for days the read fully covers: when the listing stopped before its end
 * (more pages existed), the oldest day seen may be cut short, so days up to and including it are left for a later read.
 */
export function eventDays(events: { at: string; value: number | null }[], dayOf: (iso: string) => string, complete: boolean): { date: string; revenue: number; orders: number }[] {
  const by = new Map<string, { revenue: number; orders: number }>();
  for (const e of events) {
    const d = dayOf(e.at);
    const t = by.get(d) ?? { revenue: 0, orders: 0 };
    t.revenue += e.value ?? 0;
    t.orders += 1;
    by.set(d, t);
  }
  const oldest = [...by.keys()].sort()[0];
  return [...by.entries()]
    .filter(([d]) => complete || d !== oldest)
    .map(([date, t]) => ({ date, revenue: Math.round(t.revenue * 100) / 100, orders: t.orders }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Unix seconds of the start of a day in UTC, for the v2 start and end parameters */
export const unixOfDay = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
