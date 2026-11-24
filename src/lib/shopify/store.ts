import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { changedRows, readAllRows } from "@/lib/unchanged";
import { decryptSecret, encryptSecret, secretsConfigured } from "@/lib/integrations";
import { ShopifyError, changedOrderDates, clientCredentials, firstOrderAt, readOrders, refreshTokens, shopInfo, type ShopTokens } from "./api";
import {
  addDays,
  beforeAfter,
  dayIn,
  dayRanges,
  isDay,
  monthly,
  nextBackfillWindow,
  ordersToDays,
  shopDomain,
  shopifyFromHtml,
  totalsFor,
  windowRows,
  type DayTotals,
  type SpendDay,
  type StoreDay,
} from "./core";

// Each client's Shopify store in Kaizen OS. Connected by the Kaizen OS app (OAuth, read only) or, where the app can't be
// installed, a custom app's Admin API token pasted on the client page. Tokens are encrypted (TOKEN_ENCRYPTION_KEY) in
// client_integration_secrets. The first read walks back a month at a time to the store's first order (the "before
// Kaizen" side of a case study), paced by Shopify's cost meter, across as many runs as it takes; after that, every hour,
// today and yesterday and any day whose orders changed (refunds, cancellations) are read again. A day is written only
// when its numbers differ from what's stored (shopify_daily), and the last 120 days are mirrored into
// client_business_daily so the business notes and the agents' business block read them too.

export type ShopSettings = {
  auth?: "oauth" | "token";
  name?: string;
  currency?: string;
  timezone?: string;
  plan?: string | null;
  scopes?: string[];
  /** read_all_orders granted: the whole history (else Shopify keeps us to 60 days) */
  allOrders?: boolean;
  /** The store's first order day, in its time zone */
  earliest?: string | null;
  backfill?: { before?: string | null; done?: boolean; span?: number; at?: string | null };
};

const today = (tz?: string | null) => dayIn(new Date().toISOString(), tz);
const MIRROR_DAYS = 120;

// ─── Connecting ────────────────────────────────────────────────────────────

/** Saves a store (tested first): who it belongs to, its currency and time zone, the token encrypted. Never two clients on one store. */
export async function connectShopify(admin: SupabaseClient, clientId: string, input: { shop: string; token?: string; clientSecret?: string; tokens?: ShopTokens; auth: "oauth" | "token"; by: string | null }): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const shop = shopDomain(input.shop);
  if (!shop) return { ok: false, error: "That isn't a Shopify store address: it ends in .myshopify.com (Shopify admin › Settings › Domains)." };
  let tokens: ShopTokens | null = input.tokens ?? null;
  // The store's own Dev Dashboard app: its client ID and secret (tokens fetched as needed); else a legacy shpat_ token
  if (!tokens && input.token?.trim() && input.clientSecret?.trim()) {
    try {
      tokens = await clientCredentials(shop, input.token.trim(), input.clientSecret.trim());
    } catch {
      return { ok: false, error: "Shopify refused that client ID and secret: check the app is installed on this store and both were copied whole." };
    }
  }
  if (!tokens && input.token?.trim()) tokens = { access_token: input.token.trim() };
  if (!tokens?.access_token) return { ok: false, error: "Paste the Admin API access token (or the app's client ID and secret)." };
  if (!secretsConfigured()) return { ok: false, error: "Tokens can't be stored safely yet: TOKEN_ENCRYPTION_KEY needs to be set in Vercel." };
  let info;
  try {
    info = await shopInfo(shop, tokens.access_token);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /refused|401/.test(m) ? "Shopify refused the token: check it's the Admin API access token (starts with shpat_) of an installed app." : `Couldn't read the store: ${m.slice(0, 160)}` };
  }
  if (!info.scopes.includes("read_orders")) return { ok: false, error: "The token can't read orders: give the app the read_orders scope (and read_all_orders for the history), reinstall it, and paste the new token." };
  const { data: taken } = await admin.from("client_integrations").select("client_id, clients(name)").eq("kind", "shopify").eq("account", shop).neq("status", "disconnected").neq("client_id", clientId).limit(1).maybeSingle();
  if (taken) return { ok: false, error: `${shop} is already connected to ${(taken.clients as unknown as { name?: string } | null)?.name ?? "another client"}.` };
  const { data: prev } = await admin.from("client_integrations").select("settings").eq("client_id", clientId).eq("kind", "shopify").eq("account", shop).maybeSingle();
  const was = (prev?.settings ?? {}) as ShopSettings;
  const allOrders = info.scopes.includes("read_all_orders");
  const settings: ShopSettings = {
    ...was,
    auth: input.auth,
    name: info.name,
    currency: info.currency,
    timezone: info.timezone,
    plan: info.plan,
    scopes: info.scopes,
    allOrders,
    // Newly granted the whole history: the first order is looked up again and the read goes on back to it
    ...(allOrders && !was.allOrders ? { earliest: undefined, backfill: { ...(was.backfill ?? {}), done: false } } : {}),
  };
  const { data: row, error } = await admin
    .from("client_integrations")
    .upsert({ client_id: clientId, kind: "shopify", account: shop, label: info.name, status: "connected", last_error: null, settings, ...(input.by ? { created_by: input.by } : {}) }, { onConflict: "client_id,kind,account" })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn't save it." };
  await admin.from("client_integration_secrets").upsert({ integration_id: row.id, secret: encryptSecret(JSON.stringify(tokens)), updated_at: new Date().toISOString() });
  return { ok: true, id: row.id as string, name: info.name };
}

