import "server-only";
import { hasLine, type ServiceFields } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptionKey, seal, unseal } from "@/lib/meta-token-core";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { attributedPages, audienceSize, campaignContent, campaignValues, flowSeries, flowValues, getAccount, KlaviyoError, listAudiences, listCampaigns, listFlows, metricDaily, placedOrderMetric, pulseMetrics, listMetrics } from "./api";
import { BACKFILL_DAYS, cleanKey, dayIn, emailContextLine, emptyStats, keyLast4, keyProblem, klaviyoClientState, klaviyoCostMs, partialSyncWarning, pickKlaviyoWindow, rates, redactKey, rollupDays, sumSince, type CampaignInfo, type KlaviyoClientState, type KlaviyoPlainError, type KlaviyoWindow, type SeriesRow, type Stats } from "./core";
import { audienceGrowth, emailHealth, keyFlowCoverage, pulseWindow, sanitizeEmailHtml, seriesChunks, sortCampaigns, type CampaignLite, type DailyRow, type DayValue, type FlowLite, type HealthFinding, type KeyFlow, type PulseWindow } from "./insights";
import { audienceSets, type AudienceLookup } from "./audiences";
import { tracker } from "@/lib/progress";
import { conversionMetricsOf, MAX_CONVERSION_METRICS, type ConversionMetric } from "@/lib/email-metrics";
import { runBounded } from "@/lib/bounded";
import { connectedElsewhere, elsewhereMessage, emailConnection, emailConnections } from "@/lib/email-providers/which";
import { isEmailProvider, providerHasFlows, providerName, type EmailProvider } from "@/lib/email-providers/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { changedRows, readAllRows } from "@/lib/unchanged";

// Klaviyo in Kaizen OS: each client's connection (a read-only private API key, encrypted at rest), the daily sync
// (campaigns, flows, lists and segments, the account's totals per day), and what the client page and the agents read.
// Read only. Everything returns early, touching nothing, until the Klaviyo migration is applied.

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
export const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 10000);

type ConnRow = { client_id: string; account_id: string; account_name: string | null; timezone: string | null; currency: string | null; key_iv: string; key_tag: string; key_ciphertext: string; key_last4: string | null; conversion_metric_id: string | null; conversion_metric_name?: string | null; conversion_metric_manual?: boolean | null; conversion_metrics?: unknown; status: string; last_synced_at: string | null; backfilled_at: string | null; last_error: string | null; connected_at: string; connected_by: string | null };

/** Whether the Klaviyo tables exist (the migration applied) */
export async function klaviyoReady(admin: SupabaseClient) {
  const { error } = await admin.from("klaviyo_connections").select("client_id").limit(1);
  return !error;
}

/** A client's Klaviyo key, unsealed, for Kaizen AI's hands-on tools (the caller checks the person may work on the client) */
export async function clientKlaviyoKey(admin: SupabaseClient, clientId: string): Promise<{ key: string; account: string | null } | { error: string }> {
  const { data } = await admin.from("klaviyo_connections").select("key_iv, key_tag, key_ciphertext, account_name, status").eq("client_id", clientId).maybeSingle();
  if (!data) return { error: "Klaviyo isn't connected for this client." };
  if (data.status === "invalid") return { error: "Klaviyo refused this client's key: it was revoked. Replace it on the client's Klaviyo card." };
  const key = keyOf(data as Pick<ConnRow, "key_iv" | "key_tag" | "key_ciphertext">);
  return key ? { key, account: (data.account_name as string | null) ?? null } : { error: "The saved key can't be unlocked (the encryption key changed). Replace it on the client's Klaviyo card." };
}

function keyOf(r: Pick<ConnRow, "key_iv" | "key_tag" | "key_ciphertext">): string | null {
  const k = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!k) return null;
  try {
    return unseal({ iv: r.key_iv, tag: r.key_tag, ciphertext: r.key_ciphertext }, k);
  } catch {
    return null;
  }
}

// ─── The connection ────────────────────────────────────────────────────────

export type ConnectResult = { ok: true; account: string | null; timezone: string | null } | { ok: false; error: string };

/**
 * A pasted private API key: checked against Klaviyo's Accounts endpoint, refused when that account already belongs to
 * another client, then encrypted and saved (replacing the client's earlier key). The first sync reads 90 days back.
 */
export async function connectKlaviyo(admin: SupabaseClient, clientId: string, rawKey: string, by: string): Promise<ConnectResult> {
  const problem = keyProblem(rawKey);
  if (problem) return { ok: false, error: problem };
  const k = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!k) return { ok: false, error: "Add TOKEN_ENCRYPTION_KEY in Vercel first: without it a Klaviyo key can't be stored safely." };
  if (!(await klaviyoReady(admin))) return { ok: false, error: "Klaviyo isn't set up in the database yet: its migration hasn't been applied." };
  // A client has one email provider: Brevo or Customer.io has to be removed first
  const elsewhere = await connectedElsewhere(admin, clientId, "klaviyo");
  if (elsewhere) return { ok: false, error: elsewhereMessage(elsewhere) };
  const key = cleanKey(rawKey);
  try {
    const acc = await getAccount(key);
    const { data: other } = await admin.from("klaviyo_connections").select("client_id, clients(name)").eq("account_id", acc.id).neq("client_id", clientId).maybeSingle();
    if (other) return { ok: false, error: `This Klaviyo account is already connected to ${(other.clients as unknown as { name: string } | null)?.name ?? "another client"}. Remove it there first.` };
    const { data: had } = await admin.from("klaviyo_connections").select("account_id").eq("client_id", clientId).maybeSingle();
    const sealed = seal(key, k);
    const now = new Date().toISOString();
    const sameAccount = had?.account_id === acc.id;
    const { error } = await admin.from("klaviyo_connections").upsert(
      {
        client_id: clientId,
        account_id: acc.id,
        account_name: acc.name,
        timezone: acc.timezone,
        currency: acc.currency,
        key_iv: sealed.iv,
        key_tag: sealed.tag,
        key_ciphertext: sealed.ciphertext,
        key_last4: keyLast4(key),
        connected_by: by,
        connected_at: now,
        status: "active",
        last_error: null,
        updated_at: now,
        // A different account starts over: its own conversion metric, its own 90 days
        ...(sameAccount ? {} : { conversion_metric_id: null, backfilled_at: null, last_synced_at: null }),
      },
      { onConflict: "client_id" },
    );
    if (error) return { ok: false, error: `Saving the Klaviyo key: ${error.message}` };
    if (!sameAccount && had) await clearNumbers(admin, clientId);
    // A different account starts with its own full read
    if (!sameAccount) await admin.from("sync_state").delete().eq("source", `klaviyo:${clientId}`);
    return { ok: true, account: acc.name, timezone: acc.timezone };
  } catch (e) {
    return { ok: false, error: redactKey(errText(e), key) };
  }
}

async function clearNumbers(admin: SupabaseClient, clientId: string) {
  await Promise.all(["klaviyo_campaigns", "klaviyo_flows", "klaviyo_audiences", "klaviyo_daily", "klaviyo_flow_daily"].map((t) => admin.from(t).delete().eq("client_id", clientId)));
}

/** Remove: the key is deleted; the email history already read stays with the client (client knowledge is never deleted) */
export async function removeKlaviyo(admin: SupabaseClient, clientId: string) {
  const { error } = await admin.from("klaviyo_connections").delete().eq("client_id", clientId);
  if (error) return { ok: false as const, error: error.message };
  await admin.from("sync_state").delete().eq("source", `klaviyo:${clientId}`);
  return { ok: true as const };
}

export type KlaviyoConnectionView = { /** Which provider this is: Klaviyo unless it says Brevo or Customer.io */ provider?: EmailProvider; /** Customer.io: the host's region and the purchase event counted as revenue */ region?: "us" | "eu" | null; revenueEvent?: string | null; /** Brevo and Customer.io: whether revenue is read (null: not known yet) */ revenueRead?: boolean | null; account: string | null; accountId: string; conversionMetric?: string | null; /** The ranked metrics that count as the sale, primary first */ conversionMetrics?: ConversionMetric[]; timezone: string | null; currency: string | null; last4: string | null; status: string; lastSyncedAt: string | null; backfilled: boolean; error: string | null; connectedAt: string; by: string | null };

