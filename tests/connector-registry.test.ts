import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { changes, latestByName, pickRemote, pullRegistry, toEntry, weeklyNoticeDue, type Entry, type Fetcher, type RegistryItem } from "@/lib/connectors/registry";
import { syncConnectorRegistry } from "@/lib/connectors/registry-sync";

const item = (name: string, remotes: unknown, extra: Partial<{ version: string; status: string; updatedAt: string }> = {}): RegistryItem => ({
  server: { name, title: name.split("/").pop(), description: `${name} server`, version: extra.version ?? "1.0.0", remotes },
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
    expect(toEntry({ server: { name: "pkg/only", packages: [{ registryType: "npm" }] } })).toBeNull();
  });
  it("marks a server that isn't active as unavailable", () => {
    expect(toEntry(item("a/b", http("https://a.example/mcp")))?.available).toBe(true);
    expect(toEntry(item("a/b", http("https://a.example/mcp"), { status: "deprecated" }))).toMatchObject({ available: false, status: "deprecated" });
  });
});

describe("paging", () => {
  const A = "https://anthropic.test/v0";
  const O = "https://official.test/v0.1";
  it("follows the cursor to the end, with version=latest and updated_since", async () => {
    const { fetcher, calls } = fakeRegistry({ [A]: { "": { servers: [item("a/1", http("https://1.example"))], next: "c1" }, c1: { servers: [item("a/2", http("https://2.example"))] } } });
    const p = await pullRegistry({ fetcher, bases: [A, O], since: "2026-11-01T00:00:00.000Z" });
    expect(p).toMatchObject({ source: A, complete: true, pages: 2, cursor: null, error: null });
    expect(p.items).toHaveLength(2);
    expect(new URL(calls[0]).searchParams.get("version")).toBe("latest");
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
  it("stops on a cursor that repeats", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [], next: "c1" }, c1: { servers: [], next: "c1" } } });
    expect(await pullRegistry({ fetcher, bases: [A] })).toMatchObject({ complete: true, pages: 2 });
  });
  it("falls back to the official registry only when Anthropic's can't be reached", async () => {
    const down = fakeRegistry({ [O]: { "": { servers: [item("o/1", http("https://o.example"))] } } });
    expect(await pullRegistry({ fetcher: down.fetcher, bases: [A, O] })).toMatchObject({ source: O, complete: true });
    const empty = fakeRegistry({ [A]: { "": { servers: [] } }, [O]: { "": { servers: [item("o/1", http("https://o.example"))] } } });
    expect(await pullRegistry({ fetcher: empty.fetcher, bases: [A, O] })).toMatchObject({ source: A, items: [] });
  });
  it("keeps what came in when a later page fails", async () => {
    const { fetcher } = fakeRegistry({ [A]: { "": { servers: [item("a/1", http("https://1.example"))], next: "c1" }, c1: 503 } });
    const p = await pullRegistry({ fetcher, bases: [A, O] });
    expect(p).toMatchObject({ source: A, complete: false, cursor: "c1", pages: 1 });
    expect(p.error).toContain("503");
  });
});

