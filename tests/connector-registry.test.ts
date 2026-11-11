import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { authFromProbe, uniqueKey, usable } from "@/lib/connectors/shared";
import {
  ANTHROPIC_REGISTRY,
  changes,
  cleanTitle,
  directoryOrder,
  displayTitle,
  domainOf,
  faviconFor,
  featuredVendor,
  iconOf,
  latestByName,
  OFFICIAL_REGISTRY,
  pickRemote,
  pullRegistry,
  siteOf,
  toEntry,
  verifiedPublisher,
  weeklyNoticeDue,
  type Entry,
  type Fetcher,
  type RegistryItem,
} from "@/lib/connectors/registry";
import { syncConnectorRegistry } from "@/lib/connectors/registry-sync";

const item = (name: string, remotes: unknown, extra: Partial<{ version: string; status: string; updatedAt: string; title: string; icons: unknown }> = {}): RegistryItem => ({
  server: { name, title: extra.title ?? name.split("/").pop(), description: `${name} server`, version: extra.version ?? "1.0.0", remotes, ...(extra.icons ? { icons: extra.icons } : {}) },
  _meta: { "io.modelcontextprotocol.registry/official": { status: extra.status ?? "active", updatedAt: extra.updatedAt ?? "2026-11-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z", isLatest: true } },
});
const http = (url: string) => [{ type: "streamable-http", url }];

/** A registry served from pages: base → cursor → { servers, next } (or an HTTP status) */
function fakeRegistry(pages: Record<string, Record<string, { servers: RegistryItem[]; next?: string } | number>>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const base = Object.keys(pages).find((b) => url.startsWith(b));
    if (!base) throw new Error("ENOTFOUND");
    const page = pages[base][u.searchParams.get("cursor") ?? ""];
    if (page === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof page === "number") return { ok: false, status: page, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ servers: page.servers, metadata: { count: page.servers.length, ...(page.next ? { nextCursor: page.next } : {}) } }) };
  };
  return { fetcher, calls };
}

describe("remote filtering", () => {
  it("prefers streamable HTTP, takes SSE otherwise, and skips package-only servers", () => {
    expect(pickRemote([{ type: "sse", url: "https://a.example/sse" }, { type: "streamable-http", url: "https://a.example/mcp" }])).toEqual({ url: "https://a.example/mcp", transport: "streamable-http" });
    expect(pickRemote([{ type: "sse", url: "https://a.example/sse" }])).toEqual({ url: "https://a.example/sse", transport: "sse" });
    expect(pickRemote(undefined)).toBeNull();
    expect(pickRemote([{ type: "streamable-http", url: "http://a.example/mcp" }])).toBeNull();
    expect(pickRemote([{ type: "streamable-http", url: "https://{tenant}.example/mcp" }])).toBeNull();
    expect(toEntry({ server: { name: "com.example/pkg", packages: [{ registryType: "npm" }] } })).toBeNull();
  });
  it("marks a server that isn't active as unavailable", () => {
    expect(toEntry(item("com.example/b", http("https://a.example/mcp")))?.available).toBe(true);
    expect(toEntry(item("com.example/b", http("https://a.example/mcp"), { status: "deprecated" }))).toMatchObject({ available: false, status: "deprecated" });
  });
});

