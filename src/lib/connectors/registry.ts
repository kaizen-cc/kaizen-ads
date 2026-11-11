// The live connector catalog: Anthropic's MCP subregistry first, and the official MCP registry whenever Anthropic's has
// nothing (or can't be reached), read page by page. Only remote servers (streamable HTTP preferred, SSE otherwise)
// published under a namespace the registry verified against a domain the publisher owns, which is close to the
// vendors' own connectors in Claude's directory. The well-known vendors are Featured and come first. The plain parts,
// kept apart from the database so they can be tested: picking a remote, deciding whose server it is, turning an item
// into a row, paging defensively, and what changed since the last pull.

export const ANTHROPIC_REGISTRY = "https://api.anthropic.com/mcp-registry/v0";
export const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io/v0.1";

export type RegistryItem = {
  server?: {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    version?: unknown;
    websiteUrl?: unknown;
    icons?: unknown;
    remotes?: unknown;
    packages?: unknown;
    _meta?: unknown;
  };
  _meta?: Record<string, unknown>;
};

export type Entry = {
  name: string;
  title: string | null;
  description: string | null;
  url: string;
  transport: "streamable-http" | "sse";
  version: string | null;
  icon_url: string | null;
  website_url: string | null;
  status: string;
  available: boolean;
  registry_updated_at: string | null;
  published_at: string | null;
  /** A well-known vendor's own server (sorted first, with a verified tick) */
  featured: boolean;
  /** That vendor's name ("Canva"), when featured */
  vendor: string | null;
};

const str = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown) => {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};

/**
 * The remote a client can call: streamable HTTP first, SSE otherwise; https only, and not a URL with {placeholders}
 * the person would have to fill in. Package-only servers (run locally) have none.
 */
export function pickRemote(remotes: unknown): { url: string; transport: "streamable-http" | "sse" } | null {
  if (!Array.isArray(remotes)) return null;
  const ok = remotes.flatMap((r) => {
    const x = r as { type?: unknown; url?: unknown };
    const type = String(x?.type ?? "").toLowerCase();
    const transport = type === "streamable-http" || type === "streamable_http" || type === "http" ? "streamable-http" : type === "sse" ? "sse" : null;
    const url = typeof x?.url === "string" && !/[{}]/.test(x.url) ? https(x.url) : null;
    return transport && url ? [{ url, transport: transport as "streamable-http" | "sse" }] : [];
  });
  return ok.find((r) => r.transport === "streamable-http") ?? ok[0] ?? null;
}

// ─── Whose server it is ────────────────────────────────────────────────────

/**
 * Namespaces anyone can publish under without owning a domain: GitHub and GitLab accounts, and shared hosts where
 * anyone gets a subdomain (Vercel, Netlify, Cloudflare Workers and Pages, Render, Fly, Smithery's gateway, tunnels...).
 * A name under one of these is someone's own project, not the vendor's.
 */
export const UNVERIFIED_NAMESPACES = [
  "io.github",
  "io.gitlab",
  "app.vercel",
  "app.netlify",
  "dev.workers",
  "dev.pages",
  "com.trycloudflare",
  "com.onrender",
  "dev.fly",
  "app.fly",
  "com.herokuapp",
  "app.run",
  "app.web",
  "com.firebaseapp",
  "app.railway",
  "dev.replit",
  "app.replit",
  "co.repl",
  "app.lovable",
  "ai.smithery",
  "live.alpic",
  "site.chatgpt",
  "io.sslip",
  "io.nip",
  "org.duckdns",
  "sh.surge",
  "com.pythonanywhere",
  "net.ts",
  "app.ngrok",
  "app.ngrok-free",
  "dev.ngrok",
  "io.ngrok",
  "space.hf",
  "co.supabase",
  "run.modal",
  "dev.deno",
  "net.azurewebsites",
  "com.amazonaws",
  "app.koyeb",
  "me.glitch",
  "actor.apify",
];