/** The client's connection as Team & setup shows it: null when not connected; undefined when Klaviyo isn't set up */
export async function klaviyoConnection(admin: SupabaseClient, clientId: string): Promise<KlaviyoConnectionView | null | undefined> {
  const { data, error } = await admin.from("klaviyo_connections").select("account_id, account_name, timezone, currency, key_last4, status, last_synced_at, backfilled_at, last_error, connected_at, conversion_metric_name, profiles:connected_by(full_name)").eq("client_id", clientId).maybeSingle();
  if (error) return undefined;
  if (!data) return null;
  // The ranked list is read on its own, so a database without its migration still shows the connection
  const ranked = await admin.from("klaviyo_connections").select("conversion_metric_id, conversion_metric_name, conversion_metrics").eq("client_id", clientId).maybeSingle();
  return {
    account: (data.account_name as string | null) ?? null,
    accountId: data.account_id as string,
    conversionMetric: (data.conversion_metric_name as string | null) ?? null,
    conversionMetrics: ranked.data ? conversionMetricsOf(ranked.data.conversion_metrics, { id: (ranked.data.conversion_metric_id as string | null) ?? null, name: (ranked.data.conversion_metric_name as string | null) ?? null }) : [],
    timezone: (data.timezone as string | null) ?? null,
    currency: (data.currency as string | null) ?? null,
    last4: (data.key_last4 as string | null) ?? null,
    status: data.status as string,
    lastSyncedAt: (data.last_synced_at as string | null) ?? null,
    backfilled: Boolean(data.backfilled_at),
    error: (data.last_error as string | null) ?? null,
    connectedAt: data.connected_at as string,
    by: (data.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
  };
}

export type KlaviyoRosterRow = { id: string; name: string; slug: string; account: string | null; last4: string | null; state: KlaviyoClientState; error: KlaviyoPlainError | null; lastSyncedAt: string | null; window: KlaviyoWindow | null; fullAt: string | null };

/**
 * Every live client on email marketing (or already connected) with its Klaviyo: connected (account, last read, which window), failing (the error in plain words
 * and its fix), or missing. For Settings › Sync health. null before the Klaviyo migration is applied.
 */
export async function klaviyoRoster(admin: SupabaseClient): Promise<KlaviyoRosterRow[] | null> {
  const [{ data: conns, error }, { data: clients }, { data: memos }] = await Promise.all([
    admin.from("klaviyo_connections").select("client_id, account_name, key_last4, status, last_synced_at, last_error"),
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", LIVE).order("name"),
    admin.from("sync_state").select("source, last_result").like("source", "klaviyo:%"),
  ]);
  if (error) return null;
  const by = new Map((conns ?? []).map((c) => [c.client_id as string, c]));
  // Only the clients Kaizen runs email for: the email marketing service, or a Klaviyo already connected
  // Clients on Brevo or Customer.io are on their own cards
  const elsewhere = new Set([...(await emailConnections(admin, null).catch(() => new Map())).values()].filter((c) => c.provider !== "klaviyo").map((c) => c.clientId));
  const list = (clients ?? []).filter((c) => !elsewhere.has(c.id as string)).filter((c) => by.has(c.id as string) || (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes("email-marketing"));
  const memo = new Map((memos ?? []).map((m) => [String(m.source).slice("klaviyo:".length), (m.last_result ?? {}) as SyncMemo]));
  return list.map((c) => {
    const k = by.get(c.id as string);
    const m = memo.get(c.id as string);
    const st = klaviyoClientState(k ? { status: k.status as string, lastSyncedAt: (k.last_synced_at as string | null) ?? null, error: (k.last_error as string | null) ?? null } : null);
    // A part of the read that failed while the rest worked shows as a warning instead of passing silently
    if (k && !st.error) st.error = partialSyncWarning(m);
    return {
      id: c.id as string,
      name: c.name as string,
      slug: c.slug as string,
      account: (k?.account_name as string | null) ?? null,
      last4: (k?.key_last4 as string | null) ?? null,
      state: st.state,
      error: st.error,
      lastSyncedAt: (k?.last_synced_at as string | null) ?? null,
      window: k ? (m?.window ?? null) : null,
      fullAt: k ? (m?.fullAt ?? null) : null,
    };
  });
}

// ─── The sync ──────────────────────────────────────────────────────────────

export type SyncResult = { client: string; ok: boolean; window?: KlaviyoWindow; campaigns?: number; flows?: number; audiences?: number; days?: number; error?: string };

const SIZE_GAP_MS = 4_100; // list and segment profile counts: 15 a minute
const MAX_SIZES = 8;
const NO_ORDERS = "No Placed Order metric in this account yet, so revenue can't be read (campaigns, flows and lists still are).";

/** Each client's last read, for Sync health (sync_state "klaviyo:<client id>"): when, which window, the last full read, the error */
export type SyncMemo = { window?: KlaviyoWindow; fullAt?: string | null; error?: string | null; account?: string | null; seriesError?: string | null; storeError?: string | null; locationError?: string | null };
export const memoSource = (clientId: string) => `klaviyo:${clientId}`;

/** Klaviyo refusing to report on the conversion metric (some integrations' orders can't be): not a key problem */
const unsupportedMetric = (e: unknown) => /does not support querying for values/i.test(e instanceof Error ? e.message : String(e));

/**
 * A full read's progress, for the Email board's card while the first 90 days come in: how far along (0 to 100) and the
 * step it's on, kept apart from the memo (sync_state "klaviyo-read:<client>"). Writes never hold up the read.
 */
export const readProgressSource = (clientId: string) => `klaviyo-read:${clientId}`;
export type ReadProgress = { pct: number; step: string; at: string; done?: boolean; error?: string | null };
export function readProgress(admin: SupabaseClient, clientId: string) {
  return (pct: number, step: string, extra: Partial<ReadProgress> = {}) =>
    Promise.resolve(admin.from("sync_state").upsert({ source: readProgressSource(clientId), last_run_at: new Date().toISOString(), last_result: { pct, step, at: new Date().toISOString(), ...extra } }))
      .then(() => undefined)
      .catch(() => undefined);
}
export async function saveMemo(admin: SupabaseClient, clientId: string, memo: SyncMemo) {
  await admin.from("sync_state").upsert({ source: memoSource(clientId), last_run_at: new Date().toISOString(), last_result: memo });
}

/** The "Placed Order" metric every revenue number is read on: found once, then kept on the connection */
async function metricOf(admin: SupabaseClient, conn: ConnRow, key: string) {
  if (conn.conversion_metric_id) return conn.conversion_metric_id;
  const id = await placedOrderMetric(key);
  if (id) await admin.from("klaviyo_connections").update({ conversion_metric_id: id }).eq("client_id", conn.client_id);
  return id;
}

/** Tries a custom timeframe; Klaviyo refusing its shape (400) falls back to one of its named timeframes */
async function orNamed<T>(custom: () => Promise<T>, named: () => Promise<T>): Promise<T> {
  try {
    return await custom();
  } catch (e) {
    if (e instanceof KlaviyoError && e.status === 400) return named();
    throw e;
  }
}
const isAuth = (e: unknown) => e instanceof KlaviyoError && (e.status === 401 || e.status === 403);

export function campaignRow(clientId: string, c: CampaignInfo, s: Stats, names: Map<string, string>, now: string, source = "klaviyo", lookup?: AudienceLookup) {
  const r = rates(s);
  return { client_id: clientId, campaign_id: c.id, name: c.name, channel: c.channel, status: c.status, send_time: c.sendTime, audiences: c.audienceIds.map((a) => names.get(a) ?? a), ...(lookup ? { audiences_detail: audienceSets({ included: c.audienceIds, excluded: c.excludedIds ?? [] }, lookup) } : {}), subject: c.subject, preview_text: c.previewText, recipients: s.recipients, delivered: s.delivered, opens_unique: s.opensUnique, open_rate: r4(r.openRate), clicks_unique: s.clicksUnique, click_rate: r4(r.clickRate), unsubscribes: s.unsubscribes, bounced: s.bounced, spam_complaints: s.spamComplaints, conversions: s.conversions, revenue: Math.round(s.revenue * 100) / 100, updated_at: now, ...(c.messageId ? { message_id: c.messageId } : {}), ...(source !== "klaviyo" ? { source } : {}) };
}
export const dayRow = (clientId: string, d: ReturnType<typeof rollupDays>[number], now: string, source = "klaviyo") => ({ ...(source !== "klaviyo" ? { source } : {}), client_id: clientId, date: d.date, campaign_revenue: d.campaignRevenue, flow_revenue: d.flowRevenue, revenue: d.revenue, campaign_recipients: d.campaignRecipients, flow_recipients: d.flowRecipients, sends: d.sends, campaigns_sent: d.campaignsSent, conversions: d.conversions, sms_revenue: d.smsRevenue, updated_at: now });

/** Columns the Klaviyo pulse migration adds: left out (and the save tried again) while it isn't applied */
const PULSE_COLUMNS = ["audiences_detail", "message_id", "store_revenue", "store_orders", "sms_revenue", "subscribed", "unsubscribed"];
const missingColumn = (msg: string) => /column|schema cache/i.test(msg);

const MOVES = ["updated_at", "computed_at", "synced_at", "fetched_at"];

/**
 * The rows that are new or differ from what's stored: every run reads the same recent window again, and rewriting an
 * unchanged row is a new tuple, WAL and index writes. When the stored rows can't be read (a column that isn't there
 * yet), every row is kept.
 */
export async function onlyChanged(admin: SupabaseClient, table: string, rows: Record<string, unknown>[], conflict: string): Promise<Record<string, unknown>[]> {
  if (!rows.length || !rows.every((r) => r.client_id)) return rows;
  const keys = conflict.split(",");
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !MOVES.includes(k));
  const clientId = rows[0].client_id as string;
  if (!rows.every((r) => r.client_id === clientId)) return rows;
  const dates = rows.map((r) => r.date).filter((d): d is string => typeof d === "string").sort();
  try {
    const stored = await readAllRows((a, b) => {
      let q = admin.from(table).select(cols.join(", ")).eq("client_id", clientId);
      if (dates.length === rows.length) q = q.gte("date", dates[0]).lte("date", dates[dates.length - 1]);
      return q.order(keys[keys.length - 1]).range(a, b);
    }, 50_000);
    const byKey = new Map(stored.map((s) => [keys.map((k) => String(s[k])).join("|"), s]));
    return changedRows(rows, byKey, (r) => keys.map((k) => String(r[k])).join("|"), MOVES);
  } catch {
    return rows;
  }
}

export async function save(admin: SupabaseClient, table: string, allRows: Record<string, unknown>[], conflict: string) {
  const rows = await onlyChanged(admin, table, allRows, conflict);
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    let { error: e } = await admin.from(table).upsert(part, { onConflict: conflict });
    if (e && missingColumn(e.message)) {
      const bare = part.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !PULSE_COLUMNS.includes(k))));
      // Nothing but the keys left: there's nothing to save until the migration is applied
      if (bare.every((r) => Object.keys(r).every((k) => ["client_id", "date", "updated_at"].includes(k)))) return;
      ({ error: e } = await admin.from(table).upsert(bare, { onConflict: conflict }));
    }
    if (e) throw new Error(`Saving ${table}: ${e.message}`);
  }
}

/** The store's own day (Placed Order), and list joins and leaves, laid onto each day's row */
export function withStore(row: Record<string, unknown>, store: Map<string, DayValue> | null, subs: Map<string, DayValue> | null, unsubs: Map<string, DayValue> | null) {
  const date = row.date as string;
  const s = store?.get(date);
  return {
    ...row,
    ...(store ? { store_revenue: s?.value ?? 0, store_orders: s?.count ?? 0 } : {}),
    ...(subs ? { subscribed: subs.get(date)?.count ?? 0 } : {}),
    ...(unsubs ? { unsubscribed: unsubs.get(date)?.count ?? 0 } : {}),
  };
}

export const byDate = (xs: DayValue[]) => new Map(xs.map((d) => [d.date, d]));

/**
 * Each flow's numbers per day (klaviyo_flow_daily), so a report reads a flow for its own week or month instead of
 * Klaviyo's last 30 days. Days from `from` on, for the flows that sent or earned in them; quiet days inside are kept at
 * zero so a later read that revises a day down replaces it. Skipped quietly until its migration is applied.
 */