describe("namespace filtering", () => {
  it("reads a reverse-DNS namespace as its domain", () => {
    expect(domainOf("com.canva.mcp")).toBe("mcp.canva.com");
    expect(domainOf("uk.co.example")).toBe("example.co.uk");
    expect(domainOf("example")).toBeNull();
    expect(domainOf("com.exa mple")).toBeNull();
  });
  it("keeps servers under a verified domain and drops GitHub accounts and shared hosts", () => {
    expect(verifiedPublisher("com.canva.mcp/mcp", "https://mcp.canva.com/mcp")).toBe(true);
    expect(verifiedPublisher("ac.mizan/registry", "https://mizan.ac/mcp")).toBe(true);
    expect(verifiedPublisher("io.github.someone/tool", "https://tool.example/mcp")).toBe(false);
    expect(verifiedPublisher("io.gitlab.someone/tool", "https://tool.example/mcp")).toBe(false);
    expect(verifiedPublisher("app.vercel.stripecheckup/stripecheckup", "https://stripecheckup.vercel.app/api/mcp")).toBe(false);
    expect(verifiedPublisher("dev.workers.someone/x", "https://x.someone.workers.dev/mcp")).toBe(false);
    expect(verifiedPublisher("ai.smithery/someone-dropbox", "https://server.smithery.ai/@someone/dropbox/mcp")).toBe(false);
    expect(verifiedPublisher("com.trycloudflare.abc-def/x", "https://abc-def.trycloudflare.com/mcp")).toBe(false);
    expect(verifiedPublisher("plain/name", "https://plain.example/mcp")).toBe(false);
  });
  it("lets a vendor's own GitHub organization in only with its server on the vendor's domain", () => {
    expect(verifiedPublisher("io.github.zoom/zoom-meetings", "https://mcp.zoom.us/mcp/meeting/streamable")).toBe(true);
    expect(verifiedPublisher("io.github.zoom/zoom-meetings", "https://zoom-meetings.example.com/mcp")).toBe(false);
    expect(toEntry(item("io.github.someone/zoom", http("https://mcp.zoom.us/mcp")))).toBeNull();
  });
  it("drops what isn't verified when turning items into rows", () => {
    const rows = [item("com.notion/mcp", http("https://mcp.notion.com/mcp")), item("io.github.x/notion", http("https://notion.x.dev/mcp")), item("app.netlify.y/z", http("https://y.netlify.app/mcp"))].map(toEntry).filter(Boolean);
    expect(rows.map((r) => r!.name)).toEqual(["com.notion/mcp"]);
  });
});

describe("featured vendors", () => {
  it("features a well-known vendor's own server, on its own domain", () => {
    expect(featuredVendor("com.monday/monday.com", "https://mcp.monday.com/mcp")).toBe("monday.com");
    expect(featuredVendor("com.canva.mcp/mcp", "https://mcp.canva.com/mcp")).toBe("Canva");
    expect(featuredVendor("net.todoist/mcp", "https://ai.todoist.net/mcp")).toBe("Todoist");
    expect(featuredVendor("io.github.getsentry/sentry-mcp", "https://mcp.sentry.dev/mcp")).toBe("Sentry");
    expect(featuredVendor("ai.windsor/windsor-mcp", "https://mcp.windsor.ai/sse")).toBe("Windsor.ai");
  });
  it("doesn't feature lookalikes, other hosts or third-party wrappers", () => {
    expect(featuredVendor("com.canvas64/wall", "https://canvas64.com/api/mcp")).toBeNull();
    expect(featuredVendor("com.stripe/mcp", "https://stripe-mcp.example.com/mcp")).toBeNull();
    expect(featuredVendor("com.insightfulpipe/klaviyo", "https://klaviyo.insightfulmcp.com/")).toBeNull();
    expect(featuredVendor("app.vercel.stripecheckup/stripecheckup", "https://stripecheckup.vercel.app/api/mcp")).toBeNull();
    expect(featuredVendor("io.github.someone/monday", "https://mcp.monday.com/mcp")).toBeNull();
  });
  it("marks the row and sorts featured first, by vendor", () => {
    const e = toEntry(item("com.zapier/mcp", http("https://mcp.zapier.com/api/v1/connect"), { title: "Zapier" }))!;
    expect(e).toMatchObject({ featured: true, vendor: "Zapier" });
    const rows = [
      { name: "b/x", featured: false, vendor: null, title: "B" },
      { name: "z/z", featured: true, vendor: "Zoom", title: "Zoom" },
      { name: "a/a", featured: true, vendor: "Asana", title: "Asana" },
    ];
    expect(directoryOrder(rows).map((r) => r.name)).toEqual(["a/a", "z/z", "b/x"]);
  });
});

describe("names and icons", () => {
  it("prefers the registry's light icon, then the publisher's logo, then the site's favicon", () => {
    expect(iconOf({ icons: [{ src: "https://x.example/dark.png", theme: "dark" }, { src: "https://x.example/light.png", theme: "light" }] })).toBe("https://x.example/light.png");
    expect(iconOf({ icons: [{ src: "http://x.example/insecure.png" }] })).toBeNull();
    expect(iconOf({ _meta: { "io.modelcontextprotocol.registry/publisher-provided": { logoUrl: "https://x.example/logo.png" } } })).toBe("https://x.example/logo.png");
    expect(toEntry(item("com.canva.mcp/mcp", http("https://mcp.canva.com/mcp")))?.icon_url).toBe(faviconFor("canva.com"));
    expect(toEntry(item("ac.mizan/registry", http("https://mizan.ac/mcp")))?.icon_url).toBe(faviconFor("mizan.ac"));
    expect(siteOf("mcp.canva.com")).toBe("canva.com");
    expect(siteOf("shop.example.co.uk")).toBe("example.co.uk");
  });
  it("names a server with no title, and drops the protocol talk from titles", () => {
    expect(displayTitle("com.monday/monday.com", "monday.com")).toBe("monday.com");
    expect(displayTitle("com.canva.mcp/mcp", "Canva")).toBe("Canva");
    expect(displayTitle("io.github.zoom/zoom-team-chat", "Zoom")).toBe("Zoom Team Chat");
    expect(displayTitle("com.googleapis.compute/mcp", "Google")).toBe("Google Compute");
    expect(cleanTitle("Figma MCP Server")).toBe("Figma");
    expect(cleanTitle("Canva MCP")).toBe("Canva");
    expect(cleanTitle("MCP")).toBe("MCP");
  });
});

