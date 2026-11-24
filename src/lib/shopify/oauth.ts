import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "@/lib/auth";
import { mayEditSetup } from "@/lib/setup-access";
import { portalUrl, siteUrl } from "@/lib/site";
import { appSecret, authorizeUrl } from "./api";
import { SHOPIFY_REDIRECT_PATH, shopDomain, signState } from "./core";

// Installing the Kaizen OS app on a client's store: from their client page (an exec or lead) or from the client's own
// portal (their onboarding guide). The state we hand Shopify is signed and lasts 30 minutes, so the callback knows which
// client the store belongs to without a cookie (the portal and the app answer on different addresses).

export const redirectUri = () => process.env.SHOPIFY_REDIRECT_URI || `${siteUrl()}${SHOPIFY_REDIRECT_PATH}`;

/** Where someone goes back to after installing (or failing): the client page's store card, or the portal guide */
export function backTo(from: "team" | "portal", slug: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString();
  return from === "portal" ? `${portalUrl()}/c/${slug}/start${q ? `?${q}` : ""}` : `${siteUrl()}/clients/${slug}${q ? `?${q}` : ""}#store`;
}

/** May this person install the app for this client? The team's leads and execs, or the client's own contacts. */
export async function mayInstall(admin: SupabaseClient, viewer: Viewer, clientId: string): Promise<{ ok: true; slug: string; from: "team" | "portal" } | { ok: false; error: string }> {
  const { data: c } = await admin.from("clients").select("id, slug, portal_live").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "No such client." };
  if (viewer.kind === "contact") return c.portal_live && viewer.brands.some((b) => b.id === c.id) ? { ok: true, slug: c.slug as string, from: "portal" } : { ok: false, error: "Not found." };
  if (viewer.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (!mayEditSetup(viewer)) return { ok: false, error: "Only executives and team leads connect a client's store." };
  return { ok: true, slug: c.slug as string, from: "team" };
}

/** The Shopify approval page for this store and client */
export function installUrl(shopInput: string, clientId: string, from: "team" | "portal" | "shopify"): string | null {
  const shop = shopDomain(shopInput);
  const secret = appSecret();
  if (!shop || !secret) return null;
  const state = signState({ client: clientId, shop, from, nonce: randomBytes(9).toString("base64url"), exp: Date.now() + 30 * 60_000 }, secret);
  return authorizeUrl(shop, state, redirectUri());
}

/** The merchant's own store in a few numbers, for the app's page in Shopify admin */
export type StoreGlance = { last30: { revenue: number; orders: number }; days: number; historyFrom: string | null; currency: string | null };

/**
 * The app's page for the merchant (the App URL, in Shopify's flow): what's connected and, once read, their store's last
 * 30 days. With a store known it loads Shopify App Bridge and may be framed by that store's admin, so it works embedded.
 */
export function shopifyPage(title: string, text: string, status = 400, opts: { shop?: string | null; glance?: StoreGlance | null } = {}) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const key = process.env.SHOPIFY_API_KEY ?? "";
  const embed = Boolean(opts.shop && key);
  const g = opts.glance;
  const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: g?.currency || "USD", maximumFractionDigits: 0 }).format(n);
  const glance = g
    ? `<div class="grid"><div class="tile"><span>Store revenue, last 30 days</span><b>${esc(money(g.last30.revenue))}</b></div><div class="tile"><span>Orders, last 30 days</span><b>${g.last30.orders.toLocaleString("en-US")}</b></div><div class="tile"><span>Days of history read</span><b>${g.days.toLocaleString("en-US")}</b></div></div>${g.historyFrom ? `<p class="faint">History from ${esc(g.historyFrom)}. Refreshed every hour. Read only: nothing in your store changes.</p>` : ""}`
    : "";
  const head = embed ? `<meta name="shopify-api-key" content="${esc(key)}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>` : "";
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  if (embed) headers["content-security-policy"] = `frame-ancestors https://${opts.shop} https://admin.shopify.com;`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">${head}<title>${esc(title)} · Kaizen OS</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px;background:Canvas;color:CanvasText}h1{font-size:22px}a{color:inherit}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}.tile{border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px;padding:14px}.tile span{display:block;font-size:12px;opacity:.65;text-transform:uppercase;letter-spacing:.06em}.tile b{display:block;font-size:24px;margin-top:4px;font-weight:600}.faint{opacity:.6;font-size:14px}</style><body><h1>${esc(title)}</h1><p>${esc(text)}</p>${glance}<p class="faint">Questions: <a href="mailto:santi@kaizenmarketing.agency">santi@kaizenmarketing.agency</a> · <a href="${esc(siteUrl())}/privacy#shopify" target="_blank" rel="noreferrer">Privacy</a></p></body>`,
    { status, headers },
  );
}
