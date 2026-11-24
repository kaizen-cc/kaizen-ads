import "server-only";
import { SHOPIFY_API_VERSION, SHOPIFY_SCOPES, type ShopOrder } from "./core";

// Shopify's Admin GraphQL API, read only, paced by its own cost meter: each answer says how many points are left and how
// fast they come back, and the next call waits when the bucket runs low (a store on Plus refills faster). Throttled,
// 429 and 5xx answers are tried again after a pause. Tokens never appear in an error.

export const shopifyAppConfigured = () => Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
export const appSecret = () => process.env.SHOPIFY_API_SECRET ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Throttle = { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number };
type GqlBody<T> = { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] | string; extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number; throttleStatus?: Throttle } } };

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** One GraphQL call, waited for when the store's points ran low, tried again (up to 5 times) when throttled or down */
export async function gql<T>(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      if (attempt < 4) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new ShopifyError(`Shopify didn't answer (${e instanceof Error ? e.message : String(e)})`);
    }
    if (r.status === 401 || r.status === 403) throw new ShopifyError(r.status === 401 ? "Shopify refused the token (uninstalled or revoked)." : "The app doesn't have access to this (scopes).", r.status);
    if (r.status === 404) throw new ShopifyError("No Shopify store at this address.", 404);
    if (r.status === 402) throw new ShopifyError("The store is frozen or closed (unpaid Shopify plan).", 402);
    if ((r.status === 429 || r.status >= 500) && attempt < 5) {
      await sleep(Number(r.headers.get("retry-after") ?? 0) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    if (!r.ok) throw new ShopifyError(`Shopify answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`, r.status);
    const body = (await r.json()) as GqlBody<T>;
    const errs = Array.isArray(body.errors) ? body.errors : body.errors ? [{ message: body.errors }] : [];
    if (errs.some((e) => e.extensions?.code === "THROTTLED") && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (errs.length && !body.data) throw new ShopifyError(errs.map((e) => e.message).join("; ").slice(0, 300));
    // Pace the next call: keep enough points for another call like this one
    const t = body.extensions?.cost?.throttleStatus;
    const need = (body.extensions?.cost?.requestedQueryCost ?? 0) * 1.2;
    if (t?.currentlyAvailable != null && t.restoreRate && t.currentlyAvailable < need) await sleep(Math.min(20_000, ((need - t.currentlyAvailable) / t.restoreRate) * 1000));
    if (errs.length) throw new ShopifyError(errs.map((e) => e.message).join("; ").slice(0, 300));
    return body.data as T;
  }
}

export type ShopInfo = { name: string; currency: string; timezone: string; plan: string | null; scopes: string[] };

/** The store's name, currency and time zone, and what this token may read */
export async function shopInfo(shop: string, token: string): Promise<ShopInfo> {
  const d = await gql<{ shop: { name: string; currencyCode: string; ianaTimezone: string; plan?: { displayName?: string } | null }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(
    shop,
    token,
    `{ shop { name currencyCode ianaTimezone plan { displayName } } currentAppInstallation { accessScopes { handle } } }`,
  );
  return { name: d.shop.name, currency: d.shop.currencyCode, timezone: d.shop.ianaTimezone, plan: d.shop.plan?.displayName ?? null, scopes: d.currentAppInstallation.accessScopes.map((s) => s.handle) };
}

const MONEY = "shopMoney { amount }";
const ORDER_FIELDS = (journey: boolean) => `id createdAt cancelledAt test sourceName
  subtotalPriceSet { ${MONEY} } totalPriceSet { ${MONEY} } totalDiscountsSet { ${MONEY} } totalRefundedSet { ${MONEY} } totalTaxSet { ${MONEY} } totalShippingPriceSet { ${MONEY} }
  customer { id createdAt numberOfOrders }
  ${journey ? "customerJourneySummary { customerOrderIndex lastVisit { source referrerUrl landingPage utmParameters { source medium campaign } } firstVisit { source referrerUrl landingPage utmParameters { source medium campaign } } }" : ""}`;

/** The first order the store ever took (its createdAt), or null for a store with none */
export async function firstOrderAt(shop: string, token: string): Promise<string | null> {
  const d = await gql<{ orders: { nodes: { createdAt: string }[] } }>(shop, token, `{ orders(first: 1, sortKey: CREATED_AT) { nodes { createdAt } } }`);
  return d.orders.nodes[0]?.createdAt ?? null;
}

/**
 * Every order whose search matches ("created_at:>=… created_at:<…"), 250 at a time. The visit data (where the buyer came
 * from) is asked for first; a store or token that can't give it is read without it. Stops at the deadline and says so.
 */
export async function readOrders(shop: string, token: string, search: string, deadline: number): Promise<{ orders: ShopOrder[]; complete: boolean }> {
  const orders: ShopOrder[] = [];
  let journey = true;
  let after: string | null = null;
  for (;;) {
    if (Date.now() > deadline) return { orders, complete: false };
    const q = `query($q: String!, $after: String) { orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS(journey)} } } }`;
    let page: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopOrder[] } };
    try {
      page = await gql(shop, token, q, { q: search, after });
    } catch (e) {
      if (journey && e instanceof ShopifyError && /customerJourneySummary|access denied|not approved|Field .* doesn't exist/i.test(e.message)) {
        journey = false;
        continue;
      }
      throw e;
    }
    orders.push(...page.orders.nodes);
    if (!page.orders.pageInfo.hasNextPage) return { orders, complete: true };
    after = page.orders.pageInfo.endCursor;
  }
}