export async function saveFlowDays(admin: SupabaseClient, clientId: string, series: SeriesRow[], from: string, now: string) {
  const rows = series
    .filter((f) => f.days.some((d) => d.date >= from && (d.stats.recipients || d.stats.revenue)))
    .flatMap((f) =>
      f.days
        .filter((d) => d.date >= from)
        .map((d) => ({ client_id: clientId, flow_id: f.id, date: d.date, recipients: d.stats.recipients, delivered: d.stats.delivered, opens_unique: d.stats.opensUnique, clicks_unique: d.stats.clicksUnique, conversions: d.stats.conversions, revenue: Math.round(d.stats.revenue * 100) / 100, updated_at: now })),
    );
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("klaviyo_flow_daily").upsert(rows.slice(i, i + 500), { onConflict: "client_id,flow_id,date" });
    if (error) return;
  }
}

// ─── Order systems not ranked yet ──────────────────────────────────────────

/**
 * The weekly check for a second order system (src/lib/klaviyo/sources.ts): the account's order metrics that aren't
 * ranked, each one's revenue Klaviyo credits to email over the last 30 days, kept in sync_state for the report's QA.
 * Read only in Klaviyo; a failure is noted in the memo, never failing the read.
 */
async function checkUnrankedSources(admin: SupabaseClient, conn: ConnRow, key: string, ranked: string[], today: string, tz: string | null) {
  const { SOURCES_EVERY_MS, parseAttributedTotal, sourceCandidates, isOrderMetric } = await import("./sources");
  const source = `klaviyo-sources:${conn.client_id}`;
  const { data } = await admin.from("sync_state").select("last_result").eq("source", source).maybeSingle();
  const was = (data?.last_result as { at?: string } | null) ?? null;
  if (was?.at && Date.now() - Date.parse(was.at) < SOURCES_EVERY_MS) return;
  const found: { id: string; name: string; integration: string | null; revenue: number; orders: number }[] = [];
  let metrics: { id: string; name: string; integration: string | null; ranked: boolean }[] = [];
  let error: string | null = null;
  try {
    const all = await listMetrics(key);
    metrics = all.filter((m) => ranked.includes(m.id) || isOrderMetric(m.name)).map((m) => ({ id: m.id, name: m.name, integration: m.integration, ranked: ranked.includes(m.id) }));
    for (const m of sourceCandidates(all, ranked)) {
      const t = parseAttributedTotal(await attributedPages(key, m.id, shift(today, -29), today, tz));
      if (t.revenue > 0 || t.orders > 0) found.push({ id: m.id, name: m.name, integration: m.integration, ...t });
    }
  } catch (e) {
    if (isAuth(e)) throw e;
    error = redactKey(errText(e), key).slice(0, 240);
  }
  await admin.from("sync_state").upsert({ source, last_run_at: new Date().toISOString(), last_result: { at: new Date().toISOString(), found, metrics, error } });
}

/**
 * Applies autoRank from the last weekly check: the connection's ranked list (and primary) updated in place, so this read
 * reads every order system with revenue. Only for a ranking nobody set by hand.
 */
async function rankBySources(admin: SupabaseClient, conn: ConnRow, key: string) {
  const { autoRank } = await import("./sources");
  const { data } = await admin.from("sync_state").select("last_result").eq("source", `klaviyo-sources:${conn.client_id}`).maybeSingle();
  const found = ((data?.last_result as { found?: unknown } | null)?.found ?? []) as import("./sources").SourcesMemo["found"];
  if (!Array.isArray(found) || !found.length) return;
  const since = shift(dayIn(new Date().toISOString(), conn.timezone), -29);
  const { data: days } = await admin.from("klaviyo_daily").select("revenue").eq("client_id", conn.client_id).gte("date", since);
  const primary30 = (days ?? []).reduce((t, d) => t + (Number(d.revenue) || 0), 0);
  const current = conversionMetricsOf(conn.conversion_metrics, { id: conn.conversion_metric_id, name: conn.conversion_metric_name ?? null });
  // Which system each metric comes from (Toast, Shopify, an API...), so one system's metrics are never added twice
  const integrationOf = new Map((await listMetrics(key)).map((m) => [m.id, m.integration] as const));
  const next = autoRank(current, found, primary30, integrationOf);
  if (!next) return;
  const { error } = await admin.from("klaviyo_connections").update({ conversion_metrics: next, conversion_metric_id: next[0].id, conversion_metric_name: next[0].name.slice(0, 120) }).eq("client_id", conn.client_id).eq("conversion_metric_manual", false);
  if (!error) Object.assign(conn, { conversion_metrics: next, conversion_metric_id: next[0].id, conversion_metric_name: next[0].name });
}

// ─── The lower ranked conversion metrics ───────────────────────────────────

/** The metrics ranked under the primary that this read also reads (none unless a lead or an exec picked more than one) */
function extraMetrics(conn: ConnRow, primary: string | null): ConversionMetric[] {
  if (!primary) return [];
  return conversionMetricsOf(conn.conversion_metrics, { id: conn.conversion_metric_id, name: conn.conversion_metric_name ?? null })
    .filter((m) => m.id !== primary)
    .slice(0, MAX_CONVERSION_METRICS - 1);
}

/** One metric's numbers from a read: per campaign, per flow (30 days, and 90 on a full read), per day, and the store's own */
type MetricRead = { id: string; values: Map<string, Stats>; series: SeriesRow[] | null; campaignSeries?: SeriesRow[] | null; flows: Map<string, { d30: Stats; d90?: Stats }>; store: Map<string, DayValue> | null; error: string | null };

/**
 * A lower ranked metric, read with the same calls the primary is (the Reporting API's spacing and backoff hold per
 * account, so each extra metric adds two or three spaced queries). A part that fails is noted and the rest is kept;
 * only a refused key stops the read.
 */
async function readMetric(key: string, id: string, w: { full: boolean; from: string; today: string; tz: string | null; nowIso: string; campaigns: boolean }): Promise<MetricRead> {
  const out: MetricRead = { id, values: new Map(), series: null, flows: new Map(), store: null, error: null };
  const note = (e: unknown) => {
    if (isAuth(e)) throw e;
    out.error ??= redactKey(errText(e), key).slice(0, 240);
  };
  const utc = (day: string) => `${day}T00:00:00+00:00`;
  const from30 = shift(w.today, -29);
  try {
    if (w.campaigns) {
      const v = w.full ? await campaignValues(key, id, { key: "last_90_days" }) : await orNamed(() => campaignValues(key, id, { start: utc(shift(w.today, -8)), end: w.nowIso }), () => campaignValues(key, id, { key: "last_7_days" }));
      out.values = new Map(v.map((x) => [x.id, x.stats]));
    }
  } catch (e) {
    note(e);
  }
  try {
    const series = w.full ? await flowSeries(key, id, seriesChunks(w.from, w.today, { maxDays: 45, endIso: w.nowIso })) : await orNamed(() => flowSeries(key, id, { start: utc(shift(w.today, -31)), end: w.nowIso }), () => flowSeries(key, id, { key: "last_30_days" }));
    out.series = series;
    out.flows = new Map(series.map((f) => [f.id, w.full ? { d30: sumSince(f, from30), d90: sumSince(f, w.from) } : { d30: sumSince(f, from30) }]));
  } catch (e) {
    note(e);
  }
  out.store = await metricDaily(key, id, w.full ? w.from : shift(w.today, -1), w.today, w.tz)
    .then(byDate)
    .catch((e) => {
      note(e);
      return null;
    });
  return out;
}

/** A metric's rows for the per-metric tables; days only when its daily flow series came in (else only the store's) */
function metricTableRows(clientId: string, m: MetricRead, ctx: { campaigns: { id: string; sendTime: string | null; channel: string | null }[]; tz: string | null; from: string; to: string; now: string; /** The first day this read has the store's own numbers for (a recent read: yesterday); earlier days keep theirs */ storeFrom?: string }) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const campaigns = ctx.campaigns.flatMap((c) => {
    const st = m.values.get(c.id);
    return st ? [{ client_id: clientId, campaign_id: c.id, metric_id: m.id, conversions: r2(st.conversions), revenue: r2(st.revenue), updated_at: ctx.now }] : [];
  });
  const flows = [...m.flows.entries()].map(([flowId, st]) => ({ client_id: clientId, flow_id: flowId, metric_id: m.id, conversions_30: r2(st.d30.conversions), revenue_30: r2(st.d30.revenue), ...(st.d90 ? { conversions_90: r2(st.d90.conversions), revenue_90: r2(st.d90.revenue) } : {}), updated_at: ctx.now }));
  const storeOf = (date: string) => (m.store && (!ctx.storeFrom || date >= ctx.storeFrom) ? { store_revenue: r2(m.store.get(date)?.value ?? 0), store_orders: m.store.get(date)?.count ?? 0 } : {});
  const days: Record<string, unknown>[] = [];
  if (m.series) {
    for (const d of rollupDays({ campaigns: ctx.campaigns.map((c) => ({ sendTime: c.sendTime, channel: c.channel, stats: m.values.get(c.id) ?? emptyStats() })), flows: m.series, campaignSeries: m.campaignSeries ?? null, tz: ctx.tz, from: ctx.from, to: ctx.to }))
      days.push({ client_id: clientId, metric_id: m.id, date: d.date, campaign_revenue: d.campaignRevenue, flow_revenue: d.flowRevenue, revenue: d.revenue, conversions: d.conversions, ...storeOf(d.date), updated_at: ctx.now });
  } else if (m.store) {
    for (let d = ctx.from; d <= ctx.to; d = shift(d, 1)) days.push({ client_id: clientId, metric_id: m.id, date: d, ...storeOf(d), updated_at: ctx.now });
  }
  // Each flow's day under this metric, so the report adds every order system up per flow (klaviyo_flow_metric_daily)
  const flowDays = (m.series ?? []).flatMap((f) =>
    f.days.filter((d) => d.date >= ctx.from && d.date <= ctx.to && (d.stats.revenue || d.stats.conversions)).map((d) => ({ client_id: clientId, flow_id: f.id, metric_id: m.id, date: d.date, conversions: r2(d.stats.conversions), revenue: r2(d.stats.revenue), updated_at: ctx.now })),
  );
  return { campaigns, flows, days, flowDays };
}