describe("custom connectors", () => {
  it("derives a key from the name that no other connector uses", () => {
    expect(uniqueKey("Google Drive", [])).toBe("google-drive");
    expect(uniqueKey("Google Drive", ["google-drive", "google-drive-2"])).toBe("google-drive-3");
    expect(uniqueKey("9 Lives", [])).toBe("c-9-lives");
    expect(uniqueKey("X", [])).toBe("c-x");
    expect(uniqueKey("", [])).toBe("connector");
  });
  it("decides how people sign in from what the server says", () => {
    expect(authFromProbe({ reachable: false, signIn: false, dcr: false, meta: null })).toBeNull();
    expect(authFromProbe({ reachable: true, signIn: false, dcr: false, meta: null })).toBe("none");
    expect(authFromProbe({ reachable: true, signIn: true, dcr: true, meta: {} })).toBe("oauth");
    expect(authFromProbe({ reachable: true, signIn: true, dcr: false, meta: {} })).toBe("oauth_client");
    expect(authFromProbe({ reachable: true, signIn: true, dcr: false, meta: null })).toBe("token");
  });
  it("a no-sign-in connector is usable once the person switched it on", () => {
    expect(usable({ id: "c", auth: "none" }, [])).toBe(false);
    expect(usable({ id: "c", auth: "none" }, [{ connector_id: "c", status: "active" }])).toBe(true);
    expect(usable({ id: "c", auth: "oauth" }, [{ connector_id: "c", status: "needs_reconnect" }])).toBe(false);
  });
});

describe("paging", () => {
  const A = "https://anthropic.test/v0";
  const O = "https://official.test/v0.1";
  it("follows the cursor to the end, with version=latest, updated_since and the largest page", async () => {
    const { fetcher, calls } = fakeRegistry({ [A]: { "": { servers: [item("com.a/1", http("https://1.example"))], next: "c1" }, c1: { servers: [item("com.a/2", http("https://2.example"))] } } });
    const p = await pullRegistry({ fetcher, bases: [A, O], since: "2026-11-01T00:00:00.000Z", limit: 500 });
    expect(p).toMatchObject({ source: A, complete: true, pages: 2, cursor: null, error: null });
    expect(p.items).toHaveLength(2);
    expect(new URL(calls[0]).searchParams.get("version")).toBe("latest");
    expect(new URL(calls[0]).searchParams.get("limit")).toBe("100");
    expect(new URL(calls[0]).searchParams.get("updated_since")).toBe("2026-11-01T00:00:00.000Z");
    expect(new URL(calls[1]).searchParams.get("cursor")).toBe("c1");
  });
  it("stops at the page limit and keeps the cursor to carry on", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [], next: "c1" }, c1: { servers: [], next: "c2" }, c2: { servers: [] } } });
    const p = await pullRegistry({ fetcher, bases: [A], maxPages: 2 });
    expect(p).toMatchObject({ complete: false, cursor: "c2", pages: 2 });
    const rest = await pullRegistry({ fetcher, bases: [A], cursor: p.cursor });
    expect(rest).toMatchObject({ complete: true, pages: 1 });
  });
  it("stops at the deadline after at least one page, keeping the cursor", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [], next: "c1" }, c1: { servers: [], next: "c2" }, c2: { servers: [] } } });
    const p = await pullRegistry({ fetcher, bases: [A], deadline: 5, now: () => 10 });
    expect(p).toMatchObject({ complete: false, cursor: "c1", pages: 1 });
  });
  it("stops on a cursor that repeats", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [], next: "c1" }, c1: { servers: [], next: "c1" } } });
    expect(await pullRegistry({ fetcher, bases: [A] })).toMatchObject({ complete: true, pages: 2 });
  });
  it("moves on to the next registry when the first can't be reached", async () => {
    const down = fakeRegistry({ [O]: { "": { servers: [item("com.o/1", http("https://o.example"))] } } });
    expect(await pullRegistry({ fetcher: down.fetcher, bases: [A, O] })).toMatchObject({ source: O, complete: true });
  });
  it("keeps what came in when a later page fails", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [item("com.a/1", http("https://1.example"))], next: "c1" }, c1: 503 } });
    const p = await pullRegistry({ fetcher, bases: [A, O] });
    expect(p).toMatchObject({ source: A, complete: false, cursor: "c1", pages: 1 });
    expect(p.error).toContain("503");
  });
});

