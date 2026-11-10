// The live connector catalog: Anthropic's MCP subregistry (the official MCP registry only when Anthropic's can't be
// reached), read page by page, remote servers only (streamable HTTP preferred, SSE otherwise), as rows keyed by the
// server's registry name. The plain parts, kept apart from the database so they can be tested: picking a remote,
// turning an item into a row, paging defensively, and what changed since the last pull.

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
};

const str = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown) => {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
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

const officialMeta = (m: Record<string, unknown> | undefined) => (m?.["io.modelcontextprotocol.registry/official"] ?? {}) as { status?: unknown; updatedAt?: unknown; publishedAt?: unknown; isLatest?: unknown };

/** A registry item as a row, or null when it isn't a remote server */
export function toEntry(item: RegistryItem): Entry | null {
  const s = item?.server;
  const name = str(s?.name, 300);
  if (!s || !name) return null;
  const remote = pickRemote(s.remotes);
  if (!remote) return null;
  const meta = officialMeta(item._meta);
  const status = str(meta.status, 40)?.toLowerCase() ?? "active";
  const icon = Array.isArray(s.icons) ? (s.icons as { src?: unknown }[]).map((i) => https(i?.src)).find(Boolean) ?? null : null;
  return {
    name,
    title: str(s.title, 120),
    description: str(s.description, 1000),
    url: remote.url,
    transport: remote.transport,
    version: str(s.version, 80),
    icon_url: icon,
    website_url: https(s.websiteUrl),
    status,
    available: status === "active" && meta.isLatest !== false,
    registry_updated_at: str(meta.updatedAt, 40),
    published_at: str(meta.publishedAt, 40),
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

/**
 * Every page of /servers (version=latest; updated_since when given), from a cursor when resuming. Stops at maxPages
 * (the cursor is kept to carry on next run), at a page that repeats its cursor, or at a failed page (what came before
 * is kept). The first page failing on Anthropic's registry falls back to the official one.
 */
export async function pullRegistry(p: { fetcher: Fetcher; since?: string | null; cursor?: string | null; maxPages?: number; limit?: number; bases?: string[] }): Promise<Pull> {
  const bases = p.bases ?? [ANTHROPIC_REGISTRY, OFFICIAL_REGISTRY];
  const maxPages = p.maxPages ?? 60;
  let lastError: string | null = null;
  for (const [i, base] of bases.entries()) {
    const items: RegistryItem[] = [];
    let cursor = i === 0 ? (p.cursor ?? null) : null;
    const seen = new Set<string>();
    let pages = 0;
    let failed: string | null = null;
    for (; pages < maxPages; ) {
      const u = new URL(`${base}/servers`);
      u.searchParams.set("version", "latest");
      u.searchParams.set("limit", String(p.limit ?? 100));
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