/** The per-metric tables: written quietly, so a database without their migration keeps syncing the primary as before */
async function saveMetrics(admin: SupabaseClient, clientId: string, reads: MetricRead[], ctx: Parameters<typeof metricTableRows>[2]) {
  for (const m of reads) {
    const rows = metricTableRows(clientId, m, ctx);
    const parts: [string, Record<string, unknown>[], string][] = [
      ["klaviyo_campaign_metrics", rows.campaigns, "client_id,campaign_id,metric_id"],
      ["klaviyo_flow_metrics", rows.flows, "client_id,flow_id,metric_id"],
      ["klaviyo_metric_daily", rows.days, "client_id,metric_id,date"],
    ];
    // A flow's days under this metric: the read's days cleared first (a day that fell to nothing keeps no old money);
    // quietly, so a database without the table keeps syncing
    if (m.series) {
      const { error } = await admin.from("klaviyo_flow_metric_daily").delete().eq("client_id", clientId).eq("metric_id", m.id).gte("date", ctx.from).lte("date", ctx.to);
      if (!error) for (let i = 0; i < rows.flowDays.length; i += 500) await admin.from("klaviyo_flow_metric_daily").upsert(rows.flowDays.slice(i, i + 500), { onConflict: "client_id,metric_id,flow_id,date" });
    }
    for (const [table, all, conflict] of parts) {
      const list = await onlyChanged(admin, table, all, conflict);
      // Rows that carry different columns (a day without the store's numbers) go in their own batches, so a missing
      // column is left as it is, never written empty
      for (const group of byColumns(list)) {
        for (let i = 0; i < group.length; i += 500) {
          const { error } = await admin.from(table).upsert(group.slice(i, i + 500), { onConflict: conflict });
          if (error) return;
        }
      }
    }
  }
}

/** Rows grouped by the columns they carry (an upsert batch writes every column it names, empty where a row has none) */
export function byColumns<T extends Record<string, unknown>>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = Object.keys(r).sort().join(",");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()];
}

/** A ranked metric's read that failed in part, named, for Sync health */
const extraNote = (extras: ConversionMetric[], reads: MetricRead[]) => {
  const bad = reads.find((m) => m.error);
  return bad ? `${extras.find((m) => m.id === bad.id)?.name ?? "A ranked metric"}: ${bad.error}`.slice(0, 240) : null;
};

type ReadOut = { metricId: string | null; campaigns: number; flows: number; audiences: number; days: number; seriesError: string | null; storeError: string | null };

/**
 * The full window: campaigns (email and SMS) of the last 120 days with their numbers, flows with 30 and 90 days of
 * numbers, lists and segments (the main ones with their size), each day's totals for 90 days, and the store's own
 * revenue per day (Placed Order). Calls go one at a time; the Reporting API (2 queries a minute per account) is spaced,
 * and refusals wait and retry. The daily flow series is asked for in pieces of 45 days: Klaviyo refuses a daily series
 * longer than 60 days. A part that fails is noted (seriesError, storeError) for Sync health, never passed over silently.
 */
async function readFull(admin: SupabaseClient, conn: ConnRow, key: string): Promise<ReadOut> {
  const clientId = conn.client_id;
  const step = readProgress(admin, clientId);
  await step(3, "Finding the store's metrics");
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const from = shift(today, -(BACKFILL_DAYS - 1));
  const from30 = shift(today, -29);
  const sinceIso = new Date(Date.parse(`${shift(today, -120)}T00:00:00Z`)).toISOString();
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  // The metrics by name (one listing): Placed Order, and list joins and leaves
  const metrics = await pulseMetrics(key).catch((e) => {
    if (isAuth(e)) throw e;
    return null;
  });
  // Nobody ranked the metrics by hand: an order system email earns through joins the ranking by itself, the one with the
  // most attributed revenue first (E11EVEN: Shopify's Placed Order and the Speakeasy integration's), see autoRank
  // The weekly look for other order systems, first, so a source found today is read today (not on the next read)
  if (conn.conversion_metric_id) {
    const rankedNow = conversionMetricsOf(conn.conversion_metrics, { id: conn.conversion_metric_id, name: conn.conversion_metric_name ?? null }).map((m) => m.id);
    await checkUnrankedSources(admin, conn, key, rankedNow, today, tz).catch((e) => {
      if (isAuth(e)) throw e;
    });
  }
  if (!conn.conversion_metric_manual && conn.conversion_metric_id) await rankBySources(admin, conn, key).catch((e) => {
    if (isAuth(e)) throw e;
  });
  // The metric that counts as the sale: one picked on the Klaviyo card (or ranked) holds; otherwise Placed Order, found by itself
  const ranked = Array.isArray(conn.conversion_metrics) && conn.conversion_metrics.length > 0;
  const picked = (conn.conversion_metric_manual || ranked) && conn.conversion_metric_id ? conn.conversion_metric_id : null;
  if (!picked && metrics?.placedOrder && metrics.placedOrder !== conn.conversion_metric_id) await admin.from("klaviyo_connections").update({ conversion_metric_id: metrics.placedOrder, conversion_metric_name: "Placed Order" }).eq("client_id", clientId);
  const metricId = picked ?? metrics?.placedOrder ?? (await metricOf(admin, conn, key));
  await step(12, "Reading the campaigns");
  const email = await listCampaigns(key, "email", sinceIso);
  const sms = await listCampaigns(key, "sms", sinceIso).catch(() => []);
  await step(24, "Reading the flows and lists");
  const flows = await listFlows(key);
  const lists = await listAudiences(key, "list");
  let segmentsOk = true;
  const segments = await listAudiences(key, "segment").catch(() => {
    segmentsOk = false;
    return [];
  });
  const names = new Map([...lists, ...segments].map((a) => [a.id, a.name]));

  // The numbers (Placed Order is the conversion): skipped, not failed, when the account has no Placed Order metric
  await step(36, "Reading each campaign's results");
  // A metric Klaviyo won't report on (some integrations' orders): campaigns and flows still come in, without revenue
  let reportable = Boolean(metricId);
  let metricNote: string | null = null;
  const values = metricId
    ? await campaignValues(key, metricId, { key: "last_90_days" }).catch((e) => {
        if (!unsupportedMetric(e)) throw e;
        reportable = false;
        metricNote = redactKey(errText(e), key).slice(0, 240);
        return [];
      })
    : [];
  await step(50, "Reading the flows' results, day by day");
  let series: SeriesRow[] = [];
  let seriesOk = false;
  let seriesError: string | null = null;
  const campSeries: SeriesRow[] | null = null; // Klaviyo has no campaign series report (404): campaigns count on their send day
  let flowStats: Map<string, { d30: Stats; d90: Stats }> = new Map();
  if (metricId && reportable) {
    try {
      series = await flowSeries(key, metricId, seriesChunks(from, today, { maxDays: 45, endIso: nowIso }));
      seriesOk = true;
      flowStats = new Map(series.map((s) => [s.id, { d30: sumSince(s, from30), d90: sumSince(s, from) }]));
    } catch (e) {
      if (isAuth(e)) throw e;
      seriesError = redactKey(errText(e), key).slice(0, 240);
      // No daily series: the flows' 30 and 90 days from the values report instead (the days wait for the next read)
      const [v30, v90] = [await flowValues(key, metricId, { key: "last_30_days" }), await flowValues(key, metricId, { key: "last_90_days" })];
      for (const f of v90) flowStats.set(f.id, { d30: v30.find((x) => x.id === f.id)?.stats ?? emptyStats(), d90: f.stats });
    }
  }

  // The store's own revenue per day (Placed Order, as Klaviyo sees it) and list joins and leaves
  await step(72, "Reading the store's revenue");
  let storeError: string | null = null;
  const store = metricId
    ? await metricDaily(key, metricId, from, today, tz).then(byDate).catch((e) => {
        storeError = redactKey(errText(e), key).slice(0, 240);
        return null;
      })
    : null;
  const subs = metrics?.subscribed ? await metricDaily(key, metrics.subscribed, from, today, tz).then(byDate).catch(() => null) : null;
  const unsubs = metrics?.unsubscribed ? await metricDaily(key, metrics.unsubscribed, from, today, tz).then(byDate).catch(() => null) : null;

  // The other metrics a lead ranked under the primary (reservations under online orders...), one after the other
  const extras = reportable ? extraMetrics(conn, metricId) : [];
  const extraReads: MetricRead[] = [];
  for (const [i, m] of extras.entries()) {
    await step(76 + i * 3, `Reading ${m.name}`);
    extraReads.push(await readMetric(key, m.id, { full: true, from, today, tz, nowIso, campaigns: true }));
  }

  // Once a week: order metrics email earns through that nobody ranked yet (a custom POS next to Toast), for the report's QA
  // (the weekly look for other order systems ran before the ranking, at the start of this read)

  // Profile counts for the main lists and segments: the ones campaigns go to most, then the newest lists
  const used = new Map<string, number>();
  for (const c of [...email, ...sms]) for (const a of c.audienceIds) used.set(a, (used.get(a) ?? 0) + 1);
  const main = [...lists, ...segments].sort((a, b) => (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0) || (a.kind === b.kind ? (b.updated ?? "").localeCompare(a.updated ?? "") : a.kind === "list" ? -1 : 1)).slice(0, MAX_SIZES);
  const sizes = new Map<string, number | null>();
  await step(88, "Counting the lists and segments");
  for (const [i, a] of main.entries()) {
    if (i) await sleep(SIZE_GAP_MS);
    sizes.set(a.id, await audienceSize(key, a.kind, a.id).catch(() => null));
  }

  const now = new Date().toISOString();
  const byCampaign = new Map(values.map((v) => [v.id, v.stats]));
  const campaignRows = [...email, ...sms].filter((c) => c.sendTime || byCampaign.has(c.id)).map((c) => campaignRow(clientId, c, byCampaign.get(c.id) ?? emptyStats(), names, now, "klaviyo", new Map([...lists, ...segments].map((a) => [a.id, { name: a.name, type: a.kind }] as const))));
  const flowRows = flows.map((f) => {
    const st = flowStats.get(f.id) ?? { d30: emptyStats(), d90: emptyStats() };
    const a = rates(st.d30);
    const b = rates(st.d90);
    return { client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, revenue_30: Math.round(st.d30.revenue * 100) / 100, recipients_30: st.d30.recipients, open_rate_30: r4(a.openRate), click_rate_30: r4(a.clickRate), conversions_30: st.d30.conversions, revenue_90: Math.round(st.d90.revenue * 100) / 100, recipients_90: st.d90.recipients, open_rate_90: r4(b.openRate), click_rate_90: r4(b.clickRate), conversions_90: st.d90.conversions, updated_at: now };
  });
  const audienceRows = [...lists, ...segments].map((a) => ({ client_id: clientId, audience_id: a.id, kind: a.kind, name: a.name, profile_count: sizes.has(a.id) ? sizes.get(a.id) : (a.profileCount ?? null), updated_at: now }));
  const days = metricId ? rollupDays({ campaigns: [...email, ...sms].map((c) => ({ sendTime: c.sendTime, channel: c.channel, stats: byCampaign.get(c.id) ?? emptyStats() })), flows: series, campaignSeries: campSeries, tz, from, to: today }) : [];

  await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");
  await save(admin, "klaviyo_flows", flowRows, "client_id,flow_id");
  await save(admin, "klaviyo_audiences", audienceRows, "client_id,audience_id");
  // Without a daily flow series the days would miss flows: only the store's day (and list movement) is written then
  if (seriesOk) await saveFlowDays(admin, clientId, series, from, now);
  if (seriesOk) await save(admin, "klaviyo_daily", days.map((d) => withStore(dayRow(clientId, d, now), store, subs, unsubs)), "client_id,date");
  else if (store || subs || unsubs) {
    const dates: string[] = [];
    for (let d = from; d <= today; d = shift(d, 1)) dates.push(d);
    await save(admin, "klaviyo_daily", dates.map((date) => withStore({ client_id: clientId, date, updated_at: now }, store, subs, unsubs)), "client_id,date");
  }
  // Every ranked metric's own numbers side by side (the primary's too), only when more than one is picked
  if (extraReads.length && metricId)
    await saveMetrics(admin, clientId, [{ id: metricId, values: byCampaign, series: seriesOk ? series : null, campaignSeries: campSeries, flows: flowStats, store, error: null }, ...extraReads], { campaigns: [...email, ...sms], tz, from, to: today, now });
  // Each read's list and segment sizes, for growth over time (kept quietly until the pulse migration is applied)
  const snap = audienceRows.filter((a) => a.profile_count != null).map((a) => ({ client_id: clientId, audience_id: a.audience_id, date: today, profile_count: a.profile_count }));
  if (snap.length) await admin.from("klaviyo_audience_sizes").upsert(snap, { onConflict: "client_id,audience_id,date" });
  // Flows, lists and segments deleted in Klaviyo go here too
  if (flows.length) await admin.from("klaviyo_flows").delete().eq("client_id", clientId).lt("updated_at", now);
  if (lists.length && segmentsOk) await admin.from("klaviyo_audiences").delete().eq("client_id", clientId).lt("updated_at", now);
  return { metricId, campaigns: campaignRows.length, flows: flowRows.length, audiences: audienceRows.length, days: seriesOk ? days.length : 0, seriesError: seriesError ?? metricNote ?? extraNote(extras, extraReads), storeError };
}