describe("change detection", () => {
  const e = (name: string, url: string, version: string, status = "active"): Entry => ({ ...toEntry(item(name, http(url), { version, status }))! });
  it("finds new servers and changed URLs, versions and status, and nothing else", () => {
    const known = [
      { name: "a/same", url: "https://same.example/", version: "1", status: "active", available: true },
      { name: "a/moved", url: "https://old.example/", version: "1", status: "active", available: true },
      { name: "a/bumped", url: "https://b.example/", version: "1", status: "active", available: true },
      { name: "a/gone", url: "https://g.example/", version: "1", status: "active", available: true },
    ];
    const got = changes([e("a/same", "https://same.example/", "1"), e("a/moved", "https://new.example/", "1"), e("a/bumped", "https://b.example/", "2"), e("a/gone", "https://g.example/", "1", "deleted"), e("a/new", "https://n.example/", "1")], known);
    expect(got).toEqual([
      { name: "a/moved", isNew: false, urlChanged: true, versionChanged: false, statusChanged: false },
      { name: "a/bumped", isNew: false, urlChanged: false, versionChanged: true, statusChanged: false },
      { name: "a/gone", isNew: false, urlChanged: false, versionChanged: false, statusChanged: true },
      { name: "a/new", isNew: true, urlChanged: false, versionChanged: false, statusChanged: false },
    ]);
  });
  it("keeps the newest entry per name", () => {
    const old = { ...e("a/x", "https://x.example/", "1"), registry_updated_at: "2026-01-01" };
    const neu = { ...e("a/x", "https://x.example/", "2"), registry_updated_at: "2026-02-01" };
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

describe("the sync", () => {
  const A = "https://anthropic.test/v0";
  it("upserts remote servers, follows a moved URL on an offered connector, never deletes, and resumes with updated_since", async () => {
    process.env.CONNECTOR_REGISTRY_URL = A;
    const tables: Record<string, Row[]> = {
      ai_connector_registry_state: [],
      ai_connector_registry: [{ name: "old/kept", url: "https://kept.example/", version: "1", status: "active", available: true, first_seen_at: "2026-01-01T00:00:00Z", changed_at: null }],
      ai_connectors: [{ id: "c1", registry_name: "a/shop", url: "https://shop-old.example/", registry_version: "1" }],
      ai_connector_secrets: [{ connector_id: "c1", reg_client_id: "abc", auth_meta: { x: 1 } }],
      profiles: [{ id: "e1", is_exec: true, is_active: true }],
      notifications: [],
    };
    const pk = { ai_connector_registry_state: "id", ai_connector_registry: "name", ai_connectors: "id", ai_connector_secrets: "connector_id", notifications: "key" };
    tables.ai_connector_registry.push({ name: "a/shop", url: "https://shop-old.example/", version: "1", status: "active", available: true, first_seen_at: "2026-01-01T00:00:00Z", changed_at: null });
    const db = fakeDb(tables, pk);
    const first = fakeRegistry({ [A]: { "": { servers: [item("a/shop", http("https://shop-new.example/"), { version: "2" }), item("a/new", http("https://n.example/")), { server: { name: "pkg/only", packages: [{}] } }] } } });
    const r = await syncConnectorRegistry(db, { fetcher: first.fetcher, now: new Date("2026-11-10T10:00:00Z") });
    expect(r).toMatchObject({ remote: 2, added: 1, changed: 1, followed: 1, complete: true });
    expect(tables.ai_connector_registry.map((x) => x.name).sort()).toEqual(["a/new", "a/shop", "old/kept"]);
    expect(tables.ai_connectors[0]).toMatchObject({ url: "https://shop-new.example/", registry_version: "2" });
    expect(tables.ai_connector_secrets[0]).toMatchObject({ reg_client_id: null, auth_meta: null });
    expect(tables.ai_connector_registry_state[0]).toMatchObject({ first_pull_done: true, cursor: null, last_complete_at: "2026-11-10T10:00:00.000Z" });
    expect(tables.notifications).toHaveLength(0);

    // A week later: only what changed since, and one notice for what's new
    const next = fakeRegistry({ [A]: { "": { servers: [item("a/newer", http("https://nn.example/")), item("a/new", http("https://n.example/"), { status: "deleted" })] } } });
    const r2 = await syncConnectorRegistry(db, { fetcher: next.fetcher, now: new Date("2026-11-18T10:00:00Z") });
    expect(new URL(next.calls[0]).searchParams.get("updated_since")).toBe("2026-11-10T09:00:00.000Z");
    expect(r2).toMatchObject({ added: 1, changed: 1, noticed: 1 });
    expect(tables.ai_connector_registry.find((x) => x.name === "a/new")).toMatchObject({ available: false, status: "deleted" });
    expect(tables.notifications[0]).toMatchObject({ profile_id: "e1", title: "1 new connector available" });
    delete process.env.CONNECTOR_REGISTRY_URL;
  });
});
