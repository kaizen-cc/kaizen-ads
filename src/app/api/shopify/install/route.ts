import { getViewer } from "@/lib/auth";
import { appSecret, shopifyAppConfigured } from "@/lib/shopify/api";
import { shopDomain, validQueryHmac } from "@/lib/shopify/core";
import { backTo, installUrl, mayInstall } from "@/lib/shopify/oauth";
import { siteUrl } from "@/lib/site";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The Kaizen OS app's install link and App URL.
//   From Kaizen OS: /api/shopify/install?client=<id>&shop=<store> (the client page, or the portal's onboarding guide):
//     the person's right to connect this client is checked, then they're sent to Shopify to approve read-only access.
//   From Shopify (the app opened in the store admin, hmac signed): a store already connected goes to its client; one
//     that isn't is told to start from Kaizen OS, so a store is never filed under the wrong client.

const page = (title: string, text: string, status = 400) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1a1a1a"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!shopifyAppConfigured()) return page("Shopify isn't set up yet", "Kaizen OS's Shopify app keys aren't in place yet. Your Kaizen team will send a link once it is.", 503);
  if (!adminConfigured()) return page("Not set up", "Kaizen OS isn't set up here.", 503);
  const admin = createAdminClient();
  const shop = shopDomain(url.searchParams.get("shop"));
  const clientId = url.searchParams.get("client");

  // Opened from Shopify's side
  if (!clientId) {
    if (!shop || !validQueryHmac(url.searchParams, appSecret())) return page("Link expired", "Start from Kaizen OS: open the client's page (or your onboarding guide) and choose Connect Shopify.");
    const { data } = await admin.from("client_integrations").select("clients(slug)").eq("kind", "shopify").eq("account", shop).neq("status", "disconnected").limit(1).maybeSingle();
    const slug = (data?.clients as unknown as { slug?: string } | null)?.slug;
    if (slug) return Response.redirect(`${siteUrl()}/clients/${slug}#store`, 302);
    return page("Connect from Kaizen OS", "This store isn't linked to a Kaizen client yet. Your Kaizen team connects it from the client's page in Kaizen OS (or you can from your onboarding guide), so it lands on the right account.", 200);
  }

  if (!shop) return page("Check the store address", "The store address ends in .myshopify.com (Shopify admin › Settings › Domains).");
  const viewer = await getViewer();
  const may = await mayInstall(admin, viewer, clientId);
  if (!may.ok) return page("Not allowed", may.error, 403);
  const to = installUrl(shop, clientId, may.from);
  if (!to) return Response.redirect(backTo(may.from, may.slug, { shopify: "error", reason: "not_configured" }), 302);
  return Response.redirect(to, 302);
}