/**
 * The recent window, every run: today and yesterday's totals (and the store's), the campaigns sent in the last 7 days
 * with their numbers, and every flow's last 30 days. Two Reporting API queries (spaced per account) and a few list
 * calls; lists, segments, the 90-day numbers and anything older wait for the daily full read.
 */
async function readRecent(admin: SupabaseClient, conn: ConnRow, key: string): Promise<ReadOut> {
  const clientId = conn.client_id;
  // How far along, for the bar under Sync now (the same keys a full read uses)
  const step = readProgress(admin, clientId);
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const yesterday = shift(today, -1);
  const from7 = shift(today, -6);
  const from30 = shift(today, -29);
  const utc = (day: string) => `${day}T00:00:00+00:00`;
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  await step(8, "Finding the store's metrics");
  const metricId = await metricOf(admin, conn, key);
  await step(18, "Reading the latest campaigns and flows");
  // A day either side, so the account's own calendar days are covered whatever its time zone
  const since = new Date(Date.parse(`${shift(today, -8)}T00:00:00Z`)).toISOString();
  const email = await listCampaigns(key, "email", since, 2);
  const sms = await listCampaigns(key, "sms", since, 2).catch(() => []);
  const flows = await listFlows(key);
  const recent = [...email, ...sms].filter((c) => c.sendTime && dayIn(c.sendTime, tz) >= from7);

  await step(35, "Reading each campaign's and flow's results");
  let values: { id: string; stats: Stats }[] = [];
  let series: SeriesRow[] = [];
  let seriesOk = false;
  let seriesError: string | null = null;
  let flow30 = new Map<string, Stats>();
  const campSeries: SeriesRow[] | null = null; // Klaviyo has no campaign series report (404): campaigns count on their send day
  let metricNote: string | null = null;
  if (metricId) {
    try {
      if (recent.length) values = await orNamed(() => campaignValues(key, metricId, { start: utc(shift(today, -8)), end: nowIso }), () => campaignValues(key, metricId, { key: "last_7_days" }));
      try {
        // 31 days: inside Klaviyo's 60-day limit for a daily series
        series = await orNamed(() => flowSeries(key, metricId, { start: utc(shift(today, -31)), end: nowIso }), () => flowSeries(key, metricId, { key: "last_30_days" }));
        seriesOk = true;
        flow30 = new Map(series.map((s) => [s.id, sumSince(s, from30)]));
      } catch (e) {
        if (isAuth(e)) throw e;
        seriesError = redactKey(errText(e), key).slice(0, 240);
        flow30 = new Map((await flowValues(key, metricId, { key: "last_30_days" })).map((f) => [f.id, f.stats]));
      }
    } catch (e) {
      // A metric Klaviyo won't report on: campaigns and flows still come in, without revenue
      if (!unsupportedMetric(e)) throw e;
      metricNote = redactKey(errText(e), key).slice(0, 240);
    }
  }
  await step(70, "Reading the store's revenue");
  let storeError: string | null = null;
  const store = metricId
    ? await metricDaily(key, metricId, yesterday, today, tz).then(byDate).catch((e) => {
        storeError = redactKey(errText(e), key).slice(0, 240);
        return null;
      })
    : null;
  // The ranked metrics under the primary: the same recent window, each with its own spaced queries
  const extras = metricId && !metricNote ? extraMetrics(conn, metricId) : [];
  const extraReads: MetricRead[] = [];
  for (const m of extras) extraReads.push(await readMetric(key, m.id, { full: false, from: yesterday, today, tz, nowIso, campaigns: recent.length > 0 }));

  await step(88, "Saving the numbers");
  const now = new Date().toISOString();
  // Audience names from the last full read (lists and segments aren't listed on a recent one)
  const { data: auds } = await admin.from("klaviyo_audiences").select("audience_id, name, kind").eq("client_id", clientId);
  const lookup: AudienceLookup = new Map((auds ?? []).filter((a) => a.name).map((a) => [a.audience_id as string, { name: a.name as string, type: a.kind === "segment" ? ("segment" as const) : ("list" as const) }] as const));
  const names = new Map((auds ?? []).map((a) => [a.audience_id as string, (a.name as string | null) ?? (a.audience_id as string)]));
  const byCampaign = new Map(values.map((v) => [v.id, v.stats]));
  const campaignRows = recent.map((c) => campaignRow(clientId, c, byCampaign.get(c.id) ?? emptyStats(), names, now, "klaviyo", lookup));
  // The 30-day numbers only: the 90-day ones stay as the last full read left them
  const flowRows = metricId
    ? flows.map((f) => {
        const s = flow30.get(f.id) ?? emptyStats();
        const r = rates(s);
        return { client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, revenue_30: Math.round(s.revenue * 100) / 100, recipients_30: s.recipients, open_rate_30: r4(r.openRate), click_rate_30: r4(r.clickRate), conversions_30: s.conversions, updated_at: now };
      })
    : flows.map((f) => ({ client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, updated_at: now }));
  // The last seven days, rewritten whole: a campaign keeps earning for days after it goes out and the flows' days fill in
  // late, so a week's totals match Klaviyo between the daily full reads (not only yesterday and today, as before)
  const days = metricId && seriesOk ? rollupDays({ campaigns: recent.map((c) => ({ sendTime: c.sendTime, channel: c.channel, stats: byCampaign.get(c.id) ?? emptyStats() })), flows: series, campaignSeries: campSeries, tz, from: from7, to: today }) : [];

  await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");
  await save(admin, "klaviyo_flows", flowRows, "client_id,flow_id");
  // The first day of the 31 can be cut short by the account's time zone: the flows' days are kept from 30 days back
  if (seriesOk) await saveFlowDays(admin, clientId, series, from30, now);
  // The store's own numbers were read for yesterday and today only: the earlier days keep theirs
  if (days.length) {
    await save(admin, "klaviyo_daily", days.filter((d) => d.date >= yesterday).map((d) => withStore(dayRow(clientId, d, now), store, null, null)), "client_id,date");
    await save(admin, "klaviyo_daily", days.filter((d) => d.date < yesterday).map((d) => dayRow(clientId, d, now)), "client_id,date");
  }
  else if (store) await save(admin, "klaviyo_daily", [yesterday, today].map((date) => withStore({ client_id: clientId, date, updated_at: now }, store, null, null)), "client_id,date");
  if (extraReads.length && metricId)
    await saveMetrics(admin, clientId, [{ id: metricId, values: byCampaign, series: seriesOk ? series : null, campaignSeries: campSeries, flows: new Map([...flow30.entries()].map(([k, v]) => [k, { d30: v }])), store, error: null }, ...extraReads], { campaigns: recent, tz, from: from7, to: today, now, storeFrom: yesterday });
  return { metricId, campaigns: campaignRows.length, flows: flowRows.length, audiences: 0, days: days.length, seriesError: seriesError ?? metricNote ?? extraNote(extras, extraReads), storeError };
}

/**
 * One client's Klaviyo, read: the full window once a day (or when it never had one), the recent window otherwise.
 * `window` forces one ("auto", the default, picks). Each read is noted for Sync health, its error in plain text
 * without the key.
 */