/** The days (createdAt) of orders changed since a moment: refunds, edits and cancellations on older orders */
export async function changedOrderDates(shop: string, token: string, sinceIso: string, deadline: number, cap = 5000): Promise<string[]> {
  const out: string[] = [];
  let after: string | null = null;
  while (out.length < cap && Date.now() < deadline) {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { createdAt: string }[] } } = await gql(
      shop,
      token,
      `query($q: String!, $after: String) { orders(first: 250, after: $after, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { createdAt } } }`,
      { q: `updated_at:>='${sinceIso}'`, after },
    );
    out.push(...d.orders.nodes.map((n) => n.createdAt));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function authorizeUrl(shop: string, state: string, redirectUri: string) {
  const q = new URLSearchParams({ client_id: process.env.SHOPIFY_API_KEY ?? "", scope: SHOPIFY_SCOPES, redirect_uri: redirectUri, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

/** Tokens as Shopify gives them: offline, and (for apps on expiring tokens) a refresh token and when it runs out */
/** client_id/client_secret: a store's own Dev Dashboard app (the fallback), whose tokens come from the client credentials grant */
export type ShopTokens = { access_token: string; scope?: string; refresh_token?: string; expires_at?: number | null; client_id?: string; client_secret?: string };

async function tokenCall(shop: string, body: Record<string, string>): Promise<ShopTokens> {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: process.env.SHOPIFY_API_SECRET, ...body }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new ShopifyError(`Shopify wouldn't give a token (${r.status})`, r.status);
  const j = (await r.json()) as { access_token: string; scope?: string; refresh_token?: string; expires_in?: number };
  return { access_token: j.access_token, scope: j.scope, refresh_token: j.refresh_token, expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null };
}

/** Offline tokens that expire (an hour) with a 90-day refresh token: Shopify's default for apps made since 2026 */
export const exchangeCode = (shop: string, code: string) => tokenCall(shop, { code, expiring: "1" });
/** A store's own app (made in their Dev Dashboard): a 24-hour token from its client ID and secret, fetched again when it runs out */
export const clientCredentials = async (shop: string, clientId: string, clientSecret: string): Promise<ShopTokens> => ({ ...(await tokenCall(shop, { client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" })), client_id: clientId, client_secret: clientSecret });
export const refreshTokens = (shop: string, refresh: string) => tokenCall(shop, { grant_type: "refresh_token", refresh_token: refresh });

/** An embedded load's session token swapped for the store's offline token (expiring, with a refresh token) */
export const tokenExchange = (shop: string, idToken: string) =>
  tokenCall(shop, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    expiring: "1",
  });
