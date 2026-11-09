import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Each client's store and CRM: Shopify, WooCommerce, GoHighLevel, HubSpot. The team connects them on the client page
// with a key made for us (a Shopify custom app token once our collaborator access is in, WooCommerce REST keys, a
// GoHighLevel private integration token per location, a HubSpot private app token). Keys are encrypted by the app and
// never shown again. Every hour the new orders, subscriptions, leads and pipeline moves come in, each day is summed,
// and what they show (real new customers, subscriptions, leads booked, won and lost, and how many came from Meta or
// Google) goes to the client page, their dashboard, the agents and the buyers. Rule one is profitability, and this is
// where the real numbers are.

export type IntegrationKind = "shopify" | "woocommerce" | "gohighlevel" | "hubspot" | "other";
export const INTEGRATION_NAMES: Record<IntegrationKind, string> = { shopify: "Shopify", woocommerce: "WooCommerce", gohighlevel: "GoHighLevel", hubspot: "HubSpot", other: "Other CRM" };

type Event = { kind: "order" | "subscription" | "lead" | "booked" | "won" | "lost"; external_id: string; occurred_at: string; value?: number | null; first_order?: boolean | null; attribution?: "meta" | "google" | "other" | null; detail?: Record<string, unknown> };

// ─── Keys, encrypted at rest ───────────────────────────────────────────────

const keyOf = () => {
  const raw = process.env.KAIZEN_SECRETS_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
};
export const secretsConfigured = () => Boolean(process.env.KAIZEN_SECRETS_KEY);

function encrypt(text: string) {
  const key = keyOf();
  if (!key) throw new Error("KAIZEN_SECRETS_KEY isn't set, so keys can't be stored safely.");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}
