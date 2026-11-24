import { after } from "next/server";
import { appSecret, exchangeCode, shopifyAppConfigured } from "@/lib/shopify/api";
import { readState, shopDomain, validQueryHmac } from "@/lib/shopify/core";
import { backTo, shopifyPage } from "@/lib/shopify/oauth";
import { siteUrl } from "@/lib/site";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Back from Shopify after the merchant approved: Shopify's signature and our signed state are checked (the store must be
// the one the install started for), the code is swapped for the store's offline token, the store is saved under that
// client, and its full history starts reading right away (then every 10 minutes until it reaches the first order).
// An install started from Shopify's side has no client yet: it's linked to the one client whose site or onboarding
// named this store, else it waits (encrypted) for the team to link it on the client page.

export const maxDuration = 300;

export async function GET(request: Request) {
  const url = new URL(request.url);
  let back = (params: Record<string, string>) => `${siteUrl()}/clients?${new URLSearchParams(params)}`;
  const fail = (reason: string) => Response.redirect(back({ shopify: "error", reason }), 302);
  if (!shopifyAppConfigured() || !adminConfigured()) return fail("not_configured");
  const secret = appSecret();
  const state = readState(url.searchParams.get("state"), secret);
  if (!state) return fail("expired");
  const shop = shopDomain(url.searchParams.get("shop"));
  if (!validQueryHmac(url.searchParams, secret) || !shop || shop !== state.shop) return shopifyPage("Couldn't connect", "The approval didn't check out. Open Kaizen OS from your Shopify admin (Apps) and try again.", 400);
  const code = url.searchParams.get("code");
  const admin = createAdminClient();
  const store = await import("@/lib/shopify/store");
  const { tellShopifyConnected } = await import("@/lib/shopify/notify");

  // Installed from Shopify's side
  if (!state.client) {
    if (!code) return shopifyPage("Not connected", "The app wasn't approved, so nothing was connected.", 400);
    try {
      const tokens = await exchangeCode(shop, code);
      const name = await store.parkInstall(admin, shop, tokens);
      const clientId = await store.clientForShop(admin, shop);
      if (clientId) {
        const r = await store.linkPending(admin, clientId, shop, null);
        if (r.ok)
          after(async () => {
            await tellShopifyConnected(admin, clientId, r.name, "portal").catch(() => undefined);
            await store.syncShopify(admin, r.id, Date.now() + 240_000).catch(() => undefined);
          });
      }
      return shopifyPage("Kaizen OS is connected", `${name} is connected to Kaizen OS with read-only access to orders. Your Kaizen team sees your real sales next to your ads; nothing in your store changes. You can close this page.`, 200);
    } catch (e) {
      return shopifyPage("Couldn't connect", `Shopify didn't finish the connection (${e instanceof Error ? e.message.slice(0, 80) : "try again"}).`, 502);
    }
  }

  const { data: client } = await admin.from("clients").select("slug").eq("id", state.client).maybeSingle();
  if (!client) return fail("client");
  back = (params) => backTo(state.from === "portal" ? "portal" : "team", client.slug as string, params);
  if (!code) return fail(url.searchParams.get("error") ?? "denied");
  try {
    const tokens = await exchangeCode(shop, code);
    const r = await store.connectShopify(admin, state.client, { shop, tokens, auth: "oauth", by: null });
    if (!r.ok) return fail(r.error.slice(0, 120));
    after(async () => {
      await tellShopifyConnected(admin, state.client, r.name, state.from === "portal" ? "portal" : "team").catch(() => undefined);
      await store.syncShopify(admin, r.id, Date.now() + 240_000).catch(() => undefined);
    });
    return Response.redirect(back({ shopify: "connected" }), 302);
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 80) : "exchange_failed");
  }
}
