// The app answers on three addresses (when they're set; locally and on preview deployments everything is one address):
//   app.    the team's app (NEXT_PUBLIC_SITE_URL)
//   portal. the client portal, /c/... (NEXT_PUBLIC_PORTAL_URL)
//   ads.    the old address: its pages move to app. or portal., but its /api/ and /auth/ keep answering, because Slack,
//           Meta, Google, TikTok, Motion, Resend, Loom, Zapier and the Kaizen AI connectors have it saved (INTEGRATIONS_URL)

const LEGACY = "https://ads.kaizenmarketing.agency";
const trim = (u: string) => u.replace(/\/$/, "");

/** Public address of the team's app, used in emails and links. */
export function siteUrl() {
  return trim(process.env.NEXT_PUBLIC_SITE_URL || LEGACY);
}

/** Public address of the client portal (falls back to the app's own address). */
export function portalUrl() {
  return trim(process.env.NEXT_PUBLIC_PORTAL_URL || siteUrl());
}

/** The address other services call back to and send webhooks to: kept on the old address so nothing needs re-pointing. */
export function integrationsUrl() {
  return trim(process.env.INTEGRATIONS_URL || LEGACY);
}

/**
 * The shared sign-in cookie's domain: every kaizenmarketing.agency address shares one sign in; elsewhere it's per host.
 * Only once the portal has its own address (the move to app. and portal.): switching scope while everyone is still on
 * ads. would leave two sign-in cookies side by side, and reusing the old one's refresh token can sign people out.
 */
export function cookieDomain(host: string | null | undefined, portal = process.env.NEXT_PUBLIC_PORTAL_URL) {
  if (!portal) return undefined;
  const h = (host ?? "").split(":")[0].toLowerCase();
  return h === "kaizenmarketing.agency" || h.endsWith(".kaizenmarketing.agency") ? ".kaizenmarketing.agency" : undefined;
}

/** Only allow redirects to paths inside the app (never to another site). */
export function safeNext(next: string | null | undefined, fallback = "/") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
