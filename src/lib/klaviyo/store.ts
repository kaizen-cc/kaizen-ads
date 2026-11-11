import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptionKey, seal, unseal } from "@/lib/meta-token-core";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { audienceSize, campaignValues, flowSeries, flowValues, getAccount, KlaviyoError, listAudiences, listCampaigns, listFlows, placedOrderMetric } from "./api";
import { BACKFILL_DAYS, cleanKey, dayIn, emailContextLine, emptyStats, keyLast4, keyProblem, klaviyoClientState, klaviyoCostMs, pickKlaviyoWindow, rates, redactKey, rollupDays, sumSince, type CampaignInfo, type EmailCampaignLine, type EmailWindow, type KlaviyoClientState, type KlaviyoPlainError, type KlaviyoWindow, type SeriesRow, type Stats } from "./core";
import { tracker } from "@/lib/progress";
import { runBounded } from "@/lib/bounded";

// Klaviyo in Kaizen Ads: each client's connection (a read-only private API key, encrypted at rest), the daily sync
// (campaigns, flows, lists and segments, the account's totals per day), and what the client page and the agents read.
// Read only. Everything returns early, touching nothing, until the Klaviyo migration is applied.

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 10000);

type ConnRow = { client_id: string; account_id: string; account_name: string | null; timezone: string | null; currency: string | null; key_iv: string; key_tag: string; key_ciphertext: string; key_last4: string | null; conversion_metric_id: string | null; status: string; last_synced_at: string | null; backfilled_at: string | null; last_error: string | null; connected_at: string; connected_by: string | null };

/** Whether the Klaviyo tables exist (the migration applied) */
export async function klaviyoReady(admin: SupabaseClient) {
  const { error } = await admin.from("klaviyo_connections").select("client_id").limit(1);
  return !error;
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
  await Promise.all(["klaviyo_campaigns", "klaviyo_flows", "klaviyo_audiences", "klaviyo_daily"].map((t) => admin.from(t).delete().eq("client_id", clientId)));
}

/** Remove: the key is deleted; the email history already read stays with the client (client knowledge is never deleted) */
export async function removeKlaviyo(admin: SupabaseClient, clientId: string) {
  const { error } = await admin.from("klaviyo_connections").delete().eq("client_id", clientId);
  if (error) return { ok: false as const, error: error.message };
  await admin.from("sync_state").delete().eq("source", `klaviyo:${clientId}`);
  return { ok: true as const };
}

export type KlaviyoConnectionView = { account: string | null; accountId: string; timezone: string | null; currency: string | null; last4: string | null; status: string; lastSyncedAt: string | null; backfilled: boolean; error: string | null; connectedAt: string; by: string | null };