/** The namespace of a registry name ("com.canva.mcp/mcp" → "com.canva.mcp"), lowercased */
export const namespaceOf = (name: string) => String(name ?? "").split("/")[0].toLowerCase();

/** The domain a reverse-DNS namespace stands for ("com.canva.mcp" → "mcp.canva.com"), or null when it isn't one */
export function domainOf(namespace: string): string | null {
  const labels = namespace.toLowerCase().split(".");
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (!/^[a-z]{2,}$/.test(labels[0])) return null; // the TLD comes first
  return labels.reverse().join(".");
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The well-known vendors, like the ones in Claude's directory: Featured when the server is published under one of the
 * vendor's domains (or the vendor's own GitHub organization, for the few that publish there) and runs on that domain.
 */
export const VENDORS: { name: string; domains: string[]; github?: string[] }[] = [
  { name: "Adobe", domains: ["adobe.com", "adobe.io"], github: ["adobe"] },
  { name: "Ahrefs", domains: ["ahrefs.com"] },
  { name: "Airtable", domains: ["airtable.com"] },
  { name: "Amplitude", domains: ["amplitude.com"] },
  { name: "Asana", domains: ["asana.com"] },
  { name: "Atlassian", domains: ["atlassian.com", "atlassian.net"] },
  { name: "Bitly", domains: ["bitly.com"] },
  { name: "Canva", domains: ["canva.com"] },
  { name: "Cloudflare", domains: ["cloudflare.com"] },
  { name: "Datadog", domains: ["datadoghq.com", "datadoghq.eu"], github: ["datadog"] },
  { name: "Figma", domains: ["figma.com"] },
  { name: "Fireflies", domains: ["fireflies.ai"] },
  { name: "GitHub", domains: ["github.com", "githubcopilot.com"], github: ["github"] },
  { name: "GitLab", domains: ["gitlab.com"] },
  { name: "Google", domains: ["google.com", "googleapis.com"] },
  { name: "HubSpot", domains: ["hubspot.com"], github: ["hubspot", "hubspotdev"] },
  { name: "Intuit QuickBooks", domains: ["intuit.com", "quickbooks.com"] },
  { name: "Klaviyo", domains: ["klaviyo.com"], github: ["klaviyo"] },
  { name: "Linear", domains: ["linear.app"] },
  { name: "Microsoft", domains: ["microsoft.com", "cloud.microsoft"], github: ["microsoft"] },
  { name: "Miro", domains: ["miro.com"], github: ["miroapp"] },
  { name: "monday.com", domains: ["monday.com"] },
  { name: "Notion", domains: ["notion.so", "notion.com"], github: ["makenotion"] },
  { name: "PayPal", domains: ["paypal.com"] },
  { name: "Sentry", domains: ["sentry.io", "sentry.dev"], github: ["getsentry"] },
  { name: "Shopify", domains: ["shopify.com", "shopify.dev"], github: ["shopify"] },
  { name: "Slack", domains: ["slack.com"], github: ["slackapi"] },
  { name: "Square", domains: ["squareup.com", "square.com"], github: ["square"] },
  { name: "Stripe", domains: ["stripe.com"] },
  { name: "Todoist", domains: ["todoist.com", "todoist.net"], github: ["doist"] },
  { name: "Webflow", domains: ["webflow.com"] },
  { name: "Windsor.ai", domains: ["windsor.ai"] },
  { name: "Wix", domains: ["wix.com"] },
  { name: "Zapier", domains: ["zapier.com"] },
  { name: "Zoom", domains: ["zoom.us"], github: ["zoom"] },
];

/** The vendor whose own GitHub organization this is (io.github.zoom → Zoom) */
const githubVendor = (namespace: string) => {
  const m = /^io\.github\.([a-z0-9-]+)$/.exec(namespace);
  return m ? (VENDORS.find((v) => v.github?.includes(m[1])) ?? null) : null;
};

