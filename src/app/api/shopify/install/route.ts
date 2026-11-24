import { getViewer } from "@/lib/auth";
import { appSecret, shopifyAppConfigured, tokenExchange } from "@/lib/shopify/api";
import { shopDomain, validQueryHmac, verifyIdToken } from "@/lib/shopify/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { backTo, installUrl, mayInstall, shopifyPage } from "@/lib/shopify/oauth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The Kaizen OS app's install link and App URL.
//   From Kaizen OS: /api/shopify/install?client=<id>&shop=<store> (the client page, or the portal's onboarding guide):
//     the person's right to connect this client is checked, then they're sent to Shopify to approve read-only access.
//   From Shopify (the App Store listing, the store admin; hmac signed): a store not connected yet goes straight to
//     Shopify's approval (Shopify requires it on install); afterwards it's linked to its client automatically when its
//     address is known, else it waits for the team. A connected store gets a short status page.

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!shopifyAppConfigured()) return shopifyPage("Shopify isn't set up yet", "Kaizen OS's Shopify app keys aren't in place yet. Your Kaizen team will send a link once it is.", 503);
  if (!adminConfigured()) return shopifyPage("Not set up", "Kaizen OS isn't set up here.", 503);
  const admin = createAdminClient();
  const shop = shopDomain(url.searchParams.get("shop"));
  const clientId = url.searchParams.get("client");

  // Opened in Shopify admin (embedded): Shopify's session token says which store; installed by Shopify (managed
  // install), so the store's token comes from exchanging it, no extra approval screen
  const idToken = url.searchParams.get("id_token");
  if (!clientId && idToken) {
    const who = verifyIdToken(idToken, appSecret(), process.env.SHOPIFY_API_KEY ?? "");
    if (!who) return shopifyPage("Link expired", "Open Kaizen OS again from your Shopify admin (Apps).", 401);
    return storePage(admin, who.shop, async () => {
      const store = await import("@/lib/shopify/store");
      const tokens = await tokenExchange(who.shop, idToken);
      await store.parkInstall(admin, who.shop, tokens);
      const linkTo = await store.clientForShop(admin, who.shop);
      if (linkTo) {
        const r = await store.linkPending(admin, linkTo, who.shop, null);
        if (r.ok) after(() => store.syncShopify(admin, r.id, Date.now() + 240_000).then(() => undefined).catch(() => undefined));
      }
    });
  }

  // Opened from Shopify's side, not embedded (hmac signed)
  if (!clientId) {
    if (!shop || !validQueryHmac(url.searchParams, appSecret())) return shopifyPage("Link expired", "Open Kaizen OS from your Shopify admin (Apps), or ask your Kaizen team for a new link.");
    const known = await storeState(admin, shop);
    if (known) return storePage(admin, shop, null);
    const to = installUrl(shop, "", "shopify");
    return to ? Response.redirect(to, 302) : shopifyPage("Not set up", "Kaizen OS's Shopify app keys aren't in place yet.", 503);
  }

  if (!shop) return shopifyPage("Check the store address", "The store address ends in .myshopify.com (Shopify admin › Settings › Domains).");
  const viewer = await getViewer();
  const may = await mayInstall(admin, viewer, clientId);
  if (!may.ok) return shopifyPage("Not allowed", may.error, 403);
  const to = installUrl(shop, clientId, may.from);
  if (!to) return Response.redirect(backTo(may.from, may.slug, { shopify: "error", reason: "not_configured" }), 302);
  return Response.redirect(to, 302);
}

/** Connected, waiting for its client, or not known yet */
async function storeState(admin: SupabaseClient, shop: string): Promise<"connected" | "waiting" | null> {
  const [{ data: linked }, { data: waiting }] = await Promise.all([
    admin.from("client_integrations").select("id").eq("kind", "shopify").eq("account", shop).eq("status", "connected").limit(1).maybeSingle(),
    admin.from("shopify_pending_installs").select("shop").eq("shop", shop).maybeSingle(),
  ]);
  return linked ? "connected" : waiting ? "waiting" : null;
}

/** The app's page for a store: connected (with its last 30 days) or waiting; `connect` runs first for a store not known yet */
async function storePage(admin: SupabaseClient, shop: string, connect: (() => Promise<void>) | null) {
  let state = await storeState(admin, shop);
  if (!state && connect) {
    try {
      await connect();
    } catch (e) {
      return shopifyPage("Couldn't connect", `Shopify didn't finish the connection (${e instanceof Error ? e.message.slice(0, 80) : "try again"}). Open Kaizen OS again from Apps.`, 502, { shop });
    }
    state = await storeState(admin, shop);
  }
  const { storeGlance } = await import("@/lib/shopify/store");
  const glance = state === "connected" ? await storeGlance(admin, shop).catch(() => null) : null;
  if (state === "connected")
    return shopifyPage("Kaizen OS is connected", "Kaizen OS reads your store's orders (read only) so your Kaizen team sees real sales next to your ad spend; they also show in your Kaizen reports and portal. To disconnect, uninstall the app.", 200, { shop, glance: glance && glance.days ? glance : null });
  return shopifyPage("Kaizen OS is connected", "Your store is connected (read only). Your Kaizen team is linking it to your account; your numbers show here once its orders are read.", 200, { shop });
}
