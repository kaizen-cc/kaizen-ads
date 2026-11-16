// Which address a request belongs on (see site.ts): the proxy asks this before anything else. Pure, so it's tested.

export type Hosts = { app: string | null; portal: string | null; legacy: string | null };

const hostOf = (u: string | undefined) => {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

export function hostsFrom(env: Record<string, string | undefined> = process.env): Hosts {
  const app = hostOf(env.NEXT_PUBLIC_SITE_URL);
  const portal = hostOf(env.NEXT_PUBLIC_PORTAL_URL);
  const legacy = hostOf(env.INTEGRATIONS_URL || "https://ads.kaizenmarketing.agency");
  // ads. only becomes "legacy" once the app has moved off it
  return { app, portal: portal && portal !== app ? portal : null, legacy: legacy && legacy !== app && legacy !== portal ? legacy : null };
}

const under = (path: string, ...prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));

/** The portal's own pages (and what a client needs around them: sign in, report links, the legal pages) */
const PORTAL_PATHS = ["/c", "/login", "/auth", "/api", "/r", "/p", "/report", "/about", "/privacy", "/terms", "/manifest.webmanifest", "/handled"];

/** OAuth flows started from the app: they run on the integrations address, the one each service has registered */
const CONNECT_PATHS = ["/api/slack/connect", "/api/motion/connect", "/api/tiktok/connect", "/api/connectors/connect"];

/**
 * Where to send this request instead, or null to serve it here. Only the known addresses are ever redirected:
 * localhost and preview deployments are left alone.
 */
export function hostRedirect(host: string | null, path: string, hosts: Hosts): { to: string; status: 307 | 308 } | null {
  const h = (host ?? "").toLowerCase();
  if (!h) return null;
  const at = (target: string | null) => (target ? `https://${target}` : null);

  if (hosts.legacy && h === hosts.legacy) {
    // Webhooks, OAuth callbacks and sign-in links keep answering on the old address
    if (under(path, "/api", "/auth")) return null;
    const to = under(path, "/c") && hosts.portal ? at(hosts.portal) : at(hosts.app);
    return to ? { to, status: 308 } : null;
  }

  if (hosts.app && h === hosts.app) {
    if (hosts.portal && under(path, "/c")) return { to: at(hosts.portal)!, status: 308 };
    if (hosts.legacy && under(path, ...CONNECT_PATHS)) return { to: at(hosts.legacy)!, status: 307 };
    return null;
  }

  if (hosts.portal && h === hosts.portal) {
    if (path === "/" || under(path, ...PORTAL_PATHS)) return null;
    return hosts.app ? { to: at(hosts.app)!, status: 308 } : null;
  }

  return null;
}