/**
 * Is this a server we list? Published under a domain the registry verified (not a GitHub account or a shared host),
 * or under a well-known vendor's own GitHub organization with its server on the vendor's domain.
 */
export function verifiedPublisher(name: string, url: string): boolean {
  const ns = namespaceOf(name);
  const gv = githubVendor(ns);
  if (gv) return gv.domains.some((d) => under(hostOf(url), d));
  if (!domainOf(ns)) return false;
  return !UNVERIFIED_NAMESPACES.some((p) => ns === p || ns.startsWith(`${p}.`));
}

/** The well-known vendor whose own server this is (published under their domain and running on it), or null */
export function featuredVendor(name: string, url: string): string | null {
  const ns = namespaceOf(name);
  const host = hostOf(url);
  const gv = githubVendor(ns);
  if (gv) return gv.domains.some((d) => under(host, d)) ? gv.name : null;
  const domain = domainOf(ns);
  if (!domain || !verifiedPublisher(name, url)) return null;
  const v = VENDORS.find((x) => x.domains.some((d) => under(domain, d)));
  return v && v.domains.some((d) => under(host, d)) ? v.name : null;
}

// ─── Names and icons ───────────────────────────────────────────────────────

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ltd", "plc", "ne", "or", "go"]);

/** The site a host belongs to, for its favicon ("mcp.canva.com" → "canva.com", "x.co.uk" → "x.co.uk") */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const n = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** A favicon for a domain, through Google's favicon service (an image URL that never runs the site's own code) */
export const faviconFor = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

/** A favicon for a server URL's site */
export const faviconForUrl = (url: string) => {
  const h = hostOf(url);
  return h ? faviconFor(siteOf(h)) : null;
};

/** The registry's own icon: server.icons (a light or theme-less one first), else the publisher's _meta (icon or logo) */
export function iconOf(server: RegistryItem["server"]): string | null {
  if (!server) return null;
  if (Array.isArray(server.icons)) {
    const icons = server.icons as { src?: unknown; theme?: unknown }[];
    const ordered = [...icons.filter((i) => i?.theme !== "dark"), ...icons.filter((i) => i?.theme === "dark")];
    const hit = ordered.map((i) => https(i?.src)).find(Boolean);
    if (hit) return hit;
  }
  const meta = (server._meta && typeof server._meta === "object" ? (server._meta as Record<string, unknown>)["io.modelcontextprotocol.registry/publisher-provided"] : null) as Record<string, unknown> | null;
  if (meta && typeof meta === "object") for (const k of ["icon", "iconUrl", "icon_url", "logo", "logoUrl", "logo_url"]) if (https(meta[k])) return https(meta[k]);
  return null;
}

const GENERIC = new Set(["mcp", "server", "remote", "api", "official"]);
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** A readable name when the registry gives no title: the vendor's for its main server, else the name's last part */
export function displayTitle(name: string, vendor: string | null): string {
  const last = String(name ?? "").split("/").pop() ?? "";
  const words = last.split(/[-_.\s]+/).filter((w) => w && !GENERIC.has(w.toLowerCase()));
  const domain = domainOf(namespaceOf(name));
  const v = vendor ? VENDORS.find((x) => x.name === vendor) : null;
  const isVendor = (w: string) => Boolean(v && v.domains.some((d) => d.split(".")[0] === w.toLowerCase()));
  if (!words.length) {
    // The part of the domain in front of the site says which product it is (compute.googleapis.com → "Compute")
    const product = domain ? domain.slice(0, -siteOf(domain).length).split(".").filter((l) => l && !GENERIC.has(l)).shift() : undefined;
    const base = vendor ?? cap(domain ? siteOf(domain).split(".")[0] : last || name);
    return product ? `${base} ${cap(product)}` : base;
  }
  if (vendor && words.length <= 2 && isVendor(words[0]) && (words.length === 1 || /^(com|app|ai|io)$/i.test(words[1]))) return vendor;
  return words.map(cap).join(" ").slice(0, 120);
}

