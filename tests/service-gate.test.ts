import { describe, expect, it, vi } from "vitest";
import { clientLineMap, clientsWithLine, gateRows, hasLine, keepOnService, keepWithLine, LINE_SERVICE, lineOfPlatform, linesOf, onService, SERVICE_LINES } from "@/lib/service-gate";

// A stand-in for Supabase: every filter is ignored (the code under test does the gating itself), each table answers
// with its rows, and writes are recorded.
type Rows = Record<string, Record<string, unknown>[]>;
function fakeDb(tables: Rows) {
  const writes: { table: string; op: string; row: unknown }[] = [];
  const from = (table: string) => {
    let op = "select";
    let row: unknown = null;
    const result = () => {
      if (op !== "select") return { data: [{ id: `${table}-new` }], error: null };
      return { data: tables[table] ?? [], error: null };
    };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "gte", "lte", "like", "order", "limit", "range", "returns"]) chain[m] = self;
    for (const m of ["insert", "upsert", "update"]) {
      chain[m] = (r: unknown) => {
        op = m;
        row = r;
        writes.push({ table, op, row });
        return chain;
      };
    }
    chain.single = () => Promise.resolve({ data: (result().data as unknown[])[0] ?? null, error: null });
    chain.maybeSingle = chain.single;
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
    return chain;
  };
  return { db: { from, rpc: () => from("rpc") } as never, writes };
}

const meta = { services: ["facebook-ads"], services_extra: [], services_removed: [] };
const webOnly = { services: ["facebook-ads", "web-design"], services_extra: [], services_removed: ["facebook-ads"] };
const added = { services: [], services_extra: ["google-ads", "email-marketing"], services_removed: [] };

describe("the service gate", () => {
  it("maps every line to a service slug", () => {
    expect(SERVICE_LINES).toEqual(["meta", "google", "tiktok", "creative", "email", "social", "web", "crm"]);
    expect(LINE_SERVICE.meta).toBe("facebook-ads");
    expect(LINE_SERVICE.email).toBe("email-marketing");
    expect(LINE_SERVICE.web).toBe("web-design");
  });
  it("reads Track's services plus the added, minus the removed", () => {
    expect([...linesOf(meta)]).toEqual(["meta"]);
    expect([...linesOf(webOnly)]).toEqual(["web"]);
    expect([...linesOf(added)]).toEqual(["google", "email"]);
    expect(hasLine(webOnly, "meta")).toBe(false);
    expect(hasLine(added, "google")).toBe(true);
    expect(hasLine(null, "meta")).toBe(false);
  });
  it("knows the ad platforms as lines", () => {
    expect(lineOfPlatform("meta")).toBe("meta");
    expect(lineOfPlatform("facebook")).toBe("meta");
    expect(lineOfPlatform("google")).toBe("google");
    expect(lineOfPlatform("tiktok")).toBe("tiktok");
    expect(lineOfPlatform("klaviyo")).toBe("email");
    expect(lineOfPlatform("something")).toBeNull();
  });
  it("keeps a KPI card only when its client buys that platform", () => {
    expect(onService({ platform: "meta", clients: meta })).toBe(true);
    expect(onService({ platform: "meta", clients: webOnly })).toBe(false);
    expect(onService({ platform: "google", clients: [added] })).toBe(true);
    // Nothing to judge: not an ad line, or the client wasn't read
    expect(onService({ platform: "other", clients: webOnly })).toBe(true);
    expect(onService({ platform: "meta" })).toBe(true);
    // The client was read and isn't there: off
    expect(onService({ platform: "meta", clients: null })).toBe(false);
  });
  it("filters rows by a line map", () => {
    const lines = new Map([["a", linesOf(meta)], ["b", linesOf(webOnly)]]);
    const rows = [{ client_id: "a", platform: "meta" }, { client_id: "b", platform: "meta" }, { client_id: "a", platform: "google" }, { client_id: "c", platform: "meta" }];
    expect(keepOnService(rows, lines)).toEqual([{ client_id: "a", platform: "meta" }]);
    expect(keepWithLine([{ client_id: "a" }, { client_id: "b" }], lines, "web")).toEqual([{ client_id: "b" }]);
  });
  it("reads every client's lines in one batched query", async () => {
    const { db } = fakeDb({ clients: [{ id: "a", ...meta }, { id: "b", ...webOnly }, { id: "c", ...added }] });
    const map = await clientLineMap(db);
    expect([...map.keys()]).toEqual(["a", "b", "c"]);
    expect([...(await clientsWithLine(db, "meta"))]).toEqual(["a"]);
    expect([...(await clientsWithLine(db, "email", ["a", "b", "c"]))]).toEqual(["c"]);
    expect(await clientLineMap(db, [])).toEqual(new Map());
    const kept = await gateRows(db, [{ client_id: "a", platform: "meta" }, { client_id: "b", platform: "meta" }, { client_id: "c", platform: "google" }]);
    expect(kept.map((r) => r.client_id)).toEqual(["a", "c"]);
  });
  it("brings everything back when the service is added again (nothing was deleted)", () => {
    const back = { ...webOnly, services_removed: [], services_extra: ["facebook-ads"] };
    expect(onService({ platform: "meta", clients: back })).toBe(true);
  });
});

