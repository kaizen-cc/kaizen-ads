import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptionKey, unseal } from "@/lib/meta-token-core";
import { conversionMetricsOf, type ConversionMetric } from "@/lib/email-metrics";
import { KlaviyoError, locationAggregate, metricEventsPage } from "./api";
import { dayIn, redactKey } from "./core";
import { dayStartUtc, detectLocationProps, locationPropsOf, looksMultiLocation, parseEventsPage, parseLocationAggregate, resolveMessages, rollupEvents, UNKNOWN_LOCATION, type LocationCandidate, type LocationRoute, type LocationRow } from "./locations";

// Multi-location clients' orders by restaurant (klaviyo_location_daily), read from Klaviyo once a day for the clients a
// lead or an exec flagged, and the check that suggests the flag. Klaviyo's metric aggregates are tried first, grouped by
// message and the location property; Klaviyo's docs list no custom property for `by`, so a refusal moves the client to
// the Events API (each order with the message credited), and the route that worked is remembered. Read only in Klaviyo.
// Everything here returns quietly until the locations migration is applied.

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** How far back the first read goes: last month in full for a monthly report written mid-month */
const BACKFILL_DAYS = 62;
/** Days read again every run: Klaviyo attributes orders as they come in */
const RECENT_DAYS = 3;
/** The Events API, per metric per run: pages of 200 orders (a busy 40-restaurant day is about 40 pages) */
const PAGE_BUDGET = 240;
const DAY_PAGE_CAP = 80;
/** Sample events read to suggest the flag, and how often */
const SAMPLE_SIZE = 100;
const DETECT_EVERY_MS = 7 * 86_400_000;

/** What's remembered per client (sync_state "klaviyo-locations:<client>"): the route that worked, how far back each metric is read, what the last check found */
export type LocationMemo = { route?: LocationRoute | null; covered?: Record<string, string>; props?: Record<string, string>; detected?: Record<string, LocationCandidate[]>; detectedAt?: string | null; error?: string | null; at?: string | null };
const memoSource = (clientId: string) => `klaviyo-locations:${clientId}`;

async function readMemo(admin: SupabaseClient, clientId: string): Promise<LocationMemo> {
  const { data } = await admin.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle();
  return ((data?.last_result as LocationMemo | null) ?? {}) as LocationMemo;
}
async function writeMemo(admin: SupabaseClient, clientId: string, memo: LocationMemo) {
  await admin.from("sync_state").upsert({ source: memoSource(clientId), last_run_at: new Date().toISOString(), last_result: memo });
}

type Conn = { client_id: string; timezone: string | null; key_iv: string; key_tag: string; key_ciphertext: string; conversion_metric_id: string | null; conversion_metric_name?: string | null; conversion_metrics?: unknown; multi_location?: boolean | null; location_props?: unknown };

function keyOf(r: Pick<Conn, "key_iv" | "key_tag" | "key_ciphertext">): string | null {
  const k = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!k) return null;
  try {
    return unseal({ iv: r.key_iv, tag: r.key_tag, ciphertext: r.key_ciphertext }, k);
  } catch {
    return null;
  }
}

const metricsOf = (c: Conn): ConversionMetric[] => conversionMetricsOf(c.conversion_metrics, { id: c.conversion_metric_id, name: c.conversion_metric_name ?? null });

// ─── The setting ───────────────────────────────────────────────────────────

export type LocationSetup = {
  multi: boolean;
  props: Record<string, string>;
  metrics: ConversionMetric[];
  /** The last check's candidates per metric, likely ones first */
  detected: Record<string, LocationCandidate[]>;
  detectedAt: string | null;
  /** The events say this account has several locations, and it isn't flagged yet */
  suggested: boolean;
  route: LocationRoute | null;
  lastRead: string | null;
  error: string | null;
};

/** A client's location setting as the Klaviyo card and the board sheet show it; null until the migration is applied */
export async function locationSetup(admin: SupabaseClient, clientId: string): Promise<LocationSetup | null> {
  const { data, error } = await admin.from("klaviyo_connections").select("client_id, conversion_metric_id, conversion_metric_name, conversion_metrics, multi_location, location_props").eq("client_id", clientId).maybeSingle();
  if (error || !data) return null;
  const memo = await readMemo(admin, clientId);
  const multi = Boolean(data.multi_location);
  const detected = memo.detected ?? {};
  return {
    multi,
    props: locationPropsOf(data.location_props),
    metrics: metricsOf(data as unknown as Conn),
    detected,
    detectedAt: memo.detectedAt ?? null,
    suggested: !multi && looksMultiLocation(detected),
    route: memo.route ?? null,
    lastRead: memo.at ?? null,
    error: memo.error ?? null,
  };
}

