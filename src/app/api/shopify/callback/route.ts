import { after } from "next/server";
import { appSecret, exchangeCode, shopifyAppConfigured } from "@/lib/shopify/api";
import { readState, shopDomain, validQueryHmac } from "@/lib/shopify/core";
import { backTo } from "@/lib/shopify/oauth";
import { siteUrl } from "@/lib/site";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Back from Shopify after the merchant approved: Shopify's signature and our signed state are checked (the store must be
// the one the install started for), the code is swapped for the store's offline token, the store is saved under that
// client, and its full history starts reading right away (then every 10 minutes until it reaches the first order).

export const maxDuration = 300;

export async function GET(request: Request) {
  const url = new URL(request.url);
  let back = (params: Record<string, string>) => `${siteUrl()}/clients?${new URLSearchParams(params)}`;
  const fail = (reason: string) => Response.redirect(back({ shopify: "error", reason }), 302);
  if (!shopifyAppConfigured() || !adminConfigured()) return fail("not_configured");
  const secret = appSecret();
  const state = readState(url.searchParams.get("state"), secret);
  if (!state) return fail("expired");
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("slug").eq("id", state.client).maybeSingle();
  if (!client) return fail("client");
  back = (params) => backTo(state.from, client.slug as string, params);
  const shop = shopDomain(url.searchParams.get("shop"));
  if (!validQueryHmac(url.searchParams, secret) || !shop || shop !== state.shop) return fail("signature");
  const code = url.searchParams.get("code");
  if (!code) return fail(url.searchParams.get("error") ?? "denied");
  try {
    const tokens = await exchangeCode(shop, code);
    const { connectShopify, syncShopify } = await import("@/lib/shopify/store");
    const r = await connectShopify(admin, state.client, { shop, tokens, auth: "oauth", by: null });
    if (!r.ok) return fail(r.error.slice(0, 120));
    const { tellShopifyConnected } = await import("@/lib/shopify/notify");
    after(async () => {
      await tellShopifyConnected(admin, state.client, r.name, state.from).catch(() => undefined);
      await syncShopify(admin, r.id, Date.now() + 240_000).catch(() => undefined);
    });
    return Response.redirect(back({ shopify: "connected" }), 302);
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 80) : "exchange_failed");
  }
}