/** Shopify told us the app was uninstalled (or the store closed): the token is deleted, what was read stays */
export async function storeUninstalled(admin: SupabaseClient, shop: string) {
  await admin.from("shopify_pending_installs").delete().eq("shop", shop);
  const { data } = await admin.from("client_integrations").select("id").eq("kind", "shopify").eq("account", shop).neq("status", "disconnected");
  for (const r of data ?? []) {
    await admin.from("client_integration_secrets").delete().eq("integration_id", r.id);
    await admin.from("client_integrations").update({ status: "disconnected", last_error: "The Kaizen OS app was uninstalled from the store." }).eq("id", r.id);
  }
  return (data ?? []).length;
}

async function tokenFor(admin: SupabaseClient, id: string, shop: string): Promise<string> {
  const { data } = await admin.from("client_integration_secrets").select("secret").eq("integration_id", id).maybeSingle();
  if (!data) throw new ShopifyError("No token saved: connect the store again.");
  let plain: string;
  try {
    plain = decryptSecret(data.secret as string);
  } catch {
    throw new ShopifyError("The saved token can't be unlocked (TOKEN_ENCRYPTION_KEY changed): connect the store again.");
  }
  let t: ShopTokens;
  try {
    t = JSON.parse(plain) as ShopTokens;
  } catch {
    t = { access_token: plain };
  }
  // Expiring tokens: refreshed (or, for a store's own app, fetched again) a few minutes before they run out
  if (t.expires_at && t.expires_at < Date.now() + 5 * 60_000 && (t.refresh_token || t.client_secret)) {
    t = t.client_id && t.client_secret ? await clientCredentials(shop, t.client_id, t.client_secret) : { ...t, ...(await refreshTokens(shop, t.refresh_token!)) };
    await admin.from("client_integration_secrets").upsert({ integration_id: id, secret: encryptSecret(JSON.stringify(t)), updated_at: new Date().toISOString() });
  }
  return t.access_token;
}

// ─── Writing days (only the changed ones) ──────────────────────────────────

const DAY_COLS = "date, orders, gross_sales, discounts, refunds, net_sales, shipping, taxes, total_sales, new_customers, returning_customers, by_channel, currency";

async function writeDays(admin: SupabaseClient, clientId: string, shop: string, currency: string | null, days: Map<string, DayTotals>, window: { start: string; end: string }): Promise<string[]> {
  const stored = await readAllRows((a, b) => admin.from("shopify_daily").select(DAY_COLS).eq("client_id", clientId).eq("shop", shop).gte("date", window.start).lt("date", window.end).order("date").range(a, b));
  const rows = windowRows(
    days,
    window,
    stored.map((r) => r.date as string),
  ).map((r) => ({ date: r.date, ...r.totals, currency }));
  const changed = changedRows(rows as unknown as Record<string, unknown>[], new Map(stored.map((r) => [r.date as string, r])), (r) => r.date as string);
  const now = new Date().toISOString();
  for (let k = 0; k < changed.length; k += 500)
    await admin
      .from("shopify_daily")
      .upsert(
        changed.slice(k, k + 500).map((r) => ({ ...r, client_id: clientId, shop, updated_at: now })),
        { onConflict: "client_id,shop,date" },
      )
      .throwOnError();
  return changed.map((r) => r.date as string);
}