describe("entry points use the gate", () => {
  it("the KPI board's tab counts leave out cards on a removed service", async () => {
    const { boardCounts } = await import("@/lib/kpi/board-counts");
    const { db } = fakeDb({
      kpi_targets: [
        { platform: "meta", clients: meta },
        { platform: "meta", clients: webOnly },
        { platform: "google", clients: added },
        { platform: "google", clients: meta },
      ],
      clients: [meta, webOnly, added],
    });
    expect(await boardCounts(db)).toMatchObject({ meta: 1, google: 1, tiktok: 0, email: 1, social: 0 });
  });

  it("the ads report queue makes no report for a removed service", async () => {
    vi.resetModules();
    const { queueReports } = await import("@/lib/reports/run");
    const { db, writes } = fakeDb({
      kpi_targets: [
        { id: "t1", client_id: "a", platform: "meta", owner_id: null, ad_account_id: "1", clients: { status: "active", archived_at: null, internal: false, ...meta } },
        { id: "t2", client_id: "b", platform: "meta", owner_id: null, ad_account_id: "2", clients: { status: "active", archived_at: null, internal: false, ...webOnly } },
      ],
      kpi_snapshots: [
        { target_id: "t1", windows: { d7: { spend: 100 } } },
        { target_id: "t2", windows: { d7: { spend: 100 } } },
      ],
    });
    const made = await queueReports(db, "weekly", "2026-11-16");
    expect(made).toBe(1);
    const rows = writes.filter((w) => w.table === "reports").map((w) => (w.row as { target_id: string }).target_id);
    expect(rows).toEqual(["t1"]);
  });

  it("auto audits never pick an account on a removed service", async () => {
    vi.resetModules();
    vi.doMock("@/lib/audit", () => ({ runAudit: vi.fn() }));
    const { autoAudits } = await import("@/lib/auto-audits");
    const { db } = fakeDb({
      kpi_snapshots: [
        { target_id: "t1", deviation: 0.5 },
        { target_id: "t2", deviation: 0.9 },
      ],
      kpi_targets: [
        { id: "t1", client_id: "a", platform: "meta", owner_id: null, label: null, clients: { name: "A", status: "active", archived_at: null, ...meta } },
        { id: "t2", client_id: "b", platform: "meta", owner_id: null, label: null, clients: { name: "House", status: "active", archived_at: null, ...webOnly } },
      ],
      account_audits: [],
    });
    // No time to run one: only the selection is counted
    expect(await autoAudits(db, 0)).toEqual({ due: 1, ran: 0 });
    vi.doUnmock("@/lib/audit");
  });
});