export async function syncKlaviyo(admin: SupabaseClient, clientId: string, opts: { window?: KlaviyoWindow | "auto" } = {}): Promise<SyncResult> {
  const { data: row, error } = await admin.from("klaviyo_connections").select("*").eq("client_id", clientId).maybeSingle();
  if (error || !row) return { client: clientId, ok: false, error: error ? "Klaviyo isn't set up in the database yet." : "Klaviyo isn't connected for this client." };
  const conn = row as ConnRow;
  const { data: m } = await admin.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle();
  const memo = (m?.last_result as SyncMemo | null) ?? null;
  // Before Sync health noted the window, every read was a full one
  const lastFullAt = memo ? (memo.fullAt ?? null) : conn.last_synced_at;
  const window: KlaviyoWindow = opts.window && opts.window !== "auto" ? opts.window : pickKlaviyoWindow({ lastFullAt });
  const key = keyOf(conn);
  if (!key) {
    const msg = "The key can't be read: TOKEN_ENCRYPTION_KEY is missing or changed. Replace the key.";
    await admin.from("klaviyo_connections").update({ last_error: msg, updated_at: new Date().toISOString() }).eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: msg, account: conn.account_name });
    return { client: clientId, ok: false, window, error: "The key can't be decrypted." };
  }
  // The bar starts at once (a full read's first step, or the recent read's), never showing the last read's "Done"
  await readProgress(admin, clientId)(2, "Starting");
  try {
    const out = window === "full" ? await readFull(admin, conn, key) : await readRecent(admin, conn, key);
    // Once a day: a multi-location client's orders by restaurant, or the weekly check that suggests the flag (never fails the read)
    const locationError = window === "full" ? await import("./location-store").then((l) => l.locationStep(admin, clientId, key)).catch((e) => `Locations: ${redactKey(errText(e), key).slice(0, 200)}`) : (memo?.locationError ?? null);
    // Every read: what someone changed in the account since the last (the change history; never fails the read)
    await import("@/lib/email-ops/changes").then((c) => c.recordKlaviyoChanges(admin, clientId, key)).catch((e) => console.error("[klaviyo] change history:", redactKey(errText(e), key)));
    const now = new Date().toISOString();
    await admin
      .from("klaviyo_connections")
      .update({ last_synced_at: now, updated_at: now, status: "active", last_error: out.metricId ? null : NO_ORDERS, ...(window === "full" && out.metricId && !conn.backfilled_at ? { backfilled_at: now } : {}) })
      .eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: window === "full" ? now : lastFullAt, error: null, account: conn.account_name, seriesError: out.seriesError, storeError: out.storeError, locationError });
    await readProgress(admin, clientId)(100, "Done", { done: true });
    return { client: clientId, ok: true, window, campaigns: out.campaigns, flows: out.flows, audiences: out.audiences, days: out.days };
  } catch (e) {
    const msg = redactKey(errText(e), key);
    const refused = e instanceof KlaviyoError && (e.status === 401 || (e.status === 400 && /refused/i.test(msg)));
    await admin.from("klaviyo_connections").update({ last_error: msg, updated_at: new Date().toISOString(), ...(refused ? { status: "invalid" } : {}) }).eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: msg, account: conn.account_name });
    await readProgress(admin, clientId)(0, "Couldn't finish", { done: true, error: msg.slice(0, 200) });
    return { client: clientId, ok: false, window, error: msg };
  }
}

/**
 * The cron step, as often as the KPI numbers (every 30 minutes in business hours, hourly otherwise): every connected
 * live client, the ones read longest ago first, six at a time. Klaviyo's limits are per account, so clients run side
 * by side while each keeps its own spacing and backoff. A client isn't started without time left for its window (the
 * rest go first on the next run); one read in the last 10 minutes (Sync now) is left alone unless `force`. A client
 * whose key was refused waits for a new key.
 */
export async function syncAllKlaviyo(admin: SupabaseClient, opts: { budgetMs?: number; force?: boolean; concurrency?: number } = {}) {
  if (!(await klaviyoReady(admin))) return { skipped: "Klaviyo migration not applied" };
  const deadline = Date.now() + (opts.budgetMs ?? 600_000);
  const [{ data }, { data: memos }, { data: ranked }] = await Promise.all([
    admin.from("klaviyo_connections").select("client_id, last_synced_at, clients!inner(name, status, archived_at, services, services_extra, services_removed, strategy_only)").eq("status", "active"),
    admin.from("sync_state").select("source, last_run_at, last_result").like("source", "klaviyo:%"),
    // Read apart, so the run goes on before the ranked metrics migration is applied
    admin.from("klaviyo_connections").select("client_id, conversion_metric_id, conversion_metrics").eq("status", "active"),
  ]);
  const extraCount = new Map((ranked ?? []).map((c) => [c.client_id as string, Math.max(0, conversionMetricsOf(c.conversion_metrics, { id: (c.conversion_metric_id as string | null) ?? null, name: null }).length - 1)]));
  type Row = { client_id: string; last_synced_at: string | null; clients: { name: string; status: string; archived_at: string | null } | null };
  const memo = new Map((memos ?? []).map((x) => [String(x.source).slice("klaviyo:".length), x as { last_run_at: string | null; last_result: SyncMemo | null }]));
  const recently = new Date(Date.now() - 10 * 60_000).toISOString();
  const plan = ((data ?? []) as unknown as Row[])
    // Live clients that buy email marketing (src/lib/service-gate.ts): a removed service isn't read; adding it back catches up
    .filter((r) => r.clients && !r.clients.archived_at && (LIVE as readonly string[]).includes(r.clients.status) && hasLine(r.clients as ServiceFields, "email"))
    .map((r) => {
      const m = memo.get(r.client_id);
      const lastRun = m?.last_run_at ?? null;
      return { id: r.client_id, name: r.clients!.name, lastRun, extra: extraCount.get(r.client_id) ?? 0, window: pickKlaviyoWindow({ lastFullAt: m ? (m.last_result?.fullAt ?? null) : r.last_synced_at }) };
    })
    .filter((p) => opts.force || !p.lastRun || p.lastRun < recently)
    .sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  const t = await tracker(admin, "klaviyo", "accounts");
  t.total(plan.length);
  try {
    const r = await runBounded(plan, { limit: opts.concurrency ?? 6, deadline, cost: (p) => klaviyoCostMs(p.window, p.extra) }, async (p) => {
      t.on(p.name);
      const out = await syncKlaviyo(admin, p.id, { window: p.window });
      t.tick(p.name, out.ok);
      return out;
    });
    for (const f of r.failed) t.tick(f.item.name, false);
    const results = r.done.map((d) => d.result);
    const failed = [...results.filter((x) => !x.ok).map((x) => ({ client: x.client, error: x.error })), ...r.failed.map((f) => ({ client: f.item.id, error: f.error }))];
    const synced = results.filter((x) => x.ok).length;
    const full = results.filter((x) => x.ok && x.window === "full").length;
    await t.finish({ summary: `${synced} accounts read (${full} full)${failed.length ? `, ${failed.length} failed` : ""}${r.skipped.length ? `, ${r.skipped.length} left for the next run` : ""}` });
    return { due: plan.length, synced, full, failed, deferred: r.skipped.length };
  } catch (e) {
    await t.finish({ error: errText(e) });
    throw e;
  }
}

/// ─── What the page and the agents read ─────────────────────────────────────