function decrypt(blob: string) {
  const key = keyOf();
  if (!key) throw new Error("KAIZEN_SECRETS_KEY isn't set.");
  const [v, iv, tag, data] = blob.split(":");
  if (v !== "v1") throw new Error("Unknown key format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

// ─── Where a sale or lead came from ────────────────────────────────────────

/** Meta or Google from UTMs, click IDs or the landing page; "other" when tagged by something else; null when unknown */
export function attributionOf(...bits: (string | null | undefined)[]): "meta" | "google" | "other" | null {
  const s = bits.filter(Boolean).join(" ").toLowerCase();
  if (!s.trim()) return null;
  if (/fbclid|facebook|instagram|\bfb\b|\big\b|meta|paid_social/.test(s)) return "meta";
  if (/gclid|gbraid|wbraid|google|adwords|paid_search|\bcpc\b/.test(s)) return "google";
  if (/utm_|source=|medium=/.test(s)) return "other";
  return null;
}
const hash = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest("hex").slice(0, 24);
const nyDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ─── Each platform ─────────────────────────────────────────────────────────

const SHOPIFY_API = "2025-01";
const shopDomain = (s: string) => {
  const d = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return d.endsWith(".myshopify.com") ? d : `${d.replace(/\.myshopify\.com$/, "")}.myshopify.com`;
};
const siteOrigin = (s: string) => {
  try {
    return new URL(/^https?:\/\//.test(s.trim()) ? s.trim() : `https://${s.trim()}`).origin;
  } catch {
    return s.trim();
  }
};

async function getJson(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return { body: (await r.json()) as unknown, headers: r.headers };
}

type Shop = { token: string; shop: string };
async function shopifyOrders({ token, shop }: Shop, since: string): Promise<Event[]> {
  const out: Event[] = [];
  let url: string | null = `https://${shop}/admin/api/${SHOPIFY_API}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}&fields=id,created_at,current_total_price,total_price,customer,landing_site,referring_site,source_name,tags,line_items,cancelled_at,shipping_address`;
  for (let page = 0; url && page < 20; page++) {
    const { body, headers } = await getJson(url, { headers: { "X-Shopify-Access-Token": token, Accept: "application/json" } });
    const orders = ((body as { orders?: Record<string, unknown>[] }).orders ?? []) as {
      id: number;
      created_at: string;
      current_total_price?: string;
      total_price?: string;
      customer?: { created_at?: string } | null;
      landing_site?: string | null;
      referring_site?: string | null;
      source_name?: string | null;
      tags?: string;
      line_items?: { selling_plan_allocation?: unknown }[];
      cancelled_at?: string | null;
      shipping_address?: { city?: string; province_code?: string } | null;
    }[];
    for (const o of orders) {
      if (o.cancelled_at) continue;
      // New when the customer was made with this order (a returning customer's record is older)
      const first = o.customer?.created_at ? Math.abs(Date.parse(o.created_at) - Date.parse(o.customer.created_at)) < 86_400_000 : null;
      const tags = (o.tags ?? "").toLowerCase();
      const recurring = o.source_name === "subscription_contract" || /subscription recurring|recurring order/.test(tags);
      const subscribed = !recurring && (/subscription first order|first subscription/.test(tags) || (o.line_items ?? []).some((l) => l.selling_plan_allocation));
      const attribution = attributionOf(o.landing_site, o.referring_site);
      const detail = { city: o.shipping_address?.city ?? null, state: o.shipping_address?.province_code ?? null, recurring };
      out.push({ kind: "order", external_id: String(o.id), occurred_at: o.created_at, value: Number(o.current_total_price ?? o.total_price ?? 0), first_order: first, attribution, detail });
      if (subscribed) out.push({ kind: "subscription", external_id: String(o.id), occurred_at: o.created_at, value: Number(o.current_total_price ?? o.total_price ?? 0), first_order: first, attribution, detail });
    }
    const link = headers.get("link") ?? "";
    const next = link.split(",").find((p) => p.includes('rel="next"'));
    url = next ? (next.match(/<([^>]+)>/)?.[1] ?? null) : null;
  }
  return out;
}

type Woo = { site: string; key: string; secret: string };
const wooUrl = (w: Woo, path: string, q: Record<string, string>) => `${w.site}/wp-json/wc/v3/${path}?${new URLSearchParams({ ...q, consumer_key: w.key, consumer_secret: w.secret })}`;
async function wooOrders(w: Woo, since: string, seen: Set<string>): Promise<Event[]> {
  const out: Event[] = [];
  for (let page = 1; page <= 20; page++) {
    const { body } = await getJson(wooUrl(w, "orders", { after: since, per_page: "100", page: String(page), orderby: "date", order: "asc" }));
    const orders = (body ?? []) as { id: number; date_created_gmt: string; total: string; status: string; created_via?: string; billing?: { email?: string; city?: string; state?: string }; meta_data?: { key: string; value: unknown }[]; parent_id?: number }[];
    for (const o of orders) {
      if (["cancelled", "failed", "refunded", "trash", "pending", "checkout-draft"].includes(o.status)) continue;
      const meta = (k: string) => String(o.meta_data?.find((m) => m.key === k)?.value ?? "");
      const email = o.billing?.email ?? "";
      const ck = email ? hash(email) : null;
      // New the first time we see that customer (judged from the orders read so far)
      const first = ck ? !seen.has(ck) : null;
      if (ck) seen.add(ck);
      const attribution = attributionOf(meta("_wc_order_attribution_utm_source"), meta("_wc_order_attribution_utm_medium"), meta("_wc_order_attribution_session_entry"), meta("_wc_order_attribution_referrer"));
      out.push({ kind: "order", external_id: String(o.id), occurred_at: `${o.date_created_gmt}Z`, value: Number(o.total ?? 0), first_order: first, attribution, detail: { ck, city: o.billing?.city ?? null, state: o.billing?.state ?? null, recurring: o.created_via === "subscription" } });
    }
    if (orders.length < 100) break;
  }
  // WooCommerce Subscriptions, when the store has it
  try {
    const { body } = await getJson(wooUrl(w, "subscriptions", { after: since, per_page: "100" }));
    for (const s of (body ?? []) as { id: number; date_created_gmt: string; total: string }[]) out.push({ kind: "subscription", external_id: String(s.id), occurred_at: `${s.date_created_gmt}Z`, value: Number(s.total ?? 0) });
  } catch {}
  return out;
}

const GHL = "https://services.leadconnectorhq.com";
type Ghl = { token: string; location: string };
const ghlHeaders = (g: Ghl) => ({ Authorization: `Bearer ${g.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" });
/** Pipeline stages read as booked (an appointment, consult or estimate set) */
const BOOKED = /book|appoint|schedul|consult|estimate|demo|call set|showed/i;
async function ghlEvents(g: Ghl, since: string): Promise<{ events: Event[]; stages: Record<string, string> }> {
  const events: Event[] = [];
  // Contacts created: the leads, with where they came from and where they live
  for (let page = 1; page <= 10; page++) {
    const { body } = await getJson(`${GHL}/contacts/search`, {
      method: "POST",
      headers: ghlHeaders(g),
      body: JSON.stringify({ locationId: g.location, page, pageLimit: 100, sort: [{ field: "dateAdded", direction: "desc" }], filters: [{ field: "dateAdded", operator: "range", value: { gte: since, lte: new Date().toISOString() } }] }),
    });
    const contacts = ((body as { contacts?: unknown[] }).contacts ?? []) as { id: string; dateAdded: string; source?: string; city?: string; state?: string; attributionSource?: { utmSource?: string; medium?: string; sessionSource?: string; fbclid?: string; gclid?: string; url?: string } }[];
    for (const c of contacts) {
      const a = c.attributionSource ?? {};
      events.push({ kind: "lead", external_id: c.id, occurred_at: c.dateAdded, attribution: attributionOf(a.utmSource, a.medium, a.sessionSource, a.fbclid ? "fbclid" : null, a.gclid ? "gclid" : null, a.url, c.source), detail: { source: c.source ?? null, city: c.city ?? null, state: c.state ?? null } });
    }
    if (contacts.length < 100) break;
  }
  // The pipeline: which stage is "booked", and opportunities that moved since
  const { body: p } = await getJson(`${GHL}/opportunities/pipelines?locationId=${encodeURIComponent(g.location)}`, { headers: ghlHeaders(g) });
  const stages: Record<string, string> = {};
  for (const pl of ((p as { pipelines?: { name: string; stages?: { id: string; name: string }[] }[] }).pipelines ?? [])) for (const s of pl.stages ?? []) stages[s.id] = `${pl.name} › ${s.name}`;
  for (let page = 1; page <= 10; page++) {
    const { body } = await getJson(`${GHL}/opportunities/search?location_id=${encodeURIComponent(g.location)}&limit=100&page=${page}`, { headers: ghlHeaders(g) });
    const opps = ((body as { opportunities?: unknown[] }).opportunities ?? []) as { id: string; status: string; pipelineStageId?: string; monetaryValue?: number; createdAt?: string; updatedAt?: string; lastStatusChangeAt?: string; lastStageChangeAt?: string; source?: string; contact?: { id?: string } }[];
    let older = 0;
    for (const o of opps) {
      const moved = o.lastStatusChangeAt ?? o.lastStageChangeAt ?? o.updatedAt ?? o.createdAt ?? "";
      if (!moved || moved < since) {
        older++;
        continue;
      }
      const base = { attribution: attributionOf(o.source), detail: { stage: o.pipelineStageId ? (stages[o.pipelineStageId] ?? null) : null, contact: o.contact?.id ?? null } };
      if (o.status === "won") events.push({ kind: "won", external_id: o.id, occurred_at: o.lastStatusChangeAt ?? moved, value: o.monetaryValue ?? null, ...base });
      else if (o.status === "lost" || o.status === "abandoned") events.push({ kind: "lost", external_id: o.id, occurred_at: o.lastStatusChangeAt ?? moved, value: o.monetaryValue ?? null, ...base });
      else if (o.pipelineStageId && BOOKED.test(stages[o.pipelineStageId] ?? "")) events.push({ kind: "booked", external_id: o.id, occurred_at: o.lastStageChangeAt ?? moved, value: o.monetaryValue ?? null, ...base });
    }
    if (opps.length < 100 || older === opps.length) break;
  }
  return { events, stages };
}

const HUBSPOT = "https://api.hubapi.com";
async function hubspotEvents(token: string, since: string): Promise<Event[]> {
  const events: Event[] = [];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ms = String(Date.parse(since));
  const search = async (object: "contacts" | "deals", prop: string, properties: string[]) => {
    const rows: { id: string; properties: Record<string, string | null> }[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { body } = await getJson(`${HUBSPOT}/crm/v3/objects/${object}/search`, { method: "POST", headers, body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: prop, operator: "GTE", value: ms }] }], properties, limit: 100, ...(after ? { after } : {}) }) });
      const b = body as { results?: { id: string; properties: Record<string, string | null> }[]; paging?: { next?: { after?: string } } };
      rows.push(...(b.results ?? []));
      after = b.paging?.next?.after;
      if (!after) break;
    }
    return rows;
  };
  for (const c of await search("contacts", "createdate", ["createdate", "hs_analytics_source", "hs_analytics_source_data_1", "city", "state"])) {
    const p = c.properties;
    events.push({ kind: "lead", external_id: c.id, occurred_at: p.createdate ?? since, attribution: attributionOf(p.hs_analytics_source, p.hs_analytics_source_data_1), detail: { source: p.hs_analytics_source ?? null, city: p.city ?? null, state: p.state ?? null } });
  }
  for (const d of await search("deals", "hs_lastmodifieddate", ["dealstage", "amount", "closedate", "hs_is_closed_won", "hs_is_closed", "hs_lastmodifieddate", "hs_analytics_source"])) {
    const p = d.properties;
    const value = p.amount ? Number(p.amount) : null;
    const at = p.closedate ?? p.hs_lastmodifieddate ?? since;
    const base = { attribution: attributionOf(p.hs_analytics_source), detail: { stage: p.dealstage ?? null } };
    if (p.hs_is_closed_won === "true") events.push({ kind: "won", external_id: d.id, occurred_at: at, value, ...base });
    else if (p.hs_is_closed === "true") events.push({ kind: "lost", external_id: d.id, occurred_at: at, value, ...base });
    else if (BOOKED.test(p.dealstage ?? "")) events.push({ kind: "booked", external_id: d.id, occurred_at: p.hs_lastmodifieddate ?? at, value, ...base });
  }
  return events;
}

// ─── Connecting ────────────────────────────────────────────────────────────

export type ConnectInput = { kind: IntegrationKind; account: string; secret: string; secret2?: string; label?: string };

/** Checks the key works before anything is saved, so a wrong token never sits there failing quietly */
async function testConnection(i: ConnectInput): Promise<{ ok: true; account: string; label: string | null } | { ok: false; error: string }> {
  try {
    if (i.kind === "shopify") {
      const shop = shopDomain(i.account);
      const { body } = await getJson(`https://${shop}/admin/api/${SHOPIFY_API}/shop.json`, { headers: { "X-Shopify-Access-Token": i.secret.trim() } });
      return { ok: true, account: shop, label: (body as { shop?: { name?: string } }).shop?.name ?? null };
    }
    if (i.kind === "woocommerce") {
      const site = siteOrigin(i.account);
      await getJson(wooUrl({ site, key: i.secret.trim(), secret: (i.secret2 ?? "").trim() }, "orders", { per_page: "1" }));
      return { ok: true, account: site, label: null };
    }
    if (i.kind === "gohighlevel") {
      const g = { token: i.secret.trim(), location: i.account.trim() };
      const { body } = await getJson(`${GHL}/locations/${encodeURIComponent(g.location)}`, { headers: ghlHeaders(g) });
      return { ok: true, account: g.location, label: (body as { location?: { name?: string } }).location?.name ?? null };
    }
    if (i.kind === "hubspot") {
      await getJson(`${HUBSPOT}/crm/v3/objects/contacts?limit=1`, { headers: { Authorization: `Bearer ${i.secret.trim()}` } });
      return { ok: true, account: i.account.trim() || "HubSpot", label: null };
    }
    return { ok: true, account: i.account.trim() || "CRM", label: i.label ?? null };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /^40[13]/.test(m) ? "The key didn't work: check it has read access to orders (or contacts and opportunities)." : `Couldn't reach it: ${m.slice(0, 160)}` };
  }
}

/** Saves a connection (tested first); the key is encrypted and never comes back to the page */
export async function connectIntegration(admin: SupabaseClient, clientId: string, i: ConnectInput, by: string) {
  if (i.kind !== "other" && !i.secret.trim()) return { ok: false as const, error: "Paste the key." };
  if (i.kind !== "other" && !secretsConfigured()) return { ok: false as const, error: "Keys can't be stored safely yet: KAIZEN_SECRETS_KEY needs to be set in Vercel." };
  const t = await testConnection(i);
  if (!t.ok) return t;
  const { data: row, error } = await admin
    .from("client_integrations")
    .upsert({ client_id: clientId, kind: i.kind, account: t.account, label: i.label?.trim() || t.label, status: i.kind === "other" ? "pending" : "connected", last_error: null, created_by: by }, { onConflict: "client_id,kind,account" })
    .select("id")
    .single();
  if (error || !row) return { ok: false as const, error: error?.message ?? "Couldn't save it." };
  if (i.kind !== "other") {
    const secret = i.kind === "woocommerce" ? JSON.stringify({ key: i.secret.trim(), secret: (i.secret2 ?? "").trim() }) : i.secret.trim();
    await admin.from("client_integration_secrets").upsert({ integration_id: row.id, secret: encrypt(secret), updated_at: new Date().toISOString() });
  }
  return { ok: true as const, id: row.id as string };
}

export async function disconnectIntegration(admin: SupabaseClient, id: string) {
  await admin.from("client_integration_secrets").delete().eq("integration_id", id);
  await admin.from("client_integrations").update({ status: "disconnected" }).eq("id", id);
}

// ─── Pulling ───────────────────────────────────────────────────────────────

/** One connection: what's new since the last pull (90 days the first time), then the days it touched summed again */
export async function syncIntegration(admin: SupabaseClient, id: string) {
  const { data: i } = await admin.from("client_integrations").select("id, client_id, kind, account, status, last_synced_at, settings").eq("id", id).single();
  if (!i || i.status === "disconnected" || i.kind === "other") return { skipped: true };
  const { data: sec } = await admin.from("client_integration_secrets").select("secret").eq("integration_id", id).maybeSingle();
  if (!sec) return { skipped: true };
  const started = new Date().toISOString();
  const since = new Date((i.last_synced_at ? Date.parse(i.last_synced_at as string) : Date.now() - 90 * 86_400_000) - 2 * 86_400_000).toISOString();
  const source = i.kind as IntegrationKind;
  try {
    const secret = decrypt(sec.secret as string);
    let events: Event[] = [];
    let settings = (i.settings ?? {}) as Record<string, unknown>;
    if (source === "shopify") events = await shopifyOrders({ token: secret, shop: i.account as string }, since);
    else if (source === "woocommerce") {
      const k = JSON.parse(secret) as { key: string; secret: string };
      // Customers already seen (so a returning buyer isn't counted new)
      const { data: seenRows } = await admin.from("client_business_events").select("detail").eq("client_id", i.client_id).eq("source", source).eq("kind", "order").lt("occurred_at", since).limit(20000);
      const seen = new Set((seenRows ?? []).map((r) => (r.detail as { ck?: string } | null)?.ck).filter(Boolean) as string[]);
      events = await wooOrders({ site: i.account as string, key: k.key, secret: k.secret }, since, seen);
    } else if (source === "gohighlevel") {
      const r = await ghlEvents({ token: secret, location: i.account as string }, since);
      events = r.events;
      settings = { ...settings, stages: r.stages };
    } else if (source === "hubspot") events = await hubspotEvents(secret, since);
    for (let k = 0; k < events.length; k += 500) {
      await admin.from("client_business_events").upsert(
        events.slice(k, k + 500).map((e) => ({ client_id: i.client_id, source, kind: e.kind, external_id: e.external_id, occurred_at: e.occurred_at, value: e.value ?? null, first_order: e.first_order ?? null, attribution: e.attribution ?? null, detail: e.detail ?? {} })),
        { onConflict: "client_id,source,kind,external_id", ignoreDuplicates: false },
      );
    }
    await sumDays(admin, i.client_id as string, source, since);
    await admin.from("client_integrations").update({ status: "connected", last_synced_at: started, last_error: null, settings }).eq("id", id);
    return { events: events.length };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("client_integrations").update({ status: "error", last_error: m.slice(0, 300) }).eq("id", id);
    return { error: m };
  }
}

/** Each day since a moment, summed again from the events (so a re-read order never counts twice) */
async function sumDays(admin: SupabaseClient, clientId: string, source: string, since: string) {
  const { data: rows } = await admin.from("client_business_events").select("kind, occurred_at, value, first_order, attribution, detail").eq("client_id", clientId).eq("source", source).gte("occurred_at", since).limit(50000);
  const days = new Map<string, { revenue: number; orders: number; new_customers: number; returning_customers: number; subscriptions_started: number; leads: number; booked: number; won: number; lost: number; won_value: number; from_meta: number; from_google: number }>();
  for (const r of rows ?? []) {
    const d = nyDate(r.occurred_at as string);
    const x = days.get(d) ?? { revenue: 0, orders: 0, new_customers: 0, returning_customers: 0, subscriptions_started: 0, leads: 0, booked: 0, won: 0, lost: 0, won_value: 0, from_meta: 0, from_google: 0 };
    const v = Number(r.value ?? 0);
    if (r.kind === "order") {
      x.orders++;
      x.revenue += v;
      if (r.first_order === true) x.new_customers++;
      else if (r.first_order === false) x.returning_customers++;
    }
    if (r.kind === "subscription") x.subscriptions_started++;
    if (r.kind === "lead") x.leads++;
    if (r.kind === "booked") x.booked++;
    if (r.kind === "won") {
      x.won++;
      x.won_value += v;
    }
    if (r.kind === "lost") x.lost++;
    // Paid: orders and leads (the top of each funnel)
    if (r.kind === "order" || r.kind === "lead") {
      if (r.attribution === "meta") x.from_meta++;
      if (r.attribution === "google") x.from_google++;
    }
    days.set(d, x);
  }
  if (days.size)
    await admin.from("client_business_daily").upsert(
      [...days].map(([date, x]) => ({ client_id: clientId, date, source, ...x, revenue: Math.round(x.revenue * 100) / 100, won_value: Math.round(x.won_value * 100) / 100, updated_at: new Date().toISOString() })),
      { onConflict: "client_id,date,source" },
    );
}

/** Every hour: each connection pulled (a few at a time, oldest first), then the day's notices */
export async function keepIntegrations(admin: SupabaseClient, max = 8) {
  const { data: list } = await admin.from("client_integrations").select("id").in("status", ["connected", "error"]).neq("kind", "other").order("last_synced_at", { ascending: true, nullsFirst: true }).limit(max);
  const out: Record<string, unknown> = {};
  for (const r of list ?? []) out[r.id as string] = await syncIntegration(admin, r.id as string).catch((e) => String(e));
  const notices = await businessNotices(admin).catch((e) => String(e));
  return { synced: out, notices };
}

// ─── What it says ──────────────────────────────────────────────────────────

export type BusinessSummary = {
  sources: string[];
  store: boolean;
  crm: boolean;
  month: Totals;
  last30: Totals;
  prior30: Totals;
};
type Totals = { revenue: number; orders: number; newCustomers: number; returning: number; subscriptions: number; leads: number; booked: number; won: number; lost: number; wonValue: number; fromMeta: number; fromGoogle: number };
const zero = (): Totals => ({ revenue: 0, orders: 0, newCustomers: 0, returning: 0, subscriptions: 0, leads: 0, booked: 0, won: 0, lost: 0, wonValue: 0, fromMeta: 0, fromGoogle: 0 });

/** The client's business as their store and CRM report it: this month, the last 30 days and the 30 before. null with no connection. */
export async function businessSummary(db: SupabaseClient, clientId: string, range?: { start: string; end: string }): Promise<BusinessSummary | null> {
  const { data: conns } = await db.from("client_integrations").select("kind").eq("client_id", clientId).neq("status", "disconnected");
  if (!conns?.length) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const from = range?.start && range.start < day(60) ? range.start : day(60);
  const { data: rows } = await db.from("client_business_daily").select("*").eq("client_id", clientId).gte("date", from).limit(5000);
  const add = (t: Totals, r: Record<string, unknown>) => {
    t.revenue += Number(r.revenue ?? 0);
    t.orders += Number(r.orders ?? 0);
    t.newCustomers += Number(r.new_customers ?? 0);
    t.returning += Number(r.returning_customers ?? 0);
    t.subscriptions += Number(r.subscriptions_started ?? 0);
    t.leads += Number(r.leads ?? 0);
    t.booked += Number(r.booked ?? 0);
    t.won += Number(r.won ?? 0);
    t.lost += Number(r.lost ?? 0);
    t.wonValue += Number(r.won_value ?? 0);
    t.fromMeta += Number(r.from_meta ?? 0);
    t.fromGoogle += Number(r.from_google ?? 0);
  };
  const month = zero();
  const last30 = zero();
  const prior30 = zero();
  const monthStart = `${today.slice(0, 8)}01`;
  const inRange = range ? zero() : null;
  for (const r of rows ?? []) {
    const d = r.date as string;
    if (d >= monthStart) add(month, r);
    if (d > day(30)) add(last30, r);
    else if (d > day(60)) add(prior30, r);
    if (inRange && range && d >= range.start && d <= range.end) add(inRange, r);
  }
  const kinds = conns.map((c) => c.kind as IntegrationKind);
  return { sources: [...new Set(kinds.map((k) => INTEGRATION_NAMES[k]))], store: kinds.some((k) => k === "shopify" || k === "woocommerce"), crm: kinds.some((k) => k === "gohighlevel" || k === "hubspot" || k === "other"), month: inRange ?? month, last30, prior30 };
}

const $ = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

/** What the agents read: real customers, subscriptions and lead outcomes, last 30 days against the 30 before */
export async function businessBlock(db: SupabaseClient, clientId: string) {
  const s = await businessSummary(db, clientId);
  if (!s) return "";
  const lines = [`<business_results sources="${s.sources.join(", ")}">`, "What their own store or CRM recorded (not the ad platforms' numbers). Judge what works by this: if it isn't profitable here, it isn't working."];
  const t = (x: Totals) => [s.store && `${x.orders} orders, ${$(x.revenue)} revenue, ${x.newCustomers} new customers and ${x.returning} returning, ${x.subscriptions} subscriptions started`, s.crm && `${x.leads} leads, ${x.booked} booked, ${x.won} won (${$(x.wonValue)}), ${x.lost} lost`, `${x.fromMeta} from Meta and ${x.fromGoogle} from Google by UTMs or click IDs`].filter(Boolean).join("; ");
  lines.push(`Last 30 days: ${t(s.last30)}.`, `The 30 days before: ${t(s.prior30)}.`);
  if (s.crm && s.last30.leads) lines.push(`Lead to booked ${pct(s.last30.booked, s.last30.leads)}, booked to won ${pct(s.last30.won, s.last30.booked || s.last30.leads)}.`);
  lines.push("</business_results>");
  return lines.join("\n");
}

// ─── Notices to the team ───────────────────────────────────────────────────

/**
 * Once a day (9am New York): each CRM client's buyers get yesterday's lead outcomes in one note (low key, not a pop-up),
 * stores get a note when new customers swing hard against their usual week, and on the 1st every connected client's
 * month: new customers acquired and subscriptions started.
 */
export async function businessNotices(admin: SupabaseClient) {
  const now = new Date();
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (ny.getHours() !== 9) return "not the hour";
  const { data: conns } = await admin.from("client_integrations").select("client_id, kind, clients!inner(name, slug, archived_at)").in("status", ["connected", "error"]).is("clients.archived_at", null);
  const byClient = new Map<string, { name: string; slug: string; kinds: Set<string> }>();
  for (const c of conns ?? []) {
    const cl = c.clients as unknown as { name: string; slug: string };
    const x = byClient.get(c.client_id as string) ?? { name: cl.name, slug: cl.slug, kinds: new Set<string>() };
    x.kinds.add(c.kind as string);
    byClient.set(c.client_id as string, x);
  }
  const yesterday = new Date(Date.parse(`${now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  let sent = 0;
  for (const [clientId, c] of byClient) {
    const { data: who } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]);
    const buyers = [...new Set((who ?? []).map((w) => w.profile_id as string))];
    if (!buyers.length) continue;
    const note = (title: string, body: string, key: string, priority: "normal" | "critical" = "normal") => {
      for (const id of buyers) rows.push({ profile_id: id, kind: "business", title: title.slice(0, 200), body: body.slice(0, 1000), href: `/clients/${c.slug}`, client_id: clientId, key, priority });
      sent++;
    };
    const s = await businessSummary(admin, clientId);
    if (!s) continue;
    const { data: y } = await admin.from("client_business_daily").select("*").eq("client_id", clientId).eq("date", yesterday);
    const yd = zero();
    for (const r of y ?? []) {
      yd.leads += Number(r.leads ?? 0);
      yd.booked += Number(r.booked ?? 0);
      yd.won += Number(r.won ?? 0);
      yd.lost += Number(r.lost ?? 0);
      yd.wonValue += Number(r.won_value ?? 0);
      yd.fromMeta += Number(r.from_meta ?? 0);
      yd.fromGoogle += Number(r.from_google ?? 0);
      yd.newCustomers += Number(r.new_customers ?? 0);
    }
    // Lead gen: yesterday's outcomes, batched
    if (s.crm && yd.leads + yd.booked + yd.won + yd.lost > 0)
      note(`${c.name}: yesterday in their CRM`, `${yd.leads} new lead${yd.leads === 1 ? "" : "s"} (${yd.fromMeta} from Meta, ${yd.fromGoogle} from Google), ${yd.booked} booked, ${yd.won} won${yd.wonValue ? ` (${$(yd.wonValue)})` : ""}, ${yd.lost} lost.`, `crm-day:${clientId}:${yesterday}`);
    // Stores: a hard swing in new customers, week against their usual week
    if (s.store) {
      const week = s.last30.newCustomers / (30 / 7);
      const { data: wk } = await admin.from("client_business_daily").select("new_customers").eq("client_id", clientId).gte("date", new Date(Date.parse(`${yesterday}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10));
      const thisWeek = (wk ?? []).reduce((t, r) => t + Number(r.new_customers ?? 0), 0);
      if (week >= 5 && Math.abs(thisWeek - week) / week >= 0.4)
        note(
          `${c.name}: new customers ${thisWeek > week ? "up" : "down"} ${Math.round((Math.abs(thisWeek - week) / week) * 100)}% this week`,
          `${thisWeek} new customers in the last 7 days against about ${Math.round(week)} in a usual week (from their store, not Meta or Google).`,
          `ecom-swing:${clientId}:${yesterday.slice(0, 7)}-${Math.ceil(Number(yesterday.slice(8)) / 7)}`,
        );
    }
    // The 1st: last month in one line
    if (ny.getDate() === 1) {
      const last = new Date(ny.getFullYear(), ny.getMonth() - 1, 1);
      const m = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
      const { data: mr } = await admin.from("client_business_daily").select("*").eq("client_id", clientId).gte("date", `${m}-01`).lt("date", `${ny.getFullYear()}-${String(ny.getMonth() + 1).padStart(2, "0")}-01`);
      const mt = zero();
      for (const r of mr ?? []) {
        mt.newCustomers += Number(r.new_customers ?? 0);
        mt.subscriptions += Number(r.subscriptions_started ?? 0);
        mt.leads += Number(r.leads ?? 0);
        mt.won += Number(r.won ?? 0);
        mt.revenue += Number(r.revenue ?? 0);
        mt.fromMeta += Number(r.from_meta ?? 0);
        mt.fromGoogle += Number(r.from_google ?? 0);
      }
      const month = last.toLocaleDateString("en-US", { month: "long" });
      note(
        `${c.name}: ${month} in their ${s.store ? "store" : "CRM"}`,
        s.store ? `${mt.newCustomers} new customers acquired, ${mt.subscriptions} subscriptions started, ${$(mt.revenue)} revenue (${mt.fromMeta} orders from Meta, ${mt.fromGoogle} from Google).` : `${mt.leads} leads, ${mt.won} won (${mt.fromMeta} leads from Meta, ${mt.fromGoogle} from Google).`,
        `business-month:${clientId}:${m}`,
      );
    }
  }
  if (rows.length) await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true });
  return { notes: sent };
}