/** Turn the breakdown on or off and pick each metric's location property (a lead or an exec; the caller checks) */
export async function saveLocationSetting(admin: SupabaseClient, clientId: string, s: { multi: boolean; props: Record<string, string> }): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await admin.from("klaviyo_connections").update({ multi_location: s.multi, location_props: locationPropsOf(s.props), updated_at: new Date().toISOString() }).eq("client_id", clientId);
  if (error) return { ok: false, error: /multi_location|location_props/.test(error.message) ? "The location breakdown needs the latest database update." : error.message };
  return { ok: true };
}

async function connOf(admin: SupabaseClient, clientId: string): Promise<Conn | null> {
  const { data } = await admin.from("klaviyo_connections").select("*").eq("client_id", clientId).maybeSingle();
  return (data as Conn | null) ?? null;
}

/**
 * A look at each ranked metric's latest orders (100 from the last two weeks, one call each) for properties that hold a
 * location, with a few values of each. Saved for the card; says whether it looks multi-location.
 */
export async function detectLocations(admin: SupabaseClient, clientId: string, given?: { conn: Conn; key: string }): Promise<{ ok: true; detected: Record<string, LocationCandidate[]>; suggested: boolean } | { ok: false; error: string }> {
  const conn = given?.conn ?? (await connOf(admin, clientId));
  if (!conn) return { ok: false, error: "Klaviyo isn't connected for this client." };
  const key = given?.key ?? keyOf(conn);
  if (!key) return { ok: false, error: "The saved key can't be read. Replace the key." };
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const fromIso = new Date(Date.now() - 14 * 86_400_000).toISOString().replace(/\.\d+Z$/, "+00:00");
  const detected: Record<string, LocationCandidate[]> = {};
  try {
    for (const m of metricsOf(conn)) {
      const { json } = await metricEventsPage(key, { metricId: m.id, fromIso, toIso: nowIso, size: SAMPLE_SIZE, attributions: false });
      const events = (Array.isArray((json as { data?: unknown[] })?.data) ? (json as { data: unknown[] }).data : []).map((e) => ((e as { attributes?: { event_properties?: Record<string, unknown> } }).attributes?.event_properties ?? null));
      detected[m.id] = detectLocationProps(events);
    }
  } catch (e) {
    return { ok: false, error: redactKey(errText(e), key) };
  }
  const memo = await readMemo(admin, clientId);
  await writeMemo(admin, clientId, { ...memo, detected, detectedAt: new Date().toISOString() });
  return { ok: true, detected, suggested: looksMultiLocation(detected) };
}

// ─── The daily read ────────────────────────────────────────────────────────

/** Rows saved for the days read; a location and message read before but missing now is set to zero, never deleted */
async function saveDays(admin: SupabaseClient, clientId: string, metricId: string, days: string[], rows: LocationRow[]) {
  const now = new Date().toISOString();
  const conflict = { onConflict: "client_id,metric_id,date,location,message_id" };
  const fresh = rows.map((r) => ({ client_id: clientId, metric_id: metricId, date: r.date, location: r.location, message_id: r.messageId, campaign_id: r.campaignId, flow_id: r.flowId, conversions: r.conversions, revenue: r.revenue, updated_at: now }));
  const zeroed: Record<string, unknown>[] = [];
  if (days.length) {
    const { data: had } = await admin.from("klaviyo_location_daily").select("date, location, message_id").eq("client_id", clientId).eq("metric_id", metricId).in("date", days).limit(20_000);
    const keep = new Set(fresh.map((r) => `${r.date}|${r.location}|${r.message_id}`));
    // Only the numbers are written, so a zeroed row keeps its campaign
    for (const h of had ?? []) if (!keep.has(`${h.date}|${h.location}|${h.message_id}`)) zeroed.push({ client_id: clientId, metric_id: metricId, date: h.date, location: h.location, message_id: h.message_id, conversions: 0, revenue: 0, updated_at: now });
  }
  for (const list of [fresh, zeroed] as Record<string, unknown>[][])
    for (let i = 0; i < list.length; i += 500) {
      const { error } = await admin.from("klaviyo_location_daily").upsert(list.slice(i, i + 500), conflict);
      if (error) throw new Error(`Saving locations: ${error.message}`);
    }
}