export type KlaviyoCampaignView = CampaignLite & { status: string | null; previewText: string | null; audiences: string[] };
export type KlaviyoFlowView = FlowLite;
export type KlaviyoAudienceView = { id: string; kind: "list" | "segment"; name: string; profiles: number | null; growth: { change: number; since: string } | null; history: { date: string; profiles: number }[] };
export type ClientKlaviyo = {
  /** Where the numbers come from: Klaviyo, Brevo or Customer.io (the shared tables hold all three) */
  provider: EmailProvider;
  providerName: string;
  /** False when the source reports no revenue (Customer.io without a purchase event, Brevo without a store): revenue is unmeasured, not zero */
  revenueMeasured: boolean;
  /** False when the source's API doesn't list automations (Brevo): flows are unmeasured, not missing */
  flowsKnown: boolean;
  account: string | null;
  currency: string | null;
  through: string | null;
  today: string;
  now: PulseWindow;
  before: PulseWindow;
  /** 90 days: campaigns and flows per day, SMS within them, and the store's own total (null before it's read) */
  daily: { date: string; revenue: number; campaignRevenue: number; flowRevenue: number; smsRevenue: number; storeRevenue: number | null; recipients: number; subscribed: number | null; unsubscribed: number | null }[];
  campaigns: KlaviyoCampaignView[];
  flows: KlaviyoFlowView[];
  audiences: KlaviyoAudienceView[];
  keyFlows: KeyFlow[];
  health: HealthFinding[];
  /** A part of the last read that failed (the daily series, the store's revenue), in plain words */
  warning: string | null;
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const moneyOf = (cur: string | null) => (x: number) => `${!cur || cur === "USD" ? "$" : `${cur} `}${Math.round(x).toLocaleString("en-US")}`;

/**
 * A client's email and SMS pulse: the last 30 days against the 30 before (from the daily rows, or added up from the
 * campaigns and flows when the daily rows are missing), 90 days of revenue by day with the store's total, every
 * campaign of the last 120 days, flows, lists and segments with growth, the key flows and the account's health.
 * Reads through `db` (a person's session sees only clients they can see). null when nothing was synced.
 */
export async function clientKlaviyo(db: SupabaseClient, clientId: string): Promise<ClientKlaviyo | null> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const from30 = shift(today, -29);
  const from60 = shift(today, -59);
  const from90 = shift(today, -89);
  const [{ data: days, error }, { data: camps }, { data: flows }, { data: auds }, { data: conn }, { data: snaps }, { data: memo }] = await Promise.all([
    db.from("klaviyo_daily").select("*").eq("client_id", clientId).gte("date", from90).order("date"),
    db.from("klaviyo_campaigns").select("*").eq("client_id", clientId).not("send_time", "is", null).order("send_time", { ascending: false }).limit(400),
    db.from("klaviyo_flows").select("*").eq("client_id", clientId).order("revenue_30", { ascending: false }).limit(200),
    db.from("klaviyo_audiences").select("audience_id, kind, name, profile_count").eq("client_id", clientId).order("profile_count", { ascending: false, nullsFirst: false }).limit(80),
    db.from("klaviyo_connections").select("account_name, currency").eq("client_id", clientId).maybeSingle(),
    db.from("klaviyo_audience_sizes").select("audience_id, date, profile_count").eq("client_id", clientId).gte("date", shift(today, -120)).order("date"),
    db.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle(),
  ]);
  if (error || (!days?.length && !camps?.length && !flows?.length)) return null;
  // The provider: from the connection when the server's rights can read it, else from the rows' own source
  const any = (camps?.[0] ?? days?.[0] ?? flows?.[0] ?? null) as { source?: string } | null;
  const live = adminConfigured() ? await emailConnection(createAdminClient(), clientId).catch(() => null) : null;
  const provider: EmailProvider = live?.provider ?? (isEmailProvider(any?.source) ? (any!.source as EmailProvider) : "klaviyo");
  const campaigns: KlaviyoCampaignView[] = (camps ?? []).map((c) => ({
    id: c.campaign_id as string,
    name: (c.name as string | null) ?? "(untitled)",
    channel: (c.channel as string | null) ?? "email",
    status: (c.status as string | null) ?? null,
    sendTime: (c.send_time as string | null) ?? null,
    subject: (c.subject as string | null) ?? null,
    previewText: (c.preview_text as string | null) ?? null,
    audiences: (c.audiences as string[] | null) ?? [],
    recipients: num(c.recipients),
    delivered: num(c.delivered),
    opensUnique: num(c.opens_unique),
    clicksUnique: num(c.clicks_unique),
    openRate: numOrNull(c.open_rate),
    clickRate: numOrNull(c.click_rate),
    revenue: num(c.revenue),
    conversions: num(c.conversions),
    unsubscribes: num(c.unsubscribes),
    bounced: num(c.bounced),
    spamComplaints: num(c.spam_complaints),
  }));
  const flowViews: KlaviyoFlowView[] = (flows ?? []).map((f) => ({
    id: f.flow_id as string,
    name: (f.name as string | null) ?? "(untitled)",
    status: (f.status as string | null) ?? null,
    trigger: (f.trigger_type as string | null) ?? null,
    revenue30: num(f.revenue_30),
    revenue90: num(f.revenue_90),
    recipients30: num(f.recipients_30),
    recipients90: num(f.recipients_90),
    openRate30: numOrNull(f.open_rate_30),
    clickRate30: numOrNull(f.click_rate_30),
    openRate90: numOrNull(f.open_rate_90),
    clickRate90: numOrNull(f.click_rate_90),
  }));
  const dailyRows: DailyRow[] = (days ?? []).map((d) => ({
    date: d.date as string,
    revenue: num(d.revenue),
    campaignRevenue: num(d.campaign_revenue),
    flowRevenue: num(d.flow_revenue),
    smsRevenue: num(d.sms_revenue),
    sends: num(d.sends),
    recipients: num(d.campaign_recipients) + num(d.flow_recipients),
    campaignsSent: num(d.campaigns_sent),
    storeRevenue: d.store_revenue == null ? null : Number(d.store_revenue),
    storeOrders: d.store_orders == null ? null : Number(d.store_orders),
    subscribed: d.subscribed == null ? null : Number(d.subscribed),
    unsubscribed: d.unsubscribed == null ? null : Number(d.unsubscribed),
  }));
  const flow30 = flowViews.reduce((s, f) => s + f.revenue30, 0);
  const flow90 = flowViews.reduce((s, f) => s + f.revenue90, 0);
  const rec30 = flowViews.reduce((s, f) => s + f.recipients30, 0);
  const rec90 = flowViews.reduce((s, f) => s + f.recipients90, 0);
  const now = pulseWindow({ days: dailyRows, campaigns, start: from30, end: today, flowTotal: flow30, flowRecipients: rec30 });
  // The 30 days before: the flows' share of their 90 days after the last 30 (an even split of the 60 before)
  const before = pulseWindow({ days: dailyRows, campaigns, start: from60, end: shift(from30, -1), flowTotal: Math.max(0, flow90 - flow30) / 2, flowRecipients: Math.max(0, rec90 - rec30) / 2 });
  // A source that doesn't list automations has no key flows to judge: they're unknown, never "missing"
  const flowsKnown = providerHasFlows(provider);
  const keyFlows = flowsKnown ? keyFlowCoverage(flowViews) : [];
  const currency = live?.currency ?? (conn?.currency as string | null) ?? null;
  const sizes = new Map<string, { date: string; profiles: number }[]>();
  for (const s of snaps ?? []) {
    const list = sizes.get(s.audience_id as string) ?? [];
    list.push({ date: s.date as string, profiles: Number(s.profile_count) });
    sizes.set(s.audience_id as string, list);
  }
  const m = (memo?.last_result as SyncMemo | null) ?? null;
  const warn = partialSyncWarning(m);
  return {
    provider,
    providerName: providerName(provider),
    revenueMeasured: live ? live.revenueRead : provider === "klaviyo",
    flowsKnown,
    account: live?.account ?? (conn?.account_name as string | null) ?? null,
    currency,
    through: dailyRows.filter((d) => d.revenue || d.sends || d.storeRevenue).map((d) => d.date).at(-1) ?? null,
    today,
    now,
    before,
    daily: dailyRows.map((d) => ({ date: d.date, revenue: d.revenue, campaignRevenue: d.campaignRevenue, flowRevenue: d.flowRevenue, smsRevenue: d.smsRevenue, storeRevenue: d.storeRevenue, recipients: d.recipients ?? 0, subscribed: d.subscribed, unsubscribed: d.unsubscribed })),
    campaigns,
    flows: flowViews,
    audiences: (auds ?? []).map((a) => {
      const hist = sizes.get(a.audience_id as string) ?? [];
      return { id: a.audience_id as string, kind: a.kind as "list" | "segment", name: (a.name as string | null) ?? "(untitled)", profiles: a.profile_count == null ? null : Number(a.profile_count), growth: audienceGrowth(hist), history: hist };
    }),
    keyFlows,
    health: emailHealth({ now, before, campaigns, flows: flowViews, keyFlows, today, money: moneyOf(currency), flowsKnown }),
    warning: warn?.message ?? null,
  };
}

/** The best (by revenue) and weakest (by open rate) email campaigns of the last 90 days with a real send */
export function topAndBottom(k: ClientKlaviyo) {
  const from = shift(k.today, -89);
  const sent = k.campaigns.filter((c) => c.sendTime && c.sendTime.slice(0, 10) >= from && c.recipients >= 200);
  return { top: sortCampaigns(sent, "revenue").slice(0, 3), bottom: sortCampaigns(sent.filter((c) => c.channel !== "sms" && c.openRate != null), "open", "asc").slice(0, 3) };
}

/** The Klaviyo context every agent reads (empty when the client has no Klaviyo numbers) */
export async function klaviyoBrief(db: SupabaseClient, clientId: string): Promise<string> {
  const k = await clientKlaviyo(db, clientId).catch(() => null);
  if (!k) return "";
  let storeRevenue = k.now.storeRevenue;
  if (storeRevenue == null) {
    // No Placed Order total read yet: a connected store's own revenue, when there is one
    const { data: biz } = await db.from("client_business_daily").select("revenue").eq("client_id", clientId).gt("date", shift(k.today, -30));
    storeRevenue = (biz ?? []).reduce((s, r) => s + num(r.revenue), 0) || null;
  }
  const { top, bottom } = topAndBottom(k);
  return emailContextLine({
    provider: k.providerName,
    revenueMeasured: k.revenueMeasured,
    account: k.account,
    currency: k.currency,
    now: k.now,
    before: k.before,
    recent: k.campaigns,
    storeRevenue,
    through: k.through,
    pulse: { share: storeRevenue ? k.now.revenue / storeRevenue : null, storeRevenue, estimated: k.now.estimated, health: k.health, keyFlows: k.keyFlows, top, bottom },
  });
}

// ─── Previews ──────────────────────────────────────────────────────────────

export type CampaignPreview = { channel: string; subject: string | null; previewText: string | null; html: string | null; body: string | null; fetchedAt: string };

/**
 * What a campaign looked like, for the hover preview: the email's HTML (made safe on the way in) or the SMS text.
 * Read from the cache when it's there, else from Klaviyo (read only) and cached. Only a campaign this client has.
 */
