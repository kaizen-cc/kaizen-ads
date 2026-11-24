import { appSecret } from "@/lib/shopify/api";
import { shopDomain, validWebhookHmac } from "@/lib/shopify/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Shopify's webhooks for the Kaizen OS app (one address for every topic, set in the app's configuration):
//   app/uninstalled                the token is deleted and the store shows as disconnected (what was read stays)
//   customers/data_request         we keep no customer records (only daily totals), so there's nothing to send
//   customers/redact               nothing per customer to erase, same reason
//   shop/redact                    48 hours after an uninstall: everything read from the store is erased (eraseStore),
//                                  as the privacy policy (src/app/(legal)/privacy) promises
// Every call is checked against the app secret first.

export async function POST(request: Request) {
  const raw = await request.text();
  if (!validWebhookHmac(raw, request.headers.get("x-shopify-hmac-sha256"), appSecret())) return new Response("unauthorized", { status: 401 });
  const topic = (request.headers.get("x-shopify-topic") ?? "").toLowerCase();
  const shop = shopDomain(request.headers.get("x-shopify-shop-domain"));
  if (!shop || !adminConfigured()) return new Response("ok");
  const admin = createAdminClient();
  if (topic === "app/uninstalled") await (await import("@/lib/shopify/store")).storeUninstalled(admin, shop);
  if (topic === "shop/redact") await (await import("@/lib/shopify/store")).eraseStore(admin, shop);
  return new Response("ok");
}