/** One day of a metric's orders from the Events API, every page (up to the cap); says whether it was cut short */
async function eventsDay(key: string, metricId: string, prop: string, day: string, tz: string | null, budget: { pages: number }): Promise<{ rows: LocationRow[]; cut: boolean }> {
  const all: ReturnType<typeof parseEventsPage> = [];
  let at: Parameters<typeof metricEventsPage>[1] | null = { metricId, fromIso: dayStartUtc(day, tz), toIso: dayStartUtc(shift(day, 1), tz) };
  let pages = 0;
  while (at && pages < DAY_PAGE_CAP && budget.pages > 0) {
    const { json, next } = await metricEventsPage(key, at);
    pages++;
    budget.pages--;
    // Only this day: an event a time zone edge puts on the next day is read with that day
    all.push(...parseEventsPage(json, prop, (iso) => dayIn(iso, tz)).filter((e) => e.date === day));
    at = next;
  }
  return { rows: rollupEvents(metricId, all), cut: Boolean(at) };
}

const refused = (e: unknown) => e instanceof KlaviyoError && e.status != null && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 && e.status !== 429;

/**
 * One flagged client's locations, read: each ranked metric with a location property picked. The last three days every
 * run, and older days back to 62 a slice at a time (the Events API pages through every order, so a busy account fills
 * its history over a few runs). A metric that fails is noted for Sync health; the rest still saves. Returns the note.
 */
export async function syncLocations(admin: SupabaseClient, clientId: string, given?: { conn: Conn; key: string }, opts: { deadline?: number } = {}): Promise<{ ok: boolean; rows: number; error: string | null }> {
  const conn = given?.conn ?? (await connOf(admin, clientId));
  if (!conn || !conn.multi_location) return { ok: true, rows: 0, error: null };
  const key = given?.key ?? keyOf(conn);
  if (!key) return { ok: false, rows: 0, error: "The saved key can't be read." };
  const props = locationPropsOf(conn.location_props);
  const metrics = metricsOf(conn).filter((m) => props[m.id]);
  const memo = await readMemo(admin, clientId);
  if (!metrics.length) {
    const error = "No location property picked for any conversion metric.";
    await writeMemo(admin, clientId, { ...memo, error, at: new Date().toISOString() });
    return { ok: false, rows: 0, error };
  }
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const floor = shift(today, -(BACKFILL_DAYS - 1));
  const deadline = opts.deadline ?? Date.now() + 240_000;
  const covered: Record<string, string> = { ...(memo.covered ?? {}) };
  // A property changed since the last read: that metric starts over
  for (const m of metrics) if (memo.props?.[m.id] !== props[m.id]) delete covered[m.id];
  let route: LocationRoute | null = memo.route ?? null;
  const errors: string[] = [];
  let saved = 0;
  // Campaign message ids to campaigns (an SMS campaign's message id isn't its campaign id)
  const { data: camps } = await admin.from("klaviyo_campaigns").select("campaign_id, message_id").eq("client_id", clientId).gte("send_time", `${shift(today, -(BACKFILL_DAYS + 30))}T00:00:00Z`).limit(2000);
  const campaignMap = (camps ?? []).map((c) => ({ campaignId: c.campaign_id as string, messageId: (c.message_id as string | null) ?? null }));

  for (const m of metrics) {
    const prop = props[m.id];
    try {
      if (route !== "events") {
        const from = covered[m.id] ? shift(today, -(RECENT_DAYS - 1)) : floor;
        let rows: LocationRow[] | null = null;
        try {
          const pages = await locationAggregate(key, m.id, prop, from, today, tz);
          const parsed = pages.map((p) => parseLocationAggregate(p, m.id));
          rows = parsed.length && parsed.every((p) => p != null) ? parsed.flatMap((p) => p!) : null;
          // Accepted but every order without a location: Klaviyo ignored the property, so it isn't really grouped
          if (rows?.length && rows.every((r) => r.location === UNKNOWN_LOCATION)) rows = null;
        } catch (e) {
          if (!refused(e)) throw e;
        }
        if (rows) {
          route = "aggregates";
          const days: string[] = [];
          for (let d = from; d <= today; d = shift(d, 1)) days.push(d);
          await saveDays(admin, clientId, m.id, days, resolveMessages(rows, campaignMap));
          saved += rows.length;
          covered[m.id] = covered[m.id] && covered[m.id] < from ? covered[m.id] : from;
          continue;
        }
        // Klaviyo won't group by the location: this client reads orders one by one from now on
        route = "events";
      }
      const budget = { pages: PAGE_BUDGET };
      const days: string[] = [];
      for (let i = RECENT_DAYS - 1; i >= 0; i--) days.push(shift(today, -i));
      // Then older days, back from the earliest read so far
      for (let d = shift(covered[m.id] ?? shift(today, -(RECENT_DAYS - 1)), -1); d >= floor; d = shift(d, -1)) days.push(d);
      let earliest = covered[m.id] ?? null;
      for (const day of days) {
        if (budget.pages <= 0 || Date.now() > deadline) break;
        const { rows, cut } = await eventsDay(key, m.id, prop, day, tz, budget);
        if (cut) {
          // Out of this run's pages mid-day: the day is read whole on a later run, never saved half
          if (budget.pages <= 0) break;
          errors.push(`${m.name}: more than ${DAY_PAGE_CAP * 200} orders on ${day}, so that day is incomplete`);
        }
        await saveDays(admin, clientId, m.id, [day], resolveMessages(rows, campaignMap));
        saved += rows.length;
        if (day < today && (!earliest || day < earliest)) earliest = day;
      }
      if (earliest) covered[m.id] = earliest;
    } catch (e) {
      if (e instanceof KlaviyoError && (e.status === 401 || e.status === 403)) {
        errors.push(`${m.name}: the key can't read events (${e.status}); it needs Read access to Events and Metrics`);
        break;
      }
      errors.push(`${m.name}: ${redactKey(errText(e), key).slice(0, 160)}`);
    }
  }
  const error = errors.length ? errors.join("; ").slice(0, 300) : null;
  await writeMemo(admin, clientId, { ...memo, route, covered, props, error, at: new Date().toISOString() });
  return { ok: !error, rows: saved, error };
}

