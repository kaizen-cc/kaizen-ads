import { beforeEach, describe, expect, it, vi } from "vitest";

// The feedback loop, walked end to end with fakes: the Head of Google pushes back on a Google audit finding ("already
// added: customer list"), it's saved as a learning for the Google auditor scoped to that client, and the next Google
// audit of that client (rebuttalsBlock) and its sprint checks (every askJson call: withKnowledge) read it, while other
// clients don't.

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;
const DEFAULTS: Record<string, Row> = {
  agent_learnings: { scope: "client", kind: "lesson", status: "active", confidence: 0.5, evidence: 1, condition: null, proposed_scope: null, model: null, vertical_id: null, classified_at: null },
};

/** Just enough of supabase-js for these modules: select/insert/update with eq, neq, in, or, order, limit */
function fakeAdmin() {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" } | { kind: "insert"; rows: Row[] } | { kind: "update"; patch: Row } = { kind: "select" };
    let limit = Infinity;
    const run = () => {
      const rows = (db[table] ??= []);
      if (op.kind === "insert") {
        const made = op.rows.map((r) => ({ id: `id-${++seq}`, created_at: new Date().toISOString(), last_seen: new Date().toISOString(), updated_at: new Date().toISOString(), ...DEFAULTS[table], ...r }));
        rows.push(...made);
        return made;
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") for (const r of hit) Object.assign(r, op.patch);
      return hit.slice(0, limit);
    };
    const q = {
      select: () => q,
      insert: (r: Row | Row[]) => ((op = { kind: "insert", rows: Array.isArray(r) ? r : [r] }), q),
      update: (patch: Row) => ((op = { kind: "update", patch }), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
      or: (expr: string) => {
        const parts = expr.split(",").map((p) => p.split("."));
        filters.push((r) => parts.some(([k, o, v]) => (o === "eq" ? String(r[k]) === v : String(r[k]) !== v)));
        return q;
      },
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: { data: Row[]; error: null }) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok, bad),
    };
    return q;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
const admin = fakeAdmin();

// Work deferred with after() runs right away, collected so the test can wait for it
const pending: Promise<unknown>[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => pending.push(fn()) }));
// The classifier: what the Head of Google's pushback teaches
const classify = vi.fn(async () => ({ lesson: "Don't recommend adding a customer match list: it's already attached and in use on this account.", condition: "", kind: "lesson", scope: "client", confidence: 0.9 }));
vi.mock("@/lib/ai", () => ({ askJson: classify }));
vi.mock("@/lib/business-model", () => ({ businessModelOf: async () => ({ model: "lead_gen", also: null, why: "" }) }));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => true, createAdminClient: () => admin }));
vi.mock("@/lib/knowledge", () => ({ knowledgeBlock: async () => "" }));
vi.mock("@/lib/buying-insights", () => ({ buyerPlaybookBlock: async () => "" }));

const { canRebut } = await import("@/lib/rebut-permission");
const { saveRebuttal, rebuttalsBlock } = await import("@/lib/audit-rebuttals");
const { withKnowledge } = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const HEAD = "00000000-0000-4000-8000-0000000000h1";

describe("a Google audit rebuttal teaches the next audit and the sprint checks", () => {
  beforeEach(async () => {
    for (const k of Object.keys(db)) delete db[k];
    db.clients = [
      { id: CLIENT, name: "Acme Roofing", vertical_id: "v1", industry_detail: "roofing" },
      { id: OTHER, name: "Other Co", vertical_id: "v1", industry_detail: "roofing" },
    ];
    pending.length = 0;
    expect(canRebut({ role: "head_of_google" }, "google")).toBe(true);
    await saveRebuttal(admin, {
      clientId: CLIENT,
      kind: "account",
      auditId: "audit-1",
      itemKey: "action:2",
      finding: "Add a customer match list to the Search campaigns",
      reason: "Already added: customer list. We're leveraging the customer list on every Search campaign.",
      by: HEAD,
      platform: "google",
    });
    await Promise.all(pending);
  });

  it("saves it on the audit, in client memory, and as a client-scoped learning for the Google auditor", () => {
    expect(db.audit_rebuttals).toHaveLength(1);
    expect(String(db.client_memory[0].body)).toMatch(/Already added: customer list/);
    const [l] = db.agent_learnings;
    expect(l).toMatchObject({ agent_key: "google_auditor", client_id: CLIENT, scope: "client", status: "active", source_table: "audit_rebuttals" });
    // Classified, and the classification can't widen it past the client by itself
    expect(l.classified_at).toBeTruthy();
    expect(String(l.lesson)).toMatch(/customer match list/);
  });

  it("is read by the next Google audit of that client, and not by another client's", async () => {
    const block = await rebuttalsBlock(admin, CLIENT, "google ads search account audit");
    expect(block).toContain(`<learned_from_the_team client="${CLIENT}"`);
    expect(block).toMatch(/customer match list/);
    expect(await rebuttalsBlock(admin, OTHER, "google ads search account audit")).not.toMatch(/customer match list/);
  });

  it("is read by every Google auditor call about the client (sprint checks) and by the Google launcher", async () => {
    const sprint = await withKnowledge("google_auditor", "sprint check Acme Roofing", "<sprint>...</sprint>", CLIENT);
    expect(sprint).toMatch(/customer match list/);
    const launcher = await withKnowledge("google_launcher", "google ideas Acme Roofing", "plan", CLIENT);
    expect(launcher).toMatch(/customer match list/);
    // Not for a different client, and the Meta auditor isn't taught a Google lesson
    expect(await withKnowledge("google_auditor", "sprint check Other Co", "<sprint>...</sprint>", OTHER)).not.toMatch(/customer match list/);
    expect(await withKnowledge("auditor", "sprint check Acme Roofing", "<sprint>...</sprint>", CLIENT)).not.toMatch(/customer match list/);
  });

  it("isn't added twice when the audit's prompt already carries it", async () => {
    const block = await rebuttalsBlock(admin, CLIENT, "google ads search account audit");
    const out = await withKnowledge("google_auditor", "audit Acme Roofing · plan", `context\n${block}`, CLIENT);
    expect(out.split("<learned_from_the_team").length - 1).toBe(1);
  });
});