/** The client's connection as Team & setup shows it: null when not connected; undefined when Klaviyo isn't set up */
export async function klaviyoConnection(admin: SupabaseClient, clientId: string): Promise<KlaviyoConnectionView | null | undefined> {
  const { data, error } = await admin.from("klaviyo_connections").select("account_id, account_name, timezone, currency, key_last4, status, last_synced_at, backfilled_at, last_error, connected_at, profiles:connected_by(full_name)").eq("client_id", clientId).maybeSingle();
  if (error) return undefined;
  if (!data) return null;
  return {
    account: (data.account_name as string | null) ?? null,
    accountId: data.account_id as string,
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
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", LIVE).order("name"),
    admin.from("sync_state").select("source, last_result").like("source", "klaviyo:%"),
  ]);
  if (error) return null;
  const by = new Map((conns ?? []).map((c) => [c.client_id as string, c]));
  // Only the clients Kaizen runs email for: the email marketing service, or a Klaviyo already connected
  const list = (clients ?? []).filter((c) => by.has(c.id as string) || (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes("email-marketing"));
  const memo = new Map((memos ?? []).map((m) => [String(m.source).slice("klaviyo:".length), (m.last_result ?? {}) as { window?: KlaviyoWindow; fullAt?: string | null }]));
  return list.map((c) => {
    const k = by.get(c.id as string);
    const m = memo.get(c.id as string);
    const st = klaviyoClientState(k ? { status: k.status as string, lastSyncedAt: (k.last_synced_at as string | null) ?? null, error: (k.last_error as string | null) ?? null } : null);
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
type SyncMemo = { window?: KlaviyoWindow; fullAt?: string | null; error?: string | null; account?: string | null };
const memoSource = (clientId: string) => `klaviyo:${clientId}`;
async function saveMemo(admin: SupabaseClient, clientId: string, memo: SyncMemo) {
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

function campaignRow(clientId: string, c: CampaignInfo, s: Stats, names: Map<string, string>, now: string) {
  const r = rates(s);
  return { client_id: clientId, campaign_id: c.id, name: c.name, channel: c.channel, status: c.status, send_time: c.sendTime, audiences: c.audienceIds.map((a) => names.get(a) ?? a), subject: c.subject, preview_text: c.previewText, recipients: s.recipients, delivered: s.delivered, opens_unique: s.opensUnique, open_rate: r4(r.openRate), clicks_unique: s.clicksUnique, click_rate: r4(r.clickRate), unsubscribes: s.unsubscribes, bounced: s.bounced, spam_complaints: s.spamComplaints, conversions: s.conversions, revenue: Math.round(s.revenue * 100) / 100, updated_at: now };
}
const dayRow = (clientId: string, d: ReturnType<typeof rollupDays>[number], now: string) => ({ client_id: clientId, date: d.date, campaign_revenue: d.campaignRevenue, flow_revenue: d.flowRevenue, revenue: d.revenue, campaign_recipients: d.campaignRecipients, flow_recipients: d.flowRecipients, sends: d.sends, campaigns_sent: d.campaignsSent, conversions: d.conversions, updated_at: now });

async function save(admin: SupabaseClient, table: string, rows: Record<string, unknown>[], conflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await admin.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict });
    if (e) throw new Error(`Saving ${table}: ${e.message}`);
  }
}

type ReadOut = { metricId: string | null; campaigns: number; flows: number; audiences: number; days: number };

/**
 * The full window: campaigns (email and SMS) of the last 120 days with their numbers, flows with 30 and 90 days of
 * numbers, lists and segments (the main ones with their size), and each day's totals for 90 days. Calls go one at a
 * time; the Reporting API (2 queries a minute per account) is spaced, and refusals wait and retry.
 */
async function readFull(admin: SupabaseClient, conn: ConnRow, key: string): Promise<ReadOut> {
  const clientId = conn.client_id;
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const from = shift(today, -(BACKFILL_DAYS - 1));
  const from30 = shift(today, -29);
  const sinceIso = new Date(Date.parse(`${shift(today, -120)}T00:00:00Z`)).toISOString();
  const metricId = await metricOf(admin, conn, key);
  const email = await listCampaigns(key, "email", sinceIso);
  const sms = await listCampaigns(key, "sms", sinceIso).catch(() => []);
  const flows = await listFlows(key);
  const lists = await listAudiences(key, "list");
  let segmentsOk = true;
  const segments = await listAudiences(key, "segment").catch(() => {
    segmentsOk = false;
    return [];
  });
  const names = new Map([...lists, ...segments].map((a) => [a.id, a.name]));

  // The numbers (Placed Order is the conversion): skipped, not failed, when the account has no Placed Order metric
  const values = metricId ? await campaignValues(key, metricId, { key: "last_90_days" }) : [];
  let series: SeriesRow[] = [];
  let seriesOk = false;
  let flowStats: Map<string, { d30: Stats; d90: Stats }> = new Map();
  if (metricId) {
    try {
      series = await flowSeries(key, metricId, { key: "last_90_days" });
      seriesOk = true;
      flowStats = new Map(series.map((s) => [s.id, { d30: sumSince(s, from30), d90: sumSince(s, from) }]));
    } catch (e) {
      if (isAuth(e)) throw e;
      // No daily series: the flows' 30 and 90 days from the values report instead
      const [v30, v90] = [await flowValues(key, metricId, { key: "last_30_days" }), await flowValues(key, metricId, { key: "last_90_days" })];
      for (const f of v90) flowStats.set(f.id, { d30: v30.find((x) => x.id === f.id)?.stats ?? emptyStats(), d90: f.stats });
    }
  }

  // Profile counts for the main lists and segments: the ones campaigns go to most, then the newest lists
  const used = new Map<string, number>();
  for (const c of [...email, ...sms]) for (const a of c.audienceIds) used.set(a, (used.get(a) ?? 0) + 1);
  const main = [...lists, ...segments].sort((a, b) => (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0) || (a.kind === b.kind ? (b.updated ?? "").localeCompare(a.updated ?? "") : a.kind === "list" ? -1 : 1)).slice(0, MAX_SIZES);
  const sizes = new Map<string, number | null>();
  for (const [i, a] of main.entries()) {
    if (i) await sleep(SIZE_GAP_MS);
    sizes.set(a.id, await audienceSize(key, a.kind, a.id).catch(() => null));
  }

  const now = new Date().toISOString();
  const byCampaign = new Map(values.map((v) => [v.id, v.stats]));
  const campaignRows = [...email, ...sms].filter((c) => c.sendTime || byCampaign.has(c.id)).map((c) => campaignRow(clientId, c, byCampaign.get(c.id) ?? emptyStats(), names, now));
  const flowRows = flows.map((f) => {
    const st = flowStats.get(f.id) ?? { d30: emptyStats(), d90: emptyStats() };
    const a = rates(st.d30);
    const b = rates(st.d90);
    return { client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, revenue_30: Math.round(st.d30.revenue * 100) / 100, recipients_30: st.d30.recipients, open_rate_30: r4(a.openRate), click_rate_30: r4(a.clickRate), conversions_30: st.d30.conversions, revenue_90: Math.round(st.d90.revenue * 100) / 100, recipients_90: st.d90.recipients, open_rate_90: r4(b.openRate), click_rate_90: r4(b.clickRate), conversions_90: st.d90.conversions, updated_at: now };
  });
  const audienceRows = [...lists, ...segments].map((a) => ({ client_id: clientId, audience_id: a.id, kind: a.kind, name: a.name, profile_count: sizes.has(a.id) ? sizes.get(a.id) : (a.profileCount ?? null), updated_at: now }));
  const days = metricId ? rollupDays({ campaigns: [...email, ...sms].map((c) => ({ sendTime: c.sendTime, stats: byCampaign.get(c.id) ?? emptyStats() })), flows: series, tz, from, to: today }) : [];

  await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");
  await save(admin, "klaviyo_flows", flowRows, "client_id,flow_id");
  await save(admin, "klaviyo_audiences", audienceRows, "client_id,audience_id");
  // Without a daily flow series the days would miss flows: the old rows are left as they are
  if (seriesOk) await save(admin, "klaviyo_daily", days.map((d) => dayRow(clientId, d, now)), "client_id,date");
  // Flows, lists and segments deleted in Klaviyo go here too
  if (flows.length) await admin.from("klaviyo_flows").delete().eq("client_id", clientId).lt("updated_at", now);
  if (lists.length && segmentsOk) await admin.from("klaviyo_audiences").delete().eq("client_id", clientId).lt("updated_at", now);
  return { metricId, campaigns: campaignRows.length, flows: flowRows.length, audiences: audienceRows.length, days: seriesOk ? days.length : 0 };
}

/**
 * The recent window, every run: today and yesterday's totals, the campaigns sent in the last 7 days with their
 * numbers, and every flow's last 30 days. Two Reporting API queries (spaced per account) and a few list calls; lists,
 * segments, the 90-day numbers and anything older wait for the daily full read.
 */
async function readRecent(admin: SupabaseClient, conn: ConnRow, key: string): Promise<ReadOut> {
  const clientId = conn.client_id;
  const tz = conn.timezone;
  const today = dayIn(new Date().toISOString(), tz);
  const yesterday = shift(today, -1);
  const from7 = shift(today, -6);
  const from30 = shift(today, -29);
  const utc = (day: string) => `${day}T00:00:00+00:00`;
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const metricId = await metricOf(admin, conn, key);
  // A day either side, so the account's own calendar days are covered whatever its time zone
  const since = new Date(Date.parse(`${shift(today, -8)}T00:00:00Z`)).toISOString();
  const email = await listCampaigns(key, "email", since, 2);
  const sms = await listCampaigns(key, "sms", since, 2).catch(() => []);
  const flows = await listFlows(key);
  const recent = [...email, ...sms].filter((c) => c.sendTime && dayIn(c.sendTime, tz) >= from7);

  let values: { id: string; stats: Stats }[] = [];
  let series: SeriesRow[] = [];
  let seriesOk = false;
  let flow30 = new Map<string, Stats>();
  if (metricId) {
    if (recent.length) values = await orNamed(() => campaignValues(key, metricId, { start: utc(shift(today, -8)), end: nowIso }), () => campaignValues(key, metricId, { key: "last_7_days" }));
    try {
      series = await orNamed(() => flowSeries(key, metricId, { start: utc(shift(today, -31)), end: nowIso }), () => flowSeries(key, metricId, { key: "last_30_days" }));
      seriesOk = true;
      flow30 = new Map(series.map((s) => [s.id, sumSince(s, from30)]));
    } catch (e) {
      if (isAuth(e)) throw e;
      flow30 = new Map((await flowValues(key, metricId, { key: "last_30_days" })).map((f) => [f.id, f.stats]));
    }
  }

  const now = new Date().toISOString();
  // Audience names from the last full read (lists and segments aren't listed on a recent one)
  const { data: auds } = await admin.from("klaviyo_audiences").select("audience_id, name").eq("client_id", clientId);
  const names = new Map((auds ?? []).map((a) => [a.audience_id as string, (a.name as string | null) ?? (a.audience_id as string)]));
  const byCampaign = new Map(values.map((v) => [v.id, v.stats]));
  const campaignRows = recent.map((c) => campaignRow(clientId, c, byCampaign.get(c.id) ?? emptyStats(), names, now));
  // The 30-day numbers only: the 90-day ones stay as the last full read left them
  const flowRows = metricId
    ? flows.map((f) => {
        const s = flow30.get(f.id) ?? emptyStats();
        const r = rates(s);
        return { client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, revenue_30: Math.round(s.revenue * 100) / 100, recipients_30: s.recipients, open_rate_30: r4(r.openRate), click_rate_30: r4(r.clickRate), conversions_30: s.conversions, updated_at: now };
      })
    : flows.map((f) => ({ client_id: clientId, flow_id: f.id, name: f.name, status: f.status, trigger_type: f.triggerType, updated_at: now }));
  const days = metricId && seriesOk ? rollupDays({ campaigns: recent.map((c) => ({ sendTime: c.sendTime, stats: byCampaign.get(c.id) ?? emptyStats() })), flows: series, tz, from: yesterday, to: today }) : [];

  await save(admin, "klaviyo_campaigns", campaignRows, "client_id,campaign_id");
  await save(admin, "klaviyo_flows", flowRows, "client_id,flow_id");
  if (days.length) await save(admin, "klaviyo_daily", days.map((d) => dayRow(clientId, d, now)), "client_id,date");
  return { metricId, campaigns: campaignRows.length, flows: flowRows.length, audiences: 0, days: days.length };
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
  try {
    const out = window === "full" ? await readFull(admin, conn, key) : await readRecent(admin, conn, key);
    const now = new Date().toISOString();
    await admin
      .from("klaviyo_connections")
      .update({ last_synced_at: now, updated_at: now, status: "active", last_error: out.metricId ? null : NO_ORDERS, ...(window === "full" && out.metricId && !conn.backfilled_at ? { backfilled_at: now } : {}) })
      .eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: window === "full" ? now : lastFullAt, error: null, account: conn.account_name });
    return { client: clientId, ok: true, window, campaigns: out.campaigns, flows: out.flows, audiences: out.audiences, days: out.days };
  } catch (e) {
    const msg = redactKey(errText(e), key);
    const refused = e instanceof KlaviyoError && (e.status === 401 || (e.status === 400 && /refused/i.test(msg)));
    await admin.from("klaviyo_connections").update({ last_error: msg, updated_at: new Date().toISOString(), ...(refused ? { status: "invalid" } : {}) }).eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: msg, account: conn.account_name });
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
  const [{ data }, { data: memos }] = await Promise.all([
    admin.from("klaviyo_connections").select("client_id, last_synced_at, clients!inner(name, status, archived_at)").eq("status", "active"),
    admin.from("sync_state").select("source, last_run_at, last_result").like("source", "klaviyo:%"),
  ]);
  type Row = { client_id: string; last_synced_at: string | null; clients: { name: string; status: string; archived_at: string | null } | null };
  const memo = new Map((memos ?? []).map((x) => [String(x.source).slice("klaviyo:".length), x as { last_run_at: string | null; last_result: SyncMemo | null }]));
  const recently = new Date(Date.now() - 10 * 60_000).toISOString();
  const plan = ((data ?? []) as unknown as Row[])
    .filter((r) => r.clients && !r.clients.archived_at && (LIVE as readonly string[]).includes(r.clients.status))
    .map((r) => {
      const m = memo.get(r.client_id);
      const lastRun = m?.last_run_at ?? null;
      return { id: r.client_id, name: r.clients!.name, lastRun, window: pickKlaviyoWindow({ lastFullAt: m ? (m.last_result?.fullAt ?? null) : r.last_synced_at }) };
    })
    .filter((p) => opts.force || !p.lastRun || p.lastRun < recently)
    .sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  const t = await tracker(admin, "klaviyo", "accounts");
  t.total(plan.length);
  try {
    const r = await runBounded(plan, { limit: opts.concurrency ?? 6, deadline, cost: (p) => klaviyoCostMs(p.window) }, async (p) => {
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

// ─── What the page and the agents read ─────────────────────────────────────

export type KlaviyoCampaignView = EmailCampaignLine & { id: string; status: string | null; previewText: string | null; audiences: string[]; unsubscribes: number; bounced: number; spamComplaints: number };
export type KlaviyoFlowView = { id: string; name: string; status: string | null; trigger: string | null; revenue30: number; revenue90: number; recipients30: number; recipients90: number; openRate30: number | null; clickRate30: number | null; openRate90: number | null; clickRate90: number | null };
export type KlaviyoAudienceView = { id: string; kind: "list" | "segment"; name: string; profiles: number | null };
export type ClientKlaviyo = {
  account: string | null;
  currency: string | null;
  through: string | null;
  now: EmailWindow;
  before: EmailWindow;
  daily: { date: string; revenue: number; campaignRevenue: number; flowRevenue: number }[];
  campaigns: KlaviyoCampaignView[];
  flows: KlaviyoFlowView[];
  audiences: KlaviyoAudienceView[];
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/**
 * A client's email and SMS: the last 30 days against the 30 before, recent campaigns, flows by revenue, lists and
 * segments. Reads through `db` (a person's session sees only clients they can see). null when nothing was synced.
 */
export async function clientKlaviyo(db: SupabaseClient, clientId: string): Promise<ClientKlaviyo | null> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const from30 = shift(today, -29);
  const from60 = shift(today, -59);
  const [{ data: days, error }, { data: camps }, { data: flows }, { data: auds }, { data: conn }] = await Promise.all([
    db.from("klaviyo_daily").select("date, revenue, campaign_revenue, flow_revenue, sends, campaigns_sent").eq("client_id", clientId).gte("date", from60).order("date"),
    db.from("klaviyo_campaigns").select("*").eq("client_id", clientId).not("send_time", "is", null).order("send_time", { ascending: false }).limit(60),
    db.from("klaviyo_flows").select("*").eq("client_id", clientId).order("revenue_30", { ascending: false }).limit(40),
    db.from("klaviyo_audiences").select("audience_id, kind, name, profile_count").eq("client_id", clientId).order("profile_count", { ascending: false, nullsFirst: false }).limit(40),
    db.from("klaviyo_connections").select("account_name, currency").eq("client_id", clientId).maybeSingle(),
  ]);
  if (error || (!days?.length && !camps?.length && !flows?.length)) return null;
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
    openRate: numOrNull(c.open_rate),
    clickRate: numOrNull(c.click_rate),
    revenue: num(c.revenue),
    conversions: num(c.conversions),
    unsubscribes: num(c.unsubscribes),
    bounced: num(c.bounced),
    spamComplaints: num(c.spam_complaints),
  }));
  const windowOf = (start: string, end: string): EmailWindow => {
    const ds = (days ?? []).filter((d) => d.date >= start && d.date <= end);
    const cs = (camps ?? []).filter((c) => {
      const d = String(c.send_time ?? "").slice(0, 10);
      return d >= start && d <= end;
    });
    const delivered = cs.reduce((s, c) => s + (num(c.delivered) || num(c.recipients)), 0);
    return {
      revenue: ds.reduce((s, d) => s + num(d.revenue), 0),
      campaignRevenue: ds.reduce((s, d) => s + num(d.campaign_revenue), 0),
      flowRevenue: ds.reduce((s, d) => s + num(d.flow_revenue), 0),
      sends: ds.reduce((s, d) => s + num(d.sends), 0),
      campaignsSent: ds.length ? ds.reduce((s, d) => s + num(d.campaigns_sent), 0) : cs.length,
      openRate: delivered ? cs.reduce((s, c) => s + num(c.opens_unique), 0) / delivered : null,
      clickRate: delivered ? cs.reduce((s, c) => s + num(c.clicks_unique), 0) / delivered : null,
    };
  };
  return {
    account: (conn?.account_name as string | null) ?? null,
    currency: (conn?.currency as string | null) ?? null,
    through: (days ?? []).map((d) => d.date as string).at(-1) ?? null,
    now: windowOf(from30, today),
    before: windowOf(from60, shift(from30, -1)),
    daily: (days ?? []).filter((d) => d.date >= from30).map((d) => ({ date: d.date as string, revenue: num(d.revenue), campaignRevenue: num(d.campaign_revenue), flowRevenue: num(d.flow_revenue) })),
    campaigns,
    flows: (flows ?? []).map((f) => ({
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
    })),
    audiences: (auds ?? []).map((a) => ({ id: a.audience_id as string, kind: a.kind as "list" | "segment", name: (a.name as string | null) ?? "(untitled)", profiles: a.profile_count == null ? null : Number(a.profile_count) })),
  };
}

/** The compact Klaviyo line for the agents (empty when the client has no Klaviyo numbers) */
export async function klaviyoBrief(db: SupabaseClient, clientId: string): Promise<string> {
  const k = await clientKlaviyo(db, clientId).catch(() => null);
  if (!k) return "";
  const { data: biz } = await db.from("client_business_daily").select("revenue").eq("client_id", clientId).gt("date", shift(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), -30));
  const store = (biz ?? []).reduce((s, r) => s + num(r.revenue), 0);
  return emailContextLine({ account: k.account, currency: k.currency, now: k.now, before: k.before, recent: k.campaigns, storeRevenue: store || null, through: k.through });
}