/** A registry title without the protocol talk Claude's directory leaves out ("Figma MCP Server" → "Figma") */
export function cleanTitle(title: string | null): string | null {
  if (!title) return null;
  const t = title
    .replace(/^(the\s+)?(remote\s+)?mcp\s+server\s+(for|of)\s+/i, "")
    .replace(/[\s:|-]*\(?(official\s+)?(remote\s+)?mcp(\s+server)?\)?$/i, "")
    .trim();
  return t || title;
}

const officialMeta = (m: Record<string, unknown> | undefined) => (m?.["io.modelcontextprotocol.registry/official"] ?? {}) as { status?: unknown; updatedAt?: unknown; publishedAt?: unknown; isLatest?: unknown };

/** A registry item as a row, or null when it isn't a remote server from a verified publisher */
export function toEntry(item: RegistryItem): Entry | null {
  const s = item?.server;
  const name = str(s?.name, 300);
  if (!s || !name) return null;
  const remote = pickRemote(s.remotes);
  if (!remote) return null;
  if (!verifiedPublisher(name, remote.url)) return null;
  const meta = officialMeta(item._meta);
  const status = str(meta.status, 40)?.toLowerCase() ?? "active";
  const vendor = featuredVendor(name, remote.url);
  const v = vendor ? VENDORS.find((x) => x.name === vendor) : null;
  const ns = domainOf(namespaceOf(name));
  return {
    name,
    title: cleanTitle(str(s.title, 120)) ?? displayTitle(name, vendor),
    description: str(s.description, 1000),
    url: remote.url,
    transport: remote.transport,
    version: str(s.version, 80),
    icon_url: iconOf(s) ?? (v ? faviconFor(v.domains[0]) : ns ? faviconFor(siteOf(ns)) : faviconForUrl(remote.url)),
    website_url: https(s.websiteUrl),
    status,
    available: status === "active" && meta.isLatest !== false,
    registry_updated_at: str(meta.updatedAt, 40),
    published_at: str(meta.publishedAt, 40),
    featured: Boolean(vendor),
    vendor,
  };
}

/** Registry names of items that are no longer remote servers (their latest version dropped its remotes) */
export const nonRemoteNames = (items: RegistryItem[]) => items.flatMap((i) => (i?.server && str(i.server.name, 300) && !pickRemote(i.server.remotes) ? [str(i.server.name, 300)!] : []));

// ─── Paging ────────────────────────────────────────────────────────────────

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type Page = { servers: RegistryItem[]; metadata?: { nextCursor?: unknown; next_cursor?: unknown } };

async function readPage(fetcher: Fetcher, url: string): Promise<Page> {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`The registry answered ${r.status}.`);
  const body = (await r.json()) as Partial<Page> | null;
  if (!body || !Array.isArray(body.servers)) throw new Error("The registry's answer had no server list.");
  return body as Page;
}

export type Pull = { source: string; items: RegistryItem[]; cursor: string | null; complete: boolean; pages: number; error: string | null };

/** The registry's largest page */
export const PAGE_SIZE = 100;

/**
 * Every page of /servers (version=latest; updated_since when given), from a cursor when resuming. Stops at maxPages
 * or the deadline (the cursor is kept to carry on), at a page that repeats its cursor, or at a failed page (what came
 * before is kept). The first page failing on one registry moves on to the next one in `bases`.
 */