/**
 * The daily full read's location step: a flagged client's locations, or (every week) the check that suggests the flag
 * for one that isn't. Never fails the read: the note goes to Sync health.
 */
export async function locationStep(admin: SupabaseClient, clientId: string, key: string): Promise<string | null> {
  const conn = await connOf(admin, clientId);
  // Before the migration the connection has no flag at all: nothing to do
  if (!conn || conn.multi_location === undefined) return null;
  try {
    // Two minutes at most inside the cron's read; a busy account's history fills over the next days
    if (conn.multi_location) return (await syncLocations(admin, clientId, { conn, key }, { deadline: Date.now() + 120_000 })).error;
    const memo = await readMemo(admin, clientId);
    if (!memo.detectedAt || Date.now() - Date.parse(memo.detectedAt) > DETECT_EVERY_MS) await detectLocations(admin, clientId, { conn, key });
    return null;
  } catch (e) {
    return `Locations: ${redactKey(errText(e), key).slice(0, 200)}`;
  }
}

/** A flagged client's location rows for these campaigns, from a day on (null when the client isn't flagged or the table is missing) */
export async function readLocationRows(db: SupabaseClient, clientId: string, metricIds: string[], campaignIds: string[], from: string): Promise<LocationRow[] | null> {
  if (!metricIds.length || !campaignIds.length) return [];
  const out: LocationRow[] = [];
  for (let at = 0; at < 50_000; at += 1000) {
    const { data, error } = await db.from("klaviyo_location_daily").select("metric_id, date, location, message_id, campaign_id, flow_id, conversions, revenue").eq("client_id", clientId).in("metric_id", metricIds).in("campaign_id", campaignIds.slice(0, 300)).gte("date", from).order("date").order("location").order("message_id").range(at, at + 999);
    if (error) return null;
    for (const r of data ?? []) out.push({ metricId: r.metric_id as string, date: r.date as string, location: r.location as string, messageId: r.message_id as string, campaignId: (r.campaign_id as string | null) ?? null, flowId: (r.flow_id as string | null) ?? null, conversions: Number(r.conversions ?? 0) || 0, revenue: Number(r.revenue ?? 0) || 0 });
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Whether a client is flagged, with its ranked metrics that have a location property (null: not flagged or not set up) */
export async function locationConfig(admin: SupabaseClient, clientId: string): Promise<{ metrics: ConversionMetric[] } | null> {
  const { data, error } = await admin.from("klaviyo_connections").select("conversion_metric_id, conversion_metric_name, conversion_metrics, multi_location, location_props").eq("client_id", clientId).maybeSingle();
  if (error || !data || !data.multi_location) return null;
  const props = locationPropsOf(data.location_props);
  const metrics = metricsOf(data as unknown as Conn).filter((m) => props[m.id]);
  return metrics.length ? { metrics } : null;
}
