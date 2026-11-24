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
export function installUrl(shopInput: string, clientId: string, from: "team" | "portal"): string | null {
  const shop = shopDomain(shopInput);
  const secret = appSecret();
  if (!shop || !secret) return null;
  const state = signState({ client: clientId, shop, from, nonce: randomBytes(9).toString("base64url"), exp: Date.now() + 30 * 60_000 }, secret);
  return authorizeUrl(shop, state, redirectUri());
}