describe("change detection", () => {
  const e = (name: string, url: string, version: string, status = "active"): Entry => ({ ...toEntry(item(name, http(url), { version, status }))! });
  it("finds new servers and changed URLs, versions and status, and nothing else", () => {
    const known = [
      { name: "com.a/same", url: "https://same.example/", version: "1", status: "active", available: true },
      { name: "com.a/moved", url: "https://old.example/", version: "1", status: "active", available: true },
      { name: "com.a/bumped", url: "https://b.example/", version: "1", status: "active", available: true },
      { name: "com.a/gone", url: "https://g.example/", version: "1", status: "active", available: true },
    ];
    const got = changes([e("com.a/same", "https://same.example/", "1"), e("com.a/moved", "https://new.example/", "1"), e("com.a/bumped", "https://b.example/", "2"), e("com.a/gone", "https://g.example/", "1", "deleted"), e("com.a/new", "https://n.example/", "1")], known);
    expect(got).toEqual([
      { name: "com.a/moved", isNew: false, urlChanged: true, versionChanged: false, statusChanged: false },
      { name: "com.a/bumped", isNew: false, urlChanged: false, versionChanged: true, statusChanged: false },
      { name: "com.a/gone", isNew: false, urlChanged: false, versionChanged: false, statusChanged: true },
      { name: "com.a/new", isNew: true, urlChanged: false, versionChanged: false, statusChanged: false },
    ]);
  });
  it("keeps the newest entry per name", () => {
    const old = { ...e("com.a/x", "https://x.example/", "1"), registry_updated_at: "2026-01-01" };
    const neu = { ...e("com.a/x", "https://x.example/", "2"), registry_updated_at: "2026-02-01" };
    expect(latestByName([neu, old])).toEqual([neu]);
  });
  it("notifies at most weekly, never for the first pull", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(weeklyNoticeDue(null, false, now)).toBe(false);
    expect(weeklyNoticeDue("2026-11-05T00:00:00Z", true, now)).toBe(false);
    expect(weeklyNoticeDue("2026-11-02T00:00:00Z", true, now)).toBe(true);
  });
});

