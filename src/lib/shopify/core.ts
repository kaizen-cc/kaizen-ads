import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify, the plain parts (tested in tests/shopify-core.test.ts): store addresses, the OAuth checks (Shopify's HMAC on
// the install and callback, our signed state, webhook signatures), each order read as money on its day in the store's
// own time zone, a day's totals, the windows the full-history read walks back through, MER, and a before-and-after
// comparison around a date (the client's Kaizen start, a launch). The calls live in api.ts, the database in store.ts.

/** Shopify's Admin GraphQL version every call uses (supported a year from its release) */
export const SHOPIFY_API_VERSION = "2026-07";
/** Read only, and only what's read: orders (read_all_orders lifts Shopify's 60-day limit) and each order's customer id and order count. */
export const SHOPIFY_SCOPES = "read_orders,read_all_orders,read_customers";
/** Where Shopify sends the merchant back after they approve (must be listed in the app's allowed redirection URLs) */
export const SHOPIFY_REDIRECT_PATH = "/api/shopify/callback";

// ─── Store addresses ───────────────────────────────────────────────────────

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** "Aldecoa", "aldecoa.myshopify.com", "https://admin.shopify.com/store/aldecoa" → "aldecoa.myshopify.com"; null when it can't be one */
export function shopDomain(input: string | null | undefined): string | null {
  const v = String(input ?? "").trim().toLowerCase();
  if (!v) return null;
  const admin = v.match(/admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  if (admin) return `${admin[1]}.myshopify.com`;
  const host = v.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (SHOP.test(host)) return host;
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) return `${host}.myshopify.com`;
  return null;
}
export const isShopDomain = (s: unknown): s is string => typeof s === "string" && SHOP.test(s);

// ─── OAuth: Shopify's signature, our state, webhooks ──────────────────────

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Shopify signs the install and callback query strings: every parameter but hmac, sorted, joined as k=v with & */
export function validQueryHmac(params: URLSearchParams, secret: string): boolean {
  const given = params.get("hmac");
  if (!given || !secret) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return safeEqual(createHmac("sha256", secret).update(message).digest("hex"), given);
}

/** A webhook's X-Shopify-Hmac-Sha256: base64 HMAC of the raw body */
export function validWebhookHmac(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEqual(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"), header);
}

/** Who started the install: the client ("" when the store installed from Shopify's side), the store, where from, and until when it's good */
export type InstallState = { client: string; shop: string; from: "team" | "portal" | "shopify"; nonce: string; exp: number };

export function signState(s: InstallState, secret: string): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function readState(token: string | null | undefined, secret: string, now = Date.now()): InstallState | null {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(createHmac("sha256", secret).update(body).digest("base64url"), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as InstallState;
    return s && typeof s.client === "string" && isShopDomain(s.shop) && s.exp > now ? s : null;
  } catch {
    return null;
  }
}

// ─── Orders into days ──────────────────────────────────────────────────────

type Money = { shopMoney?: { amount?: string | number | null } | null } | null | undefined;
type Visit = { source?: string | null; referrerUrl?: string | null; landingPage?: string | null; utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null } | null;

/** An order as the GraphQL read returns it (only what the totals need) */
export type ShopOrder = {
  id: string;
  createdAt: string;
  cancelledAt?: string | null;
  test?: boolean | null;
  sourceName?: string | null;
  subtotalPriceSet?: Money;
  totalPriceSet?: Money;
  totalDiscountsSet?: Money;
  totalRefundedSet?: Money;
  totalTaxSet?: Money;
  totalShippingPriceSet?: Money;
  customer?: { id?: string | null; createdAt?: string | null; numberOfOrders?: string | number | null } | null;
  customerJourneySummary?: { customerOrderIndex?: number | null; firstVisit?: Visit; lastVisit?: Visit } | null;
};

export type DayTotals = {
  orders: number;
  gross_sales: number;
  discounts: number;
  refunds: number;
  net_sales: number;
  shipping: number;
  taxes: number;
  total_sales: number;
  new_customers: number;
  returning_customers: number;
  by_channel: { channels: Record<string, { orders: number; sales: number }>; sources: Record<string, { orders: number; sales: number }> };
};

const amt = (m: Money) => {
  const n = Number(m?.shopMoney?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The calendar day an instant falls on in the store's time zone (Shopify's own reports use the store's day) */
export function dayIn(iso: string, timeZone: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: timeZone || "America/New_York" });
  } catch {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
}

/** Shopify's sales channel, in words */
export function channelOf(sourceName: string | null | undefined): string {
  const s = String(sourceName ?? "").toLowerCase();
  if (!s || s === "web") return "Online store";
  if (s === "pos") return "Point of sale";
  if (s === "shopify_draft_order") return "Draft orders";
  if (s === "subscription_contract" || /subscri|recharge/.test(s)) return "Subscriptions";
  if (s === "iphone" || s === "android") return "Shopify app";
  if (/facebook|instagram|meta/.test(s)) return "Facebook & Instagram shop";
  if (/google|youtube/.test(s)) return "Google & YouTube";
  if (/tiktok/.test(s)) return "TikTok shop";
  if (/amazon/.test(s)) return "Amazon";
  if (/^\d+$/.test(s)) return "Other apps";
  return s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Where the buyer came from on their last visit before the order (UTMs, click IDs, the referrer), as a source */
export function sourceOf(o: Pick<ShopOrder, "customerJourneySummary">): string {
  const v = o.customerJourneySummary?.lastVisit ?? o.customerJourneySummary?.firstVisit ?? null;
  if (!v) return "Unknown";
  const s = [v.utmParameters?.source, v.utmParameters?.medium, v.landingPage, v.referrerUrl, v.source].filter(Boolean).join(" ").toLowerCase();
  if (!s.trim()) return "Unknown";
  if (/fbclid|facebook|instagram|\bfb\b|\big\b|meta|paid_social/.test(s)) return "Meta";
  if (/gclid|gbraid|wbraid|adwords|paid_search|\bcpc\b|\bppc\b/.test(s)) return "Google Ads";
  if (/ttclid|tiktok/.test(s)) return "TikTok";
  if (/klaviyo|\bemail\b|newsletter|_kx=|\bsms\b|attentive|postscript/.test(s)) return "Email & SMS";
  if (/google|bing|duckduckgo|yahoo|ecosia/.test(s)) return "Search";
  if (/utm_|source=|medium=/.test(s)) return "Other campaigns";
  if (/direct/.test(s)) return "Direct";
  return "Referral";
}

/** A first order: Shopify's own order index when it's there, else a single-order customer or one made with this order */
export function isFirstOrder(o: ShopOrder): boolean | null {
  const idx = o.customerJourneySummary?.customerOrderIndex;
  if (typeof idx === "number") return idx === 0;
  if (!o.customer) return null;
  const count = Number(o.customer.numberOfOrders ?? NaN);
  if (count === 1) return true;
  if (o.customer.createdAt) return Math.abs(Date.parse(o.createdAt) - Date.parse(o.customer.createdAt)) < 86_400_000;
  return null;
}

export const emptyDay = (): DayTotals => ({ orders: 0, gross_sales: 0, discounts: 0, refunds: 0, net_sales: 0, shipping: 0, taxes: 0, total_sales: 0, new_customers: 0, returning_customers: 0, by_channel: { channels: {}, sources: {} } });

/**
 * Each day's totals from its orders, the way Shopify's Finance report reads them (close to it: a refund counts on the
 * order's day, not the refund's). Test and cancelled orders don't count. Gross sales: before discounts, without shipping
 * and tax. Net sales: gross less discounts and refunds. Total sales (store revenue): what was paid, less refunds.
 */
export function ordersToDays(orders: ShopOrder[], timeZone: string | null | undefined): Map<string, DayTotals> {
  const days = new Map<string, DayTotals>();
  const seen = new Set<string>();
  for (const o of orders) {
    if (!o?.createdAt || o.test || o.cancelledAt || seen.has(o.id)) continue;
    seen.add(o.id);
    const d = dayIn(o.createdAt, timeZone);
    const x = days.get(d) ?? emptyDay();
    const subtotal = amt(o.subtotalPriceSet);
    const discounts = amt(o.totalDiscountsSet);
    const refunds = amt(o.totalRefundedSet);
    const total = amt(o.totalPriceSet);
    x.orders++;
    x.gross_sales += subtotal + discounts;
    x.discounts += discounts;
    x.refunds += refunds;
    x.net_sales += subtotal - refunds;
    x.shipping += amt(o.totalShippingPriceSet);
    x.taxes += amt(o.totalTaxSet);
    x.total_sales += total - refunds;
    const first = isFirstOrder(o);
    if (first === true) x.new_customers++;
    else if (first === false) x.returning_customers++;
    const ch = channelOf(o.sourceName);
    const src = sourceOf(o);
    const c = (x.by_channel.channels[ch] ??= { orders: 0, sales: 0 });
    c.orders++;
    c.sales += total - refunds;
    const s = (x.by_channel.sources[src] ??= { orders: 0, sales: 0 });
    s.orders++;
    s.sales += total - refunds;
    days.set(d, x);
  }
  for (const x of days.values()) {
    for (const k of ["gross_sales", "discounts", "refunds", "net_sales", "shipping", "taxes", "total_sales"] as const) x[k] = r2(x[k]);
    for (const g of [x.by_channel.channels, x.by_channel.sources]) for (const v of Object.values(g)) v.sales = r2(v.sales);
  }
  return days;
}

/** The rows a window writes: every day it read that has orders, and a zero for a stored day that no longer has any */
export function windowRows(days: Map<string, DayTotals>, window: { start: string; end: string }, storedDates: string[]): { date: string; totals: DayTotals }[] {
  const out: { date: string; totals: DayTotals }[] = [];
  for (const [date, totals] of days) if (date >= window.start && date < window.end) out.push({ date, totals });
  const have = new Set(out.map((r) => r.date));
  for (const d of storedDates) if (d >= window.start && d < window.end && !have.has(d)) out.push({ date: d, totals: emptyDay() });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Dates ─────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === "string" && DAY.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`));
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/**
 * The next stretch the full-history read takes, walking back from today a month at a time: [start, end) with end the
 * oldest day already read (tomorrow at first). null when it reached the store's first order.
 */
export function nextBackfillWindow(progress: { before?: string | null } | null | undefined, earliest: string, today: string, span = 31): { start: string; end: string } | null {
  const end = progress?.before && isDay(progress.before) ? progress.before : addDays(today, 1);
  if (end <= earliest) return null;
  const start = addDays(end, -span) < earliest ? earliest : addDays(end, -span);
  return { start, end };
}

/** Consecutive days grouped into ranges [start, end) so a handful of refreshed days are read in few calls */
export function dayRanges(days: string[], maxSpan = 31): { start: string; end: string }[] {
  const sorted = [...new Set(days.filter(isDay))].sort();
  const out: { start: string; end: string }[] = [];
  for (const d of sorted) {
    const last = out.at(-1);
    if (last && last.end === d && daysBetween(last.start, d) < maxSpan) last.end = addDays(d, 1);
    else out.push({ start: d, end: addDays(d, 1) });
  }
  return out;
}

// ─── What the numbers say ──────────────────────────────────────────────────

/** A stored day (summed across a client's stores) */
export type StoreDay = { date: string; orders: number; revenue: number; net_sales: number; new_customers: number; returning_customers: number };
export type SpendDay = { date: string; platform: string; spend: number };

export type StoreTotals = { days: number; orders: number; revenue: number; netSales: number; newCustomers: number; returning: number; aov: number | null; adSpend: number; mer: number | null; perMonth: number };

/** MER: store revenue over every ad dollar (Meta, Google, TikTok); null without spend */
export const mer = (revenue: number, spend: number) => (spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null);

export function totalsFor(store: StoreDay[], spend: SpendDay[], range: { start: string; end: string }): StoreTotals {
  const inside = (d: string) => d >= range.start && d <= range.end;
  let orders = 0;
  let revenue = 0;
  let netSales = 0;
  let newCustomers = 0;
  let returning = 0;
  for (const r of store)
    if (inside(r.date)) {
      orders += r.orders;
      revenue += r.revenue;
      netSales += r.net_sales;
      newCustomers += r.new_customers;
      returning += r.returning_customers;
    }
  const adSpend = spend.filter((s) => inside(s.date)).reduce((t, s) => t + s.spend, 0);
  const days = Math.max(1, daysBetween(range.start, range.end) + 1);
  return { days, orders, revenue: r2(revenue), netSales: r2(netSales), newCustomers, returning, aov: orders ? r2(revenue / orders) : null, adSpend: r2(adSpend), mer: mer(revenue, adSpend), perMonth: r2((revenue / days) * 30.44) };
}

/** Month by month (YYYY-MM): revenue, orders, ad spend and MER */
export function monthly(store: StoreDay[], spend: SpendDay[]): { month: string; revenue: number; orders: number; newCustomers: number; adSpend: number; mer: number | null }[] {
  const m = new Map<string, { revenue: number; orders: number; newCustomers: number; adSpend: number }>();
  const get = (k: string) => m.get(k) ?? { revenue: 0, orders: 0, newCustomers: 0, adSpend: 0 };
  for (const r of store) {
    const x = get(r.date.slice(0, 7));
    x.revenue += r.revenue;
    x.orders += r.orders;
    x.newCustomers += r.new_customers;
    m.set(r.date.slice(0, 7), x);
  }
  for (const s of spend) {
    const x = get(s.date.slice(0, 7));
    x.adSpend += s.spend;
    m.set(s.date.slice(0, 7), x);
  }
  return [...m]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, x]) => ({ month, revenue: r2(x.revenue), orders: x.orders, newCustomers: x.newCustomers, adSpend: r2(x.adSpend), mer: mer(x.revenue, x.adSpend) }));
}

export type BeforeAfter = {
  pivot: string;
  before: StoreTotals & { start: string; end: string };
  after: StoreTotals & { start: string; end: string };
  /** Monthly revenue run-rate after against before, % (null when nothing sold before) */
  growthPct: number | null;
  /** Every month the read covers, for the chart */
  months: ReturnType<typeof monthly>;
  note: string | null;
};

/**
 * Before and after a date (the client's first day with Kaizen, a launch): the same number of days on each side by
 * default (as many as there are since the date, at most `days`), else everything read before against everything after.
 * Run-rates (per month) are compared, so sides of different lengths still compare fairly.
 */
export function beforeAfter(store: StoreDay[], spend: SpendDay[], pivot: string, opts: { today: string; historyFrom: string | null; days?: number | null; whole?: boolean }): BeforeAfter | { error: string } {
  if (!isDay(pivot)) return { error: "The date must be YYYY-MM-DD." };
  const yesterday = addDays(opts.today, -1);
  if (pivot > yesterday) return { error: "The date has to be before today to compare after it." };
  const from = opts.historyFrom && isDay(opts.historyFrom) ? opts.historyFrom : (store.map((r) => r.date).sort()[0] ?? pivot);
  const roomAfter = daysBetween(pivot, yesterday) + 1;
  const roomBefore = Math.max(0, daysBetween(from, pivot));
  let before: { start: string; end: string };
  let after: { start: string; end: string };
  if (opts.whole) {
    before = { start: from, end: addDays(pivot, -1) };
    after = { start: pivot, end: yesterday };
  } else {
    const n = Math.max(1, Math.min(roomAfter, opts.days && opts.days > 0 ? Math.round(opts.days) : 365, Math.max(roomBefore, 1)));
    before = { start: addDays(pivot, -n), end: addDays(pivot, -1) };
    after = { start: pivot, end: addDays(pivot, n - 1) };
  }
  const b = totalsFor(store, spend, before);
  const a = totalsFor(store, spend, after);
  const note =
    roomBefore === 0
      ? "Nothing was read before this date: the store's history starts on it (or the store wasn't selling yet)."
      : opts.historyFrom && before.start < opts.historyFrom
        ? `Shopify history only reaches back to ${opts.historyFrom}, so the before side is shorter than asked.`
        : null;
  return {
    pivot,
    before: { ...b, ...before },
    after: { ...a, ...after },
    growthPct: b.perMonth > 0 ? Math.round(((a.perMonth - b.perMonth) / b.perMonth) * 1000) / 10 : null,
    months: monthly(
      store.filter((r) => r.date >= before.start && r.date <= after.end),
      spend.filter((s) => s.date >= before.start && s.date <= after.end),
    ),
    note,
  };
}

// ─── Clients on Shopify who aren't connected ───────────────────────────────

/** A storefront's page: is it Shopify, and which .myshopify.com store (Shopify prints it in every theme) */
export function shopifyFromHtml(html: string): { shopify: boolean; shop: string | null } {
  const h = String(html ?? "");
  const shop = h.match(/Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i)?.[1]?.toLowerCase() ?? h.match(/["']myshopifyDomain["']\s*:\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i)?.[1]?.toLowerCase() ?? null;
  const shopify = Boolean(shop) || /cdn\.shopify\.com|Shopify\.theme|shopify-digital-wallet|\/cdn\/shop\//i.test(h);
  return { shopify, shop };
}

// ─── Embedded loads: Shopify's session token ───────────────────────────────

/**
 * The id_token Shopify passes an embedded app (a JWT signed with the app secret): valid signature, for this app, not
 * expired. Returns the store it's for, or null.
 */
export function verifyIdToken(token: string | null | undefined, secret: string, apiKey: string, now = Date.now()): { shop: string } | null {
  if (!token || !secret || !apiKey) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  if (!safeEqual(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"), sig)) return null;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string };
    const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { aud?: string; dest?: string; exp?: number; nbf?: number };
    if (header.alg !== "HS256" || c.aud !== apiKey) return null;
    const t = Math.floor(now / 1000);
    if (typeof c.exp === "number" && c.exp < t - 5) return null;
    if (typeof c.nbf === "number" && c.nbf > t + 5) return null;
    const shop = shopDomain(String(c.dest ?? "").replace(/^https?:\/\//, ""));
    return shop ? { shop } : null;
  } catch {
    return null;
  }
}