export async function campaignPreview(admin: SupabaseClient, clientId: string, campaignId: string): Promise<{ ok: true; preview: CampaignPreview } | { ok: false; error: string }> {
  const { data: camp } = await admin.from("klaviyo_campaigns").select("campaign_id, channel, subject, preview_text").eq("client_id", clientId).eq("campaign_id", campaignId).maybeSingle();
  if (!camp) return { ok: false, error: "That campaign isn't one of this client's." };
  const { data: cached } = await admin.from("klaviyo_previews").select("channel, subject, preview_text, html, body, fetched_at").eq("client_id", clientId).eq("campaign_id", campaignId).maybeSingle();
  if (cached && (cached.html || cached.body)) return { ok: true, preview: { channel: (cached.channel as string | null) ?? "email", subject: (cached.subject as string | null) ?? null, previewText: (cached.preview_text as string | null) ?? null, html: (cached.html as string | null) ?? null, body: (cached.body as string | null) ?? null, fetchedAt: cached.fetched_at as string } };
  const { data: row } = await admin.from("klaviyo_connections").select("*").eq("client_id", clientId).maybeSingle();
  if (!row) return { ok: false, error: "Klaviyo isn't connected for this client." };
  const key = keyOf(row as ConnRow);
  if (!key) return { ok: false, error: "The Klaviyo key can't be read: replace it in Team & setup." };
  try {
    const c = await campaignContent(key, campaignId);
    const channel = c.channel ?? (camp.channel as string | null) ?? "email";
    const html = c.html ? sanitizeEmailHtml(c.html) : null;
    const body = channel === "sms" ? c.body : c.text;
    const fetchedAt = new Date().toISOString();
    if (!html && !body) return { ok: false, error: "Klaviyo has no content for this campaign." };
    const preview: CampaignPreview = { channel, subject: c.subject ?? (camp.subject as string | null) ?? null, previewText: c.previewText ?? (camp.preview_text as string | null) ?? null, html, body: body ?? null, fetchedAt };
    // Cached for the next hover (quietly skipped until the pulse migration is applied)
    await admin.from("klaviyo_previews").upsert({ client_id: clientId, campaign_id: campaignId, message_id: c.messageId, channel, subject: preview.subject, preview_text: preview.previewText, html, body: preview.body, fetched_at: fetchedAt }, { onConflict: "client_id,campaign_id" });
    return { ok: true, preview };
  } catch (e) {
    const msg = redactKey(errText(e), key);
    return { ok: false, error: /can't read everything|403/.test(msg) ? "This key can't read templates: replace it with a Full Access key to see previews." : msg.slice(0, 200) };
  }
}



/**
 * The account's metrics, to pick the one that counts as the sale (Klaviyo's own Conversion metric: Placed Order from
 * Toast, Bought Ticket from Eventbrite...), with the one in use now. Several can share a name, so each carries its
 * integration.
 */
export async function klaviyoMetricChoices(admin: SupabaseClient, clientId: string): Promise<{ ok: true; current: string | null; manual: boolean; metrics: { id: string; name: string; integration: string | null }[] } | { ok: false; error: string }> {
  const { data: row } = await admin.from("klaviyo_connections").select("*").eq("client_id", clientId).maybeSingle();
  if (!row) return { ok: false, error: "Klaviyo isn't connected for this client." };
  const conn = row as ConnRow;
  const key = keyOf(conn);
  if (!key) return { ok: false, error: "The saved key can't be read. Replace the key." };
  try {
    return { ok: true, current: conn.conversion_metric_id, manual: Boolean(conn.conversion_metric_manual), metrics: await listMetrics(key) };
  } catch (e) {
    return { ok: false, error: redactKey(errText(e), key).slice(0, 240) };
  }
}

/** Use this metric as the sale for the account (kept over the automatic Placed Order pick), then read 90 days again */
export async function setKlaviyoMetric(admin: SupabaseClient, clientId: string, metric: { id: string; name: string }, by: string) {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("klaviyo_connections")
    .update({ conversion_metric_id: metric.id, conversion_metric_name: metric.name.slice(0, 120), conversion_metric_manual: true, conversion_metric_set_by: by, conversion_metric_set_at: now, status: "active", last_error: null, updated_at: now })
    .eq("client_id", clientId);
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

/**
 * Use these metrics as the sale, ranked (primary first, four at most). The primary also goes in conversion_metric_id and
 * conversion_metric_name, which everything older reads; it's kept over the automatic Placed Order pick. Says whether the
 * numbers need reading again (a new primary or a metric not read before): a reorder or a removal below the primary only
 * changes the weights.
 */
export async function setKlaviyoMetrics(admin: SupabaseClient, clientId: string, metrics: ConversionMetric[], by: string): Promise<{ ok: true; reread: boolean } | { ok: false; error: string }> {
  const list = conversionMetricsOf(metrics, { id: null, name: null });
  if (!list.length) return { ok: false, error: "Pick at least one metric." };
  const { data: was } = await admin.from("klaviyo_connections").select("conversion_metric_id, conversion_metric_name, conversion_metrics").eq("client_id", clientId).maybeSingle();
  const before = was ? conversionMetricsOf(was.conversion_metrics, { id: (was.conversion_metric_id as string | null) ?? null, name: (was.conversion_metric_name as string | null) ?? null }).map((m) => m.id) : [];
  const now = new Date().toISOString();
  const { error } = await admin
    .from("klaviyo_connections")
    .update({ conversion_metrics: list, conversion_metric_id: list[0].id, conversion_metric_name: list[0].name.slice(0, 120), conversion_metric_manual: true, conversion_metric_set_by: by, conversion_metric_set_at: now, status: "active", last_error: null, updated_at: now })
    .eq("client_id", clientId);
  if (error) return { ok: false, error: /conversion_metrics/.test(error.message) ? "Ranking several metrics needs the latest database update. Pick one for now." : error.message };
  return { ok: true, reread: before[0] !== list[0].id || list.some((m) => !before.includes(m.id)) };
}

// ─── Deeper history, on demand ─────────────────────────────────────────────

export type HistoryRead = { cursor: string; done: boolean; error: string | null; days: number; campaigns: number };

/**
 * Reads days before what is stored: campaigns (email and SMS) with their numbers, the flows' numbers per day, each
 * day's totals, the store's own revenue and list movement, and every ranked conversion metric's daily revenue. It goes
 * newest first in pieces of 45 days (Klaviyo's daily series refuse more than 60), each piece a handful of spaced
 * Reporting API queries; it stops when the time is up and the caller picks it up from the cursor. Rows are upserted by
 * their keys, so a piece read twice is the same rows; nothing is deleted, and the days already stored are never
 * overwritten (a piece ends the day before what was stored).
 */
export async function readKlaviyoHistory(admin: SupabaseClient, clientId: string, job: { from: string; to: string; cursor: string | null }, opts: { budgetMs: number; piece: (cursor: string, pct: number, step: string) => Promise<void> }): Promise<HistoryRead> {
  const { data: row } = await admin.from("klaviyo_connections").select("*").eq("client_id", clientId).maybeSingle();
  if (!row) return { cursor: job.cursor ?? job.to, done: false, error: "Klaviyo is not connected for this client.", days: 0, campaigns: 0 };
  const conn = row as ConnRow;
  const key = keyOf(conn);
  if (!key) return { cursor: job.cursor ?? job.to, done: false, error: "The key can not be read: replace it in Team & setup.", days: 0, campaigns: 0 };
  const { historyWindows } = await import("@/lib/email-history/core");
  const deadline = Date.now() + opts.budgetMs;
  const tz = conn.timezone;
  const nowMs = Date.now();
  let cursor = job.cursor ?? shift(job.to, 1);
  let daysDone = 0;
  let campaignsDone = 0;
  try {
    const metricId = await metricOf(admin, conn, key);
    const extras = metricId ? extraMetrics(conn, metricId) : [];
    const metrics = await pulseMetrics(key).catch((e) => {
      if (isAuth(e)) throw e;
      return null;
    });
    // Every campaign since the start (one listing; the numbers are read piece by piece)
    const since = new Date(Date.parse(`${job.from}T00:00:00Z`)).toISOString();
    const email = await listCampaigns(key, "email", since, 80);
    const sms = await listCampaigns(key, "sms", since, 40).catch(() => []);
    const all = [...email, ...sms];
    const names = new Map<string, string>();
    const windows = historyWindows(job.from, shift(cursor, -1));
    const span = Math.max(1, windows.length);
    const utc = (d: string) => `${d}T00:00:00+00:00`;
    for (const [n, w] of windows.entries()) {
      // About two minutes a piece with the spacing; never started without the time for it
      if (n > 0 && Date.now() + 120_000 > deadline) break;
      const sent = all.filter((c) => c.sendTime && dayIn(c.sendTime, tz) >= w.start && dayIn(c.sendTime, tz) <= w.end);
      // A campaign keeps earning after it goes: its numbers are read to 30 days past the piece (never past now)
      const readTo = new Date(Math.min(nowMs - 60_000, Date.parse(`${shift(w.end, 31)}T00:00:00Z`))).toISOString().replace(/\.\d+Z$/, "+00:00");
      let values: { id: string; stats: Stats }[] = [];
      let series: SeriesRow[] = [];
      let seriesOk = false;
      let store: Map<string, DayValue> | null = null;
      if (metricId) {
        if (sent.length)
          values = await campaignValues(key, metricId, { start: utc(w.start), end: readTo }).catch((e) => {
            if (isAuth(e)) throw e;
            return [];
          });
        try {
          series = await flowSeries(key, metricId, seriesChunks(w.start, w.end, { maxDays: 45 }));
          seriesOk = true;
        } catch (e) {
          if (isAuth(e)) throw e;
        }
        store = await metricDaily(key, metricId, w.start, w.end, tz).then(byDate).catch(() => null);
      }
      const subs = metrics?.subscribed ? await metricDaily(key, metrics.subscribed, w.start, w.end, tz).then(byDate).catch(() => null) : null;
      const unsubs = metrics?.unsubscribed ? await metricDaily(key, metrics.unsubscribed, w.start, w.end, tz).then(byDate).catch(() => null) : null;
      const byCampaign = new Map(values.map((v) => [v.id, v.stats]));
      const now = new Date().toISOString();
      const campaignRows = sent.map((c) => {
        const r: Record<string, unknown> = { ...campaignRow(clientId, c, byCampaign.get(c.id) ?? emptyStats(), names, now, "klaviyo") };
        delete r.audiences_detail;
        return r;
      });
      await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");
      if (seriesOk) {
        await saveFlowDays(admin, clientId, series, w.start, now);
        const days = rollupDays({ campaigns: sent.map((c) => ({ sendTime: c.sendTime, channel: c.channel, stats: byCampaign.get(c.id) ?? emptyStats() })), flows: series, tz, from: w.start, to: w.end });
        await save(admin, "klaviyo_daily", days.map((d) => withStore(dayRow(clientId, d, now), store, subs, unsubs)), "client_id,date");
      } else if (store || subs || unsubs) {
        const dates: string[] = [];
        for (let d = w.start; d <= w.end; d = shift(d, 1)) dates.push(d);
        await save(admin, "klaviyo_daily", dates.map((date) => withStore({ client_id: clientId, date, updated_at: now }, store, subs, unsubs)), "client_id,date");
      }
      // The ranked metrics' own daily revenue (the primary's too once more than one is picked)
      if (metricId && extras.length) {
        const reads: MetricRead[] = [{ id: metricId, values: byCampaign, series: seriesOk ? series : null, flows: new Map(), store, error: null }];
        for (const m of extras) {
          const v = sent.length ? await campaignValues(key, m.id, { start: utc(w.start), end: readTo }).catch(() => []) : [];
          const s = await flowSeries(key, m.id, seriesChunks(w.start, w.end, { maxDays: 45 })).catch(() => null);
          const st = await metricDaily(key, m.id, w.start, w.end, tz).then(byDate).catch(() => null);
          reads.push({ id: m.id, values: new Map(v.map((x) => [x.id, x.stats])), series: s, flows: new Map(), store: st, error: null });
        }
        for (const m of reads) {
          const rows = metricTableRows(clientId, m, { campaigns: sent, tz, from: w.start, to: w.end, now });
          const parts: [string, Record<string, unknown>[], string][] = [
            ["klaviyo_campaign_metrics", rows.campaigns, "client_id,campaign_id,metric_id"],
            ["klaviyo_metric_daily", rows.days, "client_id,metric_id,date"],
          ];
          for (const [table, all, conflict] of parts) {
            const list = await onlyChanged(admin, table, all, conflict);
            for (let i = 0; i < list.length; i += 500) await admin.from(table).upsert(list.slice(i, i + 500), { onConflict: conflict });
          }
        }
      }
      cursor = w.start;
      daysDone += Math.round((Date.parse(`${w.end}T12:00:00Z`) - Date.parse(`${w.start}T12:00:00Z`)) / 86_400_000) + 1;
      campaignsDone += sent.length;
      // The cursor is kept after each piece, so a stopped read goes on from here
      await opts.piece(cursor, Math.min(95, 8 + Math.round(((n + 1) / span) * 88)), `Read back to ${w.start}`);
    }
    return { cursor, done: cursor <= job.from, error: null, days: daysDone, campaigns: campaignsDone };
  } catch (e) {
    return { cursor, done: false, error: redactKey(errText(e), key).slice(0, 240), days: daysDone, campaigns: campaignsDone };
  }
}