// ─── The sync against a small in-memory database ───────────────────────────

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, pk: Record<string, string>) {
  const q = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" | "update" | "upsert"; patch?: Row; rows?: Row[]; head?: boolean } = { kind: "select" };
    const rows = () => (tables[table] ??= []);
    const run = () => {
      if (op.kind === "upsert") {
        for (const r of op.rows!) {
          const i = rows().findIndex((x) => x[pk[table]] === r[pk[table]]);
          if (i >= 0) rows()[i] = { ...rows()[i], ...r };
          else rows().push({ ...r });
        }
        return { data: null, error: null };
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") {
        for (const r of hit) Object.assign(r, op.patch);
        return { data: null, error: null };
      }
      return { data: op.head ? null : hit.map((r) => ({ ...r })), count: hit.length, error: null };
    };
    const b = {
      select: (_c?: string, o?: { head?: boolean }) => ((op = { ...op, ...(op.kind === "select" ? { head: o?.head } : {}) }), b),
      update: (patch: Row) => ((op = { kind: "update", patch }), b),
      upsert: (r: Row | Row[]) => ((op = { kind: "upsert", rows: Array.isArray(r) ? r : [r] }), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      gt: (k: string, v: string) => (filters.push((r) => String(r[k] ?? "") > v), b),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
      maybeSingle: async () => {
        const r = run() as { data: Row[] | null };
        return { data: r.data?.[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
    };
    return b;
  };
  return { from: q } as unknown as SupabaseClient;
}
const PK = { ai_connector_registry_state: "id", ai_connector_registry: "name", ai_connectors: "id", ai_connector_secrets: "connector_id", notifications: "key" };

describe("the sync", () => {
  it("upserts remote servers, follows a moved URL on an offered connector, never deletes, and resumes with updated_since", async () => {
    const A = "https://anthropic.test/v0";
    process.env.CONNECTOR_REGISTRY_URL = A;
    const tables: Record<string, Row[]> = {
      ai_connector_registry_state: [],
      ai_connector_registry: [
        { name: "com.old/kept", url: "https://kept.example/", version: "1", status: "active", available: true, first_seen_at: "2026-01-01T00:00:00Z", changed_at: null },
        { name: "com.shop/mcp", url: "https://shop-old.example/", version: "1", status: "active", available: true, first_seen_at: "2026-01-01T00:00:00Z", changed_at: null },
      ],
      ai_connectors: [{ id: "c1", registry_name: "com.shop/mcp", url: "https://shop-old.example/", registry_version: "1" }],
      ai_connector_secrets: [{ connector_id: "c1", reg_client_id: "abc", auth_meta: { x: 1 } }],
      profiles: [{ id: "e1", is_exec: true, is_active: true }],
      notifications: [],
    };
    const db = fakeDb(tables, PK);
    const first = fakeRegistry({
      [A]: { "": { servers: [item("com.shop/mcp", http("https://shop-new.example/"), { version: "2" }), item("com.new/mcp", http("https://n.example/")), item("io.github.me/mine", http("https://mine.example/")), { server: { name: "com.pkg/only", packages: [{}] } }] } },
    });
    const r = await syncConnectorRegistry(db, { fetcher: first.fetcher, now: new Date("2026-11-10T10:00:00Z") });
    expect(r).toMatchObject({ remote: 2, added: 1, changed: 1, followed: 1, complete: true, sources: [A] });
    expect(tables.ai_connector_registry.map((x) => x.name).sort()).toEqual(["com.new/mcp", "com.old/kept", "com.shop/mcp"]);
    expect(tables.ai_connectors[0]).toMatchObject({ url: "https://shop-new.example/", registry_version: "2" });
    expect(tables.ai_connector_secrets[0]).toMatchObject({ reg_client_id: null, auth_meta: null });
    expect(tables.ai_connector_registry_state.find((s) => s.id === "main")).toMatchObject({ first_pull_done: true, cursor: null, last_complete_at: "2026-11-10T10:00:00.000Z" });
    expect(tables.notifications).toHaveLength(0);

    // A week later: only what changed since, and one notice for what's new
    const next = fakeRegistry({ [A]: { "": { servers: [item("com.newer/mcp", http("https://nn.example/")), item("com.new/mcp", http("https://n.example/"), { status: "deleted" })] } } });
    const r2 = await syncConnectorRegistry(db, { fetcher: next.fetcher, now: new Date("2026-11-18T10:00:00Z") });
    expect(new URL(next.calls[0]).searchParams.get("updated_since")).toBe("2026-11-10T09:00:00.000Z");
    expect(r2).toMatchObject({ added: 1, changed: 1, noticed: 1 });
    expect(tables.ai_connector_registry.find((x) => x.name === "com.new/mcp")).toMatchObject({ available: false, status: "deleted" });
    expect(tables.notifications[0]).toMatchObject({ profile_id: "e1", title: "1 new connector available" });
    delete process.env.CONNECTOR_REGISTRY_URL;
  });

  it("reads the official registry too while Anthropic's returns nothing, each carrying on from its own place", async () => {
    const tables: Record<string, Row[]> = { ai_connector_registry_state: [], ai_connector_registry: [], ai_connectors: [], profiles: [], notifications: [] };
    const db = fakeDb(tables, PK);
    const reg = fakeRegistry({
      [ANTHROPIC_REGISTRY]: { "": { servers: [] } },
      [OFFICIAL_REGISTRY]: {
        "": { servers: [item("com.canva.mcp/mcp", http("https://mcp.canva.com/mcp"), { title: "Canva MCP" }), item("io.github.me/x", http("https://x.example/"))], next: "p2" },
        p2: { servers: [item("ac.mizan/registry", http("https://mizan.ac/mcp"))] },
      },
    });
    const r = await syncConnectorRegistry(db, { fetcher: reg.fetcher, now: new Date("2026-11-11T10:00:00Z") });
    expect(r).toMatchObject({ sources: [ANTHROPIC_REGISTRY, OFFICIAL_REGISTRY], source: OFFICIAL_REGISTRY, complete: true, remote: 2, added: 2, catalog: 2, noticed: 0 });
    expect(tables.ai_connector_registry.find((x) => x.name === "com.canva.mcp/mcp")).toMatchObject({ title: "Canva", featured: true, vendor: "Canva", source: OFFICIAL_REGISTRY });
    expect(tables.ai_connector_registry_state.map((s) => s.id).sort()).toEqual(["main", "official"]);
    expect(tables.ai_connector_registry_state.find((s) => s.id === "official")).toMatchObject({ first_pull_done: true, cursor: null });

    // Next run: both incremental; Anthropic's still has nothing, so the official one is read again from its own time
    const again = fakeRegistry({ [ANTHROPIC_REGISTRY]: { "": { servers: [] } }, [OFFICIAL_REGISTRY]: { "": { servers: [] } } });
    await syncConnectorRegistry(db, { fetcher: again.fetcher, now: new Date("2026-11-12T10:00:00Z") });
    const official = again.calls.filter((c) => c.startsWith(OFFICIAL_REGISTRY));
    expect(official).toHaveLength(1);
    expect(new URL(official[0]).searchParams.get("updated_since")).toBe("2026-11-11T09:00:00.000Z");
  });

  it("leaves the official registry alone once Anthropic's has servers", async () => {
    const tables: Record<string, Row[]> = { ai_connector_registry_state: [], ai_connector_registry: [], ai_connectors: [], profiles: [], notifications: [] };
    const reg = fakeRegistry({ [ANTHROPIC_REGISTRY]: { "": { servers: [item("com.notion/mcp", http("https://mcp.notion.com/mcp"))] } }, [OFFICIAL_REGISTRY]: { "": { servers: [] } } });
    const r = await syncConnectorRegistry(fakeDb(tables, PK), { fetcher: reg.fetcher });
    expect(r).toMatchObject({ sources: [ANTHROPIC_REGISTRY], remote: 1 });
    expect(reg.calls.some((c) => c.startsWith(OFFICIAL_REGISTRY))).toBe(false);
  });

  it("falls back to the official registry when Anthropic's can't be reached, keeping Anthropic's cursor", async () => {
    const tables: Record<string, Row[]> = { ai_connector_registry_state: [{ id: "main", source: ANTHROPIC_REGISTRY, cursor: "keep", cursor_since: null, first_pull_done: false }], ai_connector_registry: [], ai_connectors: [], profiles: [], notifications: [] };
    const reg = fakeRegistry({ [OFFICIAL_REGISTRY]: { "": { servers: [item("com.stripe/mcp", http("https://mcp.stripe.com"))] } } });
    const r = await syncConnectorRegistry(fakeDb(tables, PK), { fetcher: reg.fetcher });
    expect(r).toMatchObject({ source: OFFICIAL_REGISTRY, remote: 1, complete: true });
    expect(tables.ai_connector_registry_state.find((s) => s.id === "main")).toMatchObject({ cursor: "keep" });
  });

  it("stops at the time budget with the cursor saved, and carries on next run", async () => {
    const tables: Record<string, Row[]> = { ai_connector_registry_state: [], ai_connector_registry: [], ai_connectors: [], profiles: [], notifications: [] };
    const db = fakeDb(tables, PK);
    const pages: Record<string, { servers: RegistryItem[]; next?: string }> = {};
    for (let i = 0; i < 60; i++) pages[i ? `p${i}` : ""] = { servers: [item(`com.s${i}/mcp`, http(`https://s${i}.example/`))], ...(i < 59 ? { next: `p${i + 1}` } : {}) };
    const reg = fakeRegistry({ [ANTHROPIC_REGISTRY]: { "": { servers: [] } }, [OFFICIAL_REGISTRY]: pages });
    let t = 0;
    const r = await syncConnectorRegistry(db, { fetcher: reg.fetcher, budgetMs: 30, clock: () => t++ });
    expect(r.complete).toBe(false);
    const st = tables.ai_connector_registry_state.find((s) => s.id === "official")!;
    expect(st.cursor).toBeTruthy();
    const saved = tables.ai_connector_registry.length;
    expect(saved).toBeGreaterThan(0);
    const r2 = await syncConnectorRegistry(db, { fetcher: reg.fetcher });
    expect(r2).toMatchObject({ complete: true });
    expect(tables.ai_connector_registry).toHaveLength(60);
  });
});
