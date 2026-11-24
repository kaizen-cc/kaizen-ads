import { getViewer } from "@/lib/auth";
import { appSecret, shopifyAppConfigured } from "@/lib/shopify/api";
import { shopDomain, validQueryHmac } from "@/lib/shopify/core";
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

  // Opened from Shopify's side
  if (!clientId) {
    if (!shop || !validQueryHmac(url.searchParams, appSecret())) return shopifyPage("Link expired", "Open Kaizen OS from your Shopify admin (Apps), or ask your Kaizen team for a new link.");
    const [{ data: linked }, { data: waiting }] = await Promise.all([
      admin.from("client_integrations").select("label").eq("kind", "shopify").eq("account", shop).eq("status", "connected").limit(1).maybeSingle(),
      admin.from("shopify_pending_installs").select("name").eq("shop", shop).maybeSingle(),
    ]);
    if (linked) return shopifyPage("Kaizen OS is connected", `${linked.label ?? shop}'s sales are read by Kaizen OS (read only). Your results show in your Kaizen reports and portal. To disconnect, uninstall the app from Settings › Apps.`, 200);
    if (waiting) return shopifyPage("Kaizen OS is connected", `${waiting.name ?? shop} is connected (read only). Your Kaizen team is linking it to your account; nothing else is needed from you.`, 200);
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