/** The recent changed days, summed across the client's stores, into client_business_daily (the business notes and block) */
async function mirrorBusinessDays(admin: SupabaseClient, clientId: string, dates: string[]) {
  const cutoff = addDays(today(), -MIRROR_DAYS);
  const recent = [...new Set(dates)].filter((d) => d >= cutoff);
  if (!recent.length) return;
  const { data } = await admin.from("shopify_daily").select("date, orders, total_sales, new_customers, returning_customers, by_channel").eq("client_id", clientId).in("date", recent);
  const by = new Map<string, { revenue: number; orders: number; new_customers: number; returning_customers: number; from_meta: number; from_google: number }>();
  for (const d of recent) by.set(d, { revenue: 0, orders: 0, new_customers: 0, returning_customers: 0, from_meta: 0, from_google: 0 });
  for (const r of data ?? []) {
    const x = by.get(r.date as string)!;
    const src = ((r.by_channel as DayTotals["by_channel"] | null)?.sources ?? {}) as DayTotals["by_channel"]["sources"];
    x.revenue += Number(r.total_sales ?? 0);
    x.orders += Number(r.orders ?? 0);
    x.new_customers += Number(r.new_customers ?? 0);
    x.returning_customers += Number(r.returning_customers ?? 0);
    x.from_meta += src.Meta?.orders ?? 0;
    x.from_google += src["Google Ads"]?.orders ?? 0;
  }
  const now = new Date().toISOString();
  await admin.from("client_business_daily").upsert(
    [...by].map(([date, x]) => ({ client_id: clientId, date, source: "shopify", ...x, revenue: Math.round(x.revenue * 100) / 100, updated_at: now })),
    { onConflict: "client_id,date,source" },
  );
}

// ─── Reading a store ───────────────────────────────────────────────────────

/** Orders created in [start, end) by the store's calendar, read with a day's margin each side so every time zone is whole */
const searchFor = (w: { start: string; end: string }) => `created_at:>='${addDays(w.start, -1)}T00:00:00Z' created_at:<'${addDays(w.end, 1)}T00:00:00Z'`;

/**
 * One store's run until the deadline: refresh (today, yesterday and days whose orders changed since the last run), then
 * the history back to the first order, a window at a time (shorter windows for a store too big to read in one run).
 */