export async function pullRegistry(p: { fetcher: Fetcher; since?: string | null; cursor?: string | null; maxPages?: number; limit?: number; bases?: string[]; deadline?: number; now?: () => number }): Promise<Pull> {
  const bases = p.bases ?? [ANTHROPIC_REGISTRY, OFFICIAL_REGISTRY];
  const maxPages = p.maxPages ?? 60;
  const clock = p.now ?? Date.now;
  let lastError: string | null = null;
  for (const [i, base] of bases.entries()) {
    const items: RegistryItem[] = [];
    let cursor = i === 0 ? (p.cursor ?? null) : null;
    const seen = new Set<string>();
    let pages = 0;
    let failed: string | null = null;
    for (; pages < maxPages; ) {
      if (pages > 0 && p.deadline && clock() >= p.deadline) break;
      const u = new URL(`${base}/servers`);
      u.searchParams.set("version", "latest");
      u.searchParams.set("limit", String(Math.min(p.limit ?? PAGE_SIZE, PAGE_SIZE)));
      if (p.since) u.searchParams.set("updated_since", p.since);
      if (cursor) u.searchParams.set("cursor", cursor);
      let body: Page;
      try {
        body = await readPage(p.fetcher, u.toString());
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
        break;
      }
      pages++;
      items.push(...body.servers);
      const next = str(body.metadata?.nextCursor ?? body.metadata?.next_cursor, 2000);
      if (!next || seen.has(next)) {
        cursor = null;
        break;
      }
      seen.add(next);
      cursor = next;
    }
    // Unreachable from the first page: the next registry. Failing later keeps what came in and resumes next run.
    if (failed && pages === 0) {
      lastError = `${base}: ${failed}`;
      continue;
    }
    return { source: base, items, cursor, complete: !cursor && !failed, pages, error: failed };
  }
  return { source: bases[0], items: [], cursor: null, complete: false, pages: 0, error: lastError ?? "No registry answered." };
}

// ─── What changed ──────────────────────────────────────────────────────────

export type Known = { name: string; url: string; version: string | null; status: string; available: boolean };

export type Change = { name: string; isNew: boolean; urlChanged: boolean; versionChanged: boolean; statusChanged: boolean };

/** Each incoming row against what's stored: new, or what changed (a row with nothing changed is left out) */
export function changes(incoming: Entry[], known: Known[]): Change[] {
  const by = new Map(known.map((k) => [k.name, k]));
  return incoming.flatMap((e) => {
    const k = by.get(e.name);
    if (!k) return [{ name: e.name, isNew: true, urlChanged: false, versionChanged: false, statusChanged: false }];
    const c = { name: e.name, isNew: false, urlChanged: k.url !== e.url, versionChanged: (k.version ?? null) !== (e.version ?? null), statusChanged: k.status !== e.status || k.available !== e.available };
    return c.urlChanged || c.versionChanged || c.statusChanged ? [c] : [];
  });
}

/** The newest entry per name (a page may hold more than one version when version=latest isn't honored) */
export function latestByName(entries: Entry[]): Entry[] {
  const out = new Map<string, Entry>();
  for (const e of entries) {
    const was = out.get(e.name);
    if (!was || (e.registry_updated_at ?? "") >= (was.registry_updated_at ?? "")) out.set(e.name, e);
  }
  return [...out.values()];
}

/** Where the next pull starts: from the last finished one, an hour back so nothing on the edge is missed */
export const sinceFrom = (lastComplete: string | null) => (lastComplete ? new Date(Date.parse(lastComplete) - 3600_000).toISOString() : null);

/** One bell notice a week at most, and none for the very first pull (everything would be new) */
export function weeklyNoticeDue(lastNoticeAt: string | null, firstPullDone: boolean, now = Date.now()) {
  if (!firstPullDone) return false;
  return !lastNoticeAt || now - Date.parse(lastNoticeAt) >= 7 * 86_400_000;
}

/** Featured first (by vendor, then name), then the rest in the order they came */
export function directoryOrder<T extends { featured?: boolean | null; vendor?: string | null; title?: string | null; name: string }>(rows: T[]): T[] {
  const f = rows.filter((r) => r.featured).sort((a, b) => (a.vendor ?? "").localeCompare(b.vendor ?? "") || (a.title ?? a.name).localeCompare(b.title ?? b.name));
  return [...f, ...rows.filter((r) => !r.featured)];
}