export async function syncShopify(admin: SupabaseClient, id: string, deadline: number): Promise<Record<string, unknown>> {
  const { data: i } = await admin.from("client_integrations").select("id, client_id, account, status, settings, last_synced_at").eq("id", id).eq("kind", "shopify").maybeSingle();
  if (!i || i.status === "disconnected") return { skipped: true };
  const shop = i.account as string;
  const clientId = i.client_id as string;
  const s = { ...((i.settings ?? {}) as ShopSettings) };
  const started = new Date().toISOString();
  const written: string[] = [];
  try {
    const token = await tokenFor(admin, id, shop);
    const tz = s.timezone ?? null;
    const now = today(tz);
    if (s.earliest === undefined || s.earliest === null) {
      const first = await firstOrderAt(shop, token);
      let earliest = first ? dayIn(first, tz) : now;
      if (!s.allOrders && earliest < addDays(now, -60)) earliest = addDays(now, -60);
      s.earliest = earliest;
    }
    const earliest = s.earliest!;
    // 1. The refresh (once there's a first read): what changed since, today and yesterday
    if (i.last_synced_at) {
      const since = new Date(Date.parse(i.last_synced_at as string) - 60 * 60_000).toISOString();
      const changed = (await changedOrderDates(shop, token, since, deadline)).map((c) => dayIn(c, tz));
      const days = [...new Set([now, addDays(now, -1), ...changed])].filter((d) => d >= earliest).sort().reverse().slice(0, 60);
      for (const w of dayRanges(days)) {
        const r = await readOrders(shop, token, searchFor(w), deadline);
        if (!r.complete) break;
        written.push(...(await writeDays(admin, clientId, shop, s.currency ?? null, ordersToDays(r.orders, tz), w)));
      }
    }
    // 2. The history, newest month first
    const bf = { ...(s.backfill ?? {}) };
    while (!bf.done && Date.now() < deadline - 10_000) {
      const span = Math.max(1, Math.min(31, bf.span ?? 31));
      const w = nextBackfillWindow(bf, earliest, now, span);
      if (!w) {
        bf.done = true;
        break;
      }
      const t0 = Date.now();
      const r = await readOrders(shop, token, searchFor(w), deadline);
      if (!r.complete) {
        // Too many orders to read this stretch in one run: a shorter one next time
        bf.span = Math.max(1, Math.floor(span / 2));
        break;
      }
      written.push(...(await writeDays(admin, clientId, shop, s.currency ?? null, ordersToDays(r.orders, tz), w)));
      bf.before = w.start;
      bf.at = new Date().toISOString();
      // Quick stretches grow back to a month
      if (Date.now() - t0 < 20_000 && span < 31) bf.span = Math.min(31, span * 2);
    }
    s.backfill = bf;
    await mirrorBusinessDays(admin, clientId, written);
    await admin.from("client_integrations").update({ status: "connected", last_error: null, last_synced_at: started, settings: s }).eq("id", id);
    return { shop, days: written.length, historyFrom: bf.done ? earliest : (bf.before ?? null), done: Boolean(bf.done) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await mirrorBusinessDays(admin, clientId, written).catch(() => undefined);
    await admin.from("client_integrations").update({ status: "error", last_error: m.slice(0, 300), settings: s }).eq("id", id);
    return { shop, error: m };
  }
}

/**
 * The cron step: stores whose history isn't read yet first, then any not read in the last 50 minutes, within the time
 * budget; then a few clients checked for Shopify they haven't connected.
 */
export async function keepShopify(admin: SupabaseClient, budgetMs = 8 * 60_000) {
  const end = Date.now() + budgetMs;
  const { data: list } = await admin.from("client_integrations").select("id, settings, last_synced_at").eq("kind", "shopify").in("status", ["connected", "error"]);
  const stale = Date.now() - 50 * 60_000;
  const todo = (list ?? [])
    .filter((r) => !((r.settings as ShopSettings | null)?.backfill?.done) || !r.last_synced_at || Date.parse(r.last_synced_at as string) < stale)
    .sort((a, b) => Number(Boolean((a.settings as ShopSettings | null)?.backfill?.done)) - Number(Boolean((b.settings as ShopSettings | null)?.backfill?.done)) || String(a.last_synced_at ?? "").localeCompare(String(b.last_synced_at ?? "")));
  const synced: Record<string, unknown> = {};
  for (const r of todo) {
    if (Date.now() > end - 20_000) break;
    synced[r.id as string] = await syncShopify(admin, r.id as string, Math.min(end, Date.now() + 180_000)).catch((e) => String(e));
  }
  const hints = Date.now() < end - 30_000 ? await scanStoreHints(admin, 6).catch((e) => String(e)) : "no time";
  const linked = await autoLinkWaiting(admin).catch((e) => String(e));
  return { synced, hints, linked };
}

// ─── What the numbers say ──────────────────────────────────────────────────

export type StoreConnection = { id: string; shop: string; name: string | null; status: string; auth: "oauth" | "token" | null; currency: string | null; historyFrom: string | null; historyDone: boolean; allOrders: boolean; lastSyncedAt: string | null; lastError: string | null };

export async function storeConnections(db: SupabaseClient, clientId: string): Promise<StoreConnection[]> {
  const { data } = await db.from("client_integrations").select("id, account, label, status, settings, last_synced_at, last_error").eq("client_id", clientId).eq("kind", "shopify").neq("status", "disconnected").order("created_at");
  return (data ?? []).map((r) => {
    const s = (r.settings ?? {}) as ShopSettings;
    return {
      id: r.id as string,
      shop: r.account as string,
      name: (r.label as string | null) ?? s.name ?? null,
      status: r.status as string,
      auth: s.auth ?? null,
      currency: s.currency ?? null,
      historyFrom: s.backfill?.done ? (s.earliest ?? null) : (s.backfill?.before ?? null),
      historyDone: Boolean(s.backfill?.done),
      allOrders: Boolean(s.allOrders),
      lastSyncedAt: (r.last_synced_at as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
    };
  });
}

/** The client's store days, summed across their stores */
export async function storeDays(db: SupabaseClient, clientId: string, from: string, to: string): Promise<StoreDay[]> {
  const rows = await readAllRows((a, b) => db.from("shopify_daily").select("date, orders, total_sales, net_sales, new_customers, returning_customers").eq("client_id", clientId).gte("date", from).lte("date", to).order("date").order("shop").range(a, b));
  const by = new Map<string, StoreDay>();
  for (const r of rows) {
    const d = r.date as string;
    const x = by.get(d) ?? { date: d, orders: 0, revenue: 0, net_sales: 0, new_customers: 0, returning_customers: 0 };
    x.orders += Number(r.orders ?? 0);
    x.revenue += Number(r.total_sales ?? 0);
    x.net_sales += Number(r.net_sales ?? 0);
    x.new_customers += Number(r.new_customers ?? 0);
    x.returning_customers += Number(r.returning_customers ?? 0);
    by.set(d, x);
  }
  return [...by.values()];
}

/** Every ad dollar (Meta, Google, TikTok) a day at a time, from the accounts on their KPI board */
export async function adSpendDays(admin: SupabaseClient, clientId: string, from: string, to: string): Promise<SpendDay[]> {
  const { data } = await admin.rpc("client_ad_spend_daily", { p_client: clientId, p_from: from, p_to: to });
  return ((data ?? []) as { date: string; platform: string; spend: number | string }[]).map((r) => ({ date: r.date, platform: r.platform, spend: Number(r.spend) || 0 }));
}

/** Sales by channel and by where buyers came from over a range (the biggest first) */
async function mixFor(db: SupabaseClient, clientId: string, from: string, to: string) {
  const rows = await readAllRows((a, b) => db.from("shopify_daily").select("by_channel").eq("client_id", clientId).gte("date", from).lte("date", to).order("date").order("shop").range(a, b));
  const add = (into: Map<string, { orders: number; sales: number }>, g: Record<string, { orders: number; sales: number }> | undefined) => {
    for (const [k, v] of Object.entries(g ?? {})) {
      const x = into.get(k) ?? { orders: 0, sales: 0 };
      x.orders += v.orders;
      x.sales += v.sales;
      into.set(k, x);
    }
  };
  const channels = new Map<string, { orders: number; sales: number }>();
  const sources = new Map<string, { orders: number; sales: number }>();
  for (const r of rows) {
    const b = r.by_channel as DayTotals["by_channel"] | null;
    add(channels, b?.channels);
    add(sources, b?.sources);
  }
  const list = (m: Map<string, { orders: number; sales: number }>) => [...m].map(([name, v]) => ({ name, orders: v.orders, sales: Math.round(v.sales * 100) / 100 })).sort((a, b) => b.sales - a.sales);
  return { channels: list(channels), sources: list(sources) };
}

/** When the client started with Kaizen: set on their page, else their first day of ad spend we have */
export async function kaizenStart(admin: SupabaseClient, clientId: string): Promise<{ date: string | null; source: "set" | "first spend" | null }> {
  const { data } = await admin.from("clients").select("kaizen_started_on").eq("id", clientId).maybeSingle();
  if (data?.kaizen_started_on) return { date: data.kaizen_started_on as string, source: "set" };
  const spend = await adSpendDays(admin, clientId, "2015-01-01", today());
  const first = spend.filter((s) => s.spend > 0).map((s) => s.date).sort()[0] ?? null;
  return { date: first, source: first ? "first spend" : null };
}

export type StoreOverview = {
  connections: StoreConnection[];
  currency: string | null;
  historyFrom: string | null;
  last30: ReturnType<typeof totalsFor>;
  prior30: ReturnType<typeof totalsFor>;
  months: ReturnType<typeof monthly>;
  /** The last 90 days, for the trend line */
  days: { date: string; revenue: number; spend: number }[];
  start: { date: string | null; source: "set" | "first spend" | null };
};

/** The client page's Store card: the last 30 days against the 30 before, MER, 13 months, the last 90 days by day */
export async function storeOverview(db: SupabaseClient, admin: SupabaseClient, clientId: string): Promise<StoreOverview | null> {
  const connections = await storeConnections(db, clientId);
  if (!connections.length) return null;
  const t = today();
  const from = `${addDays(t, -400).slice(0, 7)}-01`;
  const [store, spend, start] = await Promise.all([storeDays(db, clientId, from, t), adSpendDays(admin, clientId, from, t), kaizenStart(admin, clientId)]);
  const spendBy = new Map<string, number>();
  for (const s of spend) spendBy.set(s.date, (spendBy.get(s.date) ?? 0) + s.spend);
  const revBy = new Map(store.map((d) => [d.date, d.revenue]));
  const days: StoreOverview["days"] = [];
  // Today so far included: a sale shows the hour it's read
  for (let d = addDays(t, -89); d <= t; d = addDays(d, 1)) days.push({ date: d, revenue: Math.round(revBy.get(d) ?? 0), spend: Math.round(spendBy.get(d) ?? 0) });
  const froms = connections.map((c) => c.historyFrom).filter((x): x is string => Boolean(x));
  return {
    connections,
    currency: connections.find((c) => c.currency)?.currency ?? null,
    historyFrom: froms.length ? froms.sort().at(-1)! : null,
    last30: totalsFor(store, spend, { start: addDays(t, -29), end: t }),
    prior30: totalsFor(store, spend, { start: addDays(t, -59), end: addDays(t, -30) }),
    months: monthly(store, spend).slice(-13),
    days,
    start,
  };
}

/** A period's store numbers (and the same length before it), with MER and where sales came from: for reports, KPIs and the agents */
export async function storeReport(admin: SupabaseClient, clientId: string, range: { start: string; end: string }) {
  const connections = await storeConnections(admin, clientId);
  if (!connections.length) return null;
  const len = Math.max(1, Math.round((Date.parse(`${range.end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000) + 1);
  const prev = { start: addDays(range.start, -len), end: addDays(range.start, -1) };
  const [store, spend, mix] = await Promise.all([storeDays(admin, clientId, prev.start, range.end), adSpendDays(admin, clientId, prev.start, range.end), mixFor(admin, clientId, range.start, range.end)]);
  const spendOf = (r: { start: string; end: string }) => {
    const out: Record<string, number> = {};
    for (const s of spend) if (s.date >= r.start && s.date <= r.end) out[s.platform] = Math.round(((out[s.platform] ?? 0) + s.spend) * 100) / 100;
    return out;
  };
  const froms = connections.map((c) => c.historyFrom).filter((x): x is string => Boolean(x));
  return {
    stores: connections.map((c) => ({ shop: c.shop, name: c.name, status: c.status, historyFrom: c.historyFrom, historyDone: c.historyDone })),
    currency: connections.find((c) => c.currency)?.currency ?? null,
    range,
    main: { ...totalsFor(store, spend, range), spendByPlatform: spendOf(range) },
    previous: { ...prev, ...totalsFor(store, spend, prev), spendByPlatform: spendOf(prev) },
    salesChannels: mix.channels.slice(0, 8),
    buyerSources: mix.sources.slice(0, 8),
    historyFrom: froms.length ? froms.sort().at(-1)! : null,
    note: "Store revenue is Shopify's total sales (what buyers paid, less refunds; test and cancelled orders left out). MER = store revenue / total ad spend on Meta, Google and TikTok.",
  };
}

/** Before and after a date (default: their Kaizen start), with every month for the chart */
export async function storeBeforeAfter(admin: SupabaseClient, clientId: string, opts: { pivot?: string | null; days?: number | null; whole?: boolean } = {}) {
  const connections = await storeConnections(admin, clientId);
  if (!connections.length) return { error: "No Shopify store is connected for this client yet. Connect it on their client page (Their store and CRM)." };
  const start = opts.pivot && isDay(opts.pivot) ? { date: opts.pivot, source: "asked" as const } : await kaizenStart(admin, clientId);
  if (!start.date) return { error: "No date to compare around: give one (YYYY-MM-DD) or set when they started with Kaizen on their client page." };
  const t = today();
  const froms = connections.map((c) => c.historyFrom).filter((x): x is string => Boolean(x));
  const historyFrom = froms.length ? froms.sort().at(-1)! : null;
  const from = historyFrom && historyFrom < start.date ? historyFrom : addDays(start.date, -730);
  const [store, spend] = await Promise.all([storeDays(admin, clientId, from, t), adSpendDays(admin, clientId, from, t)]);
  const r = beforeAfter(store, spend, start.date, { today: t, historyFrom, days: opts.days ?? null, whole: opts.whole });
  if ("error" in r) return r;
  const reading = connections.some((c) => !c.historyDone);
  return {
    ...r,
    pivotSource: start.source,
    currency: connections.find((c) => c.currency)?.currency ?? null,
    ...(reading ? { stillReading: `Shopify's history is still being read (back to ${historyFrom ?? "today"} so far); the before side fills in over the next runs.` } : {}),
    meaning: "Store revenue is Shopify's total sales less refunds. perMonth: the side's revenue run-rate per month. growthPct: after against before, by run-rate. MER = store revenue / ad spend (Meta + Google + TikTok) on that side; ad spend before Kaizen is often missing (we only read accounts we manage).",
  };
}

// ─── Clients on Shopify who aren't connected ───────────────────────────────

async function homepage(url: string): Promise<string | null> {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return null;
    const r = await fetch(u.toString(), { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (compatible; KaizenOS/1.0)", accept: "text/html" }, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 400_000);
  } catch {
    return null;
  }
}

/** A few clients at a time (each checked weekly): their site, their Klaviyo's order source and their onboarding answers */
export async function scanStoreHints(admin: SupabaseClient, max = 6) {
  const [{ data: clients }, { data: hints }, { data: conns }] = await Promise.all([
    admin.from("clients").select("id, website").is("archived_at", null).eq("internal", false),
    admin.from("client_store_hints").select("client_id, platform, shop_domain, evidence, checked_at"),
    admin.from("client_integrations").select("client_id").eq("kind", "shopify").neq("status", "disconnected"),
  ]);
  const connected = new Set((conns ?? []).map((c) => c.client_id as string));
  const seen = new Map((hints ?? []).map((h) => [h.client_id as string, h]));
  const week = Date.now() - 7 * 86_400_000;
  const due = (clients ?? []).filter((c) => !connected.has(c.id as string) && (!seen.get(c.id as string) || Date.parse(seen.get(c.id as string)!.checked_at as string) < week)).slice(0, max);
  if (!due.length) return { checked: 0 };
  const ids = due.map((c) => c.id as string);
  const [{ data: kl }, { data: ob }] = await Promise.all([admin.from("klaviyo_connections").select("client_id, conversion_metrics").in("client_id", ids), admin.from("client_onboarding").select("client_id, website").in("client_id", ids)]);
  let found = 0;
  for (const c of due) {
    const evidence: string[] = [];
    let shop: string | null = null;
    const metrics = (kl ?? []).find((k) => k.client_id === c.id)?.conversion_metrics as { integration?: string }[] | null;
    if ((metrics ?? []).some((m) => /shopify/i.test(m?.integration ?? ""))) evidence.push("Their Klaviyo's orders come from Shopify");
    const site = (ob ?? []).find((o) => o.client_id === c.id)?.website as { platform?: string; store?: string } | null;
    if (site?.platform === "shopify") {
      evidence.push("They told us in onboarding their site is on Shopify");
      shop = shopDomain(site.store) ?? shop;
    }
    if (c.website) {
      const html = await homepage(c.website as string);
      const h = html ? shopifyFromHtml(html) : null;
      if (h?.shopify) {
        evidence.push("Their website runs on Shopify");
        shop = h.shop ?? shop;
      }
    }
    if (evidence.length) found++;
    await admin.from("client_store_hints").upsert({ client_id: c.id, platform: evidence.length ? "shopify" : null, shop_domain: shop, evidence, checked_at: new Date().toISOString() });
  }
  return { checked: due.length, shopify: found };
}

export type ToConnect = { clientId: string; name: string; slug: string; shop: string | null; evidence: string[] };

/** Clients that sell on Shopify but whose store isn't connected, with why we think so */
export async function shopifyToConnect(db: SupabaseClient): Promise<ToConnect[]> {
  const [{ data: hints }, { data: conns }] = await Promise.all([
    db.from("client_store_hints").select("client_id, shop_domain, evidence, clients!inner(name, slug, archived_at)").eq("platform", "shopify").is("clients.archived_at", null),
    db.from("client_integrations").select("client_id").eq("kind", "shopify").neq("status", "disconnected"),
  ]);
  const connected = new Set((conns ?? []).map((c) => c.client_id as string));
  return (hints ?? [])
    .filter((h) => !connected.has(h.client_id as string))
    .map((h) => {
      const c = h.clients as unknown as { name: string; slug: string };
      return { clientId: h.client_id as string, name: c.name, slug: c.slug, shop: (h.shop_domain as string | null) ?? null, evidence: (h.evidence as string[]) ?? [] };
    })
    .sort((a, b) => b.evidence.length - a.evidence.length || a.name.localeCompare(b.name));
}

/** Each range's store revenue and orders (summed across the client's stores) and every ad dollar spent: report periods. null with no store. */
export async function storePeriods(admin: SupabaseClient, clientId: string, ranges: { start: string; end: string }[]): Promise<{ storeRevenue: number; storeOrders: number; allSpend: number }[] | null> {
  if (!ranges.length) return [];
  const { count } = await admin.from("client_integrations").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("kind", "shopify").neq("status", "disconnected");
  if (!count) return null;
  const from = ranges.map((r) => r.start).sort()[0];
  const to = ranges.map((r) => r.end).sort().at(-1)!;
  const [store, spend] = await Promise.all([storeDays(admin, clientId, from, to), adSpendDays(admin, clientId, from, to)]);
  return ranges.map((r) => {
    const t = totalsFor(store, spend, r);
    return { storeRevenue: t.revenue, storeOrders: t.orders, allSpend: t.adSpend };
  });
}

/**
 * Shopify's shop/redact (48 hours after the app is uninstalled), or a merchant's deletion request: everything read from
 * the store goes. Its daily totals, the recent days mirrored into client_business_daily (unless the client has another
 * live store), the token and the connection itself. Customer records are never stored, so there's nothing else.
 */
export async function eraseStore(admin: SupabaseClient, shop: string) {
  const { data: conns } = await admin.from("client_integrations").select("id, client_id").eq("kind", "shopify").eq("account", shop);
  await admin.from("shopify_daily").delete().eq("shop", shop);
  await admin.from("shopify_pending_installs").delete().eq("shop", shop);
  for (const c of conns ?? []) {
    await admin.from("client_integration_secrets").delete().eq("integration_id", c.id);
    await admin.from("client_integrations").delete().eq("id", c.id);
    const { count } = await admin.from("client_integrations").select("id", { count: "exact", head: true }).eq("client_id", c.client_id).eq("kind", "shopify").neq("status", "disconnected");
    if (!count) await admin.from("client_business_daily").delete().eq("client_id", c.client_id).eq("source", "shopify");
  }
  return (conns ?? []).length;
}

// ─── Installs from Shopify's side ──────────────────────────────────────────

/** A store installed the app from Shopify's side: its token waits (encrypted) until it's linked to a client */
export async function parkInstall(admin: SupabaseClient, shop: string, tokens: ShopTokens) {
  const info = await shopInfo(shop, tokens.access_token);
  await admin.from("shopify_pending_installs").upsert({ shop, name: info.name, secret: encryptSecret(JSON.stringify(tokens)), scopes: info.scopes, created_at: new Date().toISOString() });
  return info.name;
}

/** A waiting install, linked to a client: connected the usual way (history read next), then no longer waiting */
export async function linkPending(admin: SupabaseClient, clientId: string, shop: string, by: string | null) {
  const { data } = await admin.from("shopify_pending_installs").select("secret").eq("shop", shop).maybeSingle();
  if (!data) return { ok: false as const, error: "That store isn't waiting to be linked." };
  let tokens: ShopTokens;
  try {
    tokens = JSON.parse(decryptSecret(data.secret as string)) as ShopTokens;
  } catch {
    return { ok: false as const, error: "Its token can't be unlocked: install the app again from the client page." };
  }
  const r = await connectShopify(admin, clientId, { shop, tokens, auth: "oauth", by });
  if (r.ok) await admin.from("shopify_pending_installs").delete().eq("shop", shop);
  return r;
}

/** The one client whose site or onboarding named this store, if exactly one did */
export async function clientForShop(admin: SupabaseClient, shop: string): Promise<string | null> {
  // A store that was connected before (reinstalled after an uninstall) goes back to its client
  const { data: before } = await admin.from("client_integrations").select("client_id").eq("kind", "shopify").eq("account", shop).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (before) return before.client_id as string;
  const { data } = await admin.from("client_store_hints").select("client_id, clients!inner(archived_at)").eq("shop_domain", shop).is("clients.archived_at", null).limit(2);
  return data?.length === 1 ? (data[0].client_id as string) : null;
}

/** Stores waiting to be linked to a client */
export async function pendingInstalls(admin: SupabaseClient): Promise<{ shop: string; name: string | null; at: string }[]> {
  const { data } = await admin.from("shopify_pending_installs").select("shop, name, created_at").order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ shop: r.shop as string, name: (r.name as string | null) ?? null, at: r.created_at as string }));
}

/** Waiting installs whose client became known since (a store address found on a client's site or in onboarding): linked */
export async function autoLinkWaiting(admin: SupabaseClient) {
  const out: string[] = [];
  for (const w of await pendingInstalls(admin)) {
    const clientId = await clientForShop(admin, w.shop);
    if (!clientId) continue;
    const r = await linkPending(admin, clientId, w.shop, null);
    if (r.ok) out.push(w.shop);
  }
  return out;
}

/** A store's own last 30 days and how much history is read, for the app's page in Shopify admin (that store only) */
export async function storeGlance(admin: SupabaseClient, shop: string) {
  const { data: conn } = await admin.from("client_integrations").select("settings").eq("kind", "shopify").eq("account", shop).eq("status", "connected").limit(1).maybeSingle();
  if (!conn) return null;
  const s = (conn.settings ?? {}) as ShopSettings;
  const t = today(s.timezone);
  const [{ data: recent }, { count }] = await Promise.all([
    admin.from("shopify_daily").select("orders, total_sales").eq("shop", shop).gte("date", addDays(t, -29)),
    admin.from("shopify_daily").select("date", { count: "exact", head: true }).eq("shop", shop),
  ]);
  const last30 = (recent ?? []).reduce((a, r) => ({ revenue: a.revenue + Number(r.total_sales ?? 0), orders: a.orders + Number(r.orders ?? 0) }), { revenue: 0, orders: 0 });
  return { last30, days: count ?? 0, historyFrom: s.backfill?.done ? (s.earliest ?? null) : (s.backfill?.before ?? null), currency: s.currency ?? null };
}
