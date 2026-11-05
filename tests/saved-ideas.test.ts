import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ideaHash, ideaKeyOf, propagateUse, saveInputOf, saveState, suggestionIdeaKeys, toSaved } from "@/lib/saved-references";
import { markIdeasUsed } from "@/lib/saved-used";
import { POOL_TONE, allotmentPool } from "@/lib/allotment";

const A = "00000000-0000-4000-8000-00000000000a"; // Ana
const B = "00000000-0000-4000-8000-00000000000b"; // Ben
const C = "00000000-0000-4000-8000-00000000000c"; // Cal
const CLIENT = "00000000-0000-4000-8000-0000000000c1";

describe("saves are per person", () => {
  it("shows a person's own open save, hides one they used, and shows one someone else put in motion", () => {
    expect(saveState({ id: "1", savedBy: A, usedAt: null }, A)).toBe("open");
    expect(saveState({ id: "1", savedBy: A, usedAt: "2026-11-05", usedBy: A }, A)).toBe("hidden");
    expect(saveState({ id: "1", savedBy: A, usedAt: "2026-11-05", usedBy: B }, A)).toBe("motion");
    expect(saveState({ id: "1", savedBy: A, usedAt: "2026-11-05", usedBy: B, dismissedAt: "2026-11-06" }, A)).toBe("hidden");
  });

  it("reads 'in motion by <first name>' only when someone else briefed it", () => {
    const base = { id: "r", client_id: CLIENT, source: "market", ref_id: "m1", created_at: "2026-11-05", data: {}, saved_by: A };
    expect(toSaved({ ...base, used_at: null }).motion).toBeNull();
    expect(toSaved({ ...base, used_at: "2026-11-05", used_by: A }).motion).toBeNull();
    const m = toSaved({ ...base, used_at: "2026-11-05", used_by: B, used_href: "/board?t=12", user: { full_name: "Ben Ortiz" } }).motion;
    expect(m).toEqual({ by: "Ben", href: "/board?t=12", at: "2026-11-05" });
  });
});

describe("using an idea marks everyone's save of it", () => {
  it("marks every open save and tells each other saver once, never the briefer", () => {
    const rows = [
      { id: "a", savedBy: A, usedAt: null },
      { id: "b", savedBy: B, usedAt: null },
      { id: "c", savedBy: C, usedAt: "2026-11-01" },
      { id: "x", savedBy: null, usedAt: null },
    ];
    const r = propagateUse(rows, A);
    expect(r.mark).toEqual(["a", "b", "x"]);
    expect(r.notify).toEqual([{ rowId: "b", profileId: B }]);
  });

  it("does nothing when everything was already used", () => {
    expect(propagateUse([{ id: "a", savedBy: B, usedAt: "2026-11-01" }], A)).toEqual({ mark: [], notify: [] });
  });
});

describe("one idea, one key, wherever it's starred", () => {
  it("keys each kind of brief source by its own id", () => {
    expect(ideaKeyOf({ kind: "market", adId: "m1" })).toEqual({ source: "market", refId: "m1" });
    expect(ideaKeyOf({ kind: "pattern", patternId: "p1" })).toEqual({ source: "pattern", refId: "p1" });
    expect(ideaKeyOf({ kind: "refresh", adId: "123456" })).toEqual({ source: "fatigue", refId: "123456" });
    expect(ideaKeyOf({ kind: "suggestion", id: "s1" })).toEqual({ source: "brief", refId: "s1" });
    expect(ideaKeyOf({ kind: "promise", commitmentId: "c1" })).toEqual({ source: "promise", refId: "c1" });
    expect(ideaKeyOf({ kind: "talk", turns: [] })).toBeNull();
  });

  it("keys an idea in words by its label, so the same audit idea matches across people and days", () => {
    const one = ideaKeyOf({ kind: "idea", label: "From the account audit: UGC hook test", text: "spend $120 this week" });
    const two = ideaKeyOf({ kind: "idea", label: "From the account audit: UGC hook test", text: "spend $300 this week" });
    expect(one).toEqual(two);
    expect(one?.source).toBe("audit_idea");
    expect(ideaKeyOf({ kind: "idea", label: "Briefed in Kaizen AI: Summer", text: "" })?.source).toBe("ai");
    expect(ideaHash("a")).not.toBe(ideaHash("b"));
  });

  it("keeps the brief source on the save, to brief it the same way later", () => {
    const s = saveInputOf({ kind: "market", adId: "m1", format: "video" }, { kicker: "In the market", label: "Hook" });
    expect(s?.format).toBe("video");
    expect(s?.data.brief).toEqual({ kind: "market", adId: "m1", format: "video" });
  });

  it("reads the ideas a suggested brief was built on", () => {
    expect(suggestionIdeaKeys("s1", { marketAdId: "m1" })).toEqual([
      { source: "brief", refId: "s1" },
      { source: "market", refId: "m1" },
    ]);
    expect(suggestionIdeaKeys("s2", { adId: "99999", fatigue: true }).map((k) => k.source)).toEqual(["brief", "fatigue"]);
    expect(suggestionIdeaKeys("s3", { adId: "99999" }).map((k) => k.source)).toEqual(["brief", "winner"]);
    expect(suggestionIdeaKeys("s4", { savedKey: { source: "ai", refId: "h1" } }).map((k) => k.source)).toEqual(["brief", "ai"]);
  });
});

// A tiny stand-in for the database: enough of the query builder for markIdeasUsed
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const writes: { table: string; op: string; values: unknown; ids?: unknown }[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "upsert" = "select";
    let values: unknown = null;
    let inIds: unknown[] | null = null;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      in: (k: string, v: unknown[]) => ((inIds = v), filters.push((r) => v.includes(r[k])), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      or: (expr: string) => {
        const pairs = [...expr.matchAll(/source\.eq\.([a-z_]+),ref_id\.eq\."([^"]*)"/g)].map((m) => [m[1], m[2]]);
        filters.push((r) => pairs.some(([s, id]) => r.source === s && r.ref_id === id));
        return q;
      },
      limit: () => q,
      update: (v: unknown) => ((op = "update"), (values = v), q),
      upsert: (v: unknown) => {
        writes.push({ table, op: "upsert", values: v });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (ok: (v: { data: Row[] | null; error: null }) => unknown) => {
        const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          writes.push({ table, op, values, ids: inIds });
          hit.forEach((r) => Object.assign(r, values as Row));
        }
        return Promise.resolve(ok({ data: hit, error: null }));
      },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, writes };
}

describe("markIdeasUsed", () => {
  it("marks Ana's and Ben's saves of the same market ad when Ana briefs it, and tells Ben once", async () => {
    const saves: Row[] = [
      { id: "sa", client_id: CLIENT, source: "market", ref_id: "m1", saved_by: A, used_at: null, title: "Before and after" },
      { id: "sb", client_id: CLIENT, source: "market", ref_id: "m1", saved_by: B, used_at: null, title: "Before and after" },
      { id: "so", client_id: CLIENT, source: "market", ref_id: "m2", saved_by: B, used_at: null, title: "Other" },
    ];
    const { db, writes } = fakeDb({ client_saved_references: saves, clients: [{ id: CLIENT, name: "7th Dimension Aesthetics" }] });
    const r = await markIdeasUsed(db, { clientId: CLIENT, keys: [{ source: "market", refId: "m1" }], requestId: null, href: "/board?t=41", by: { id: A, name: "Ana Ruiz" } });
    expect(r).toEqual({ marked: 2, notified: 1 });
    expect(saves.find((s) => s.id === "sa")?.used_by).toBe(A);
    expect(saves.find((s) => s.id === "sb")?.used_href).toBe("/board?t=41");
    expect(saves.find((s) => s.id === "so")?.used_at).toBeNull();
    const bell = writes.find((w) => w.table === "notifications")?.values as Row[];
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ profile_id: B, key: "saved-used:sb", href: "/board?t=41" });
    expect(bell[0].title).toBe("An idea you saved for 7th Dimension Aesthetics is in motion: Before and after, by Ana");
  });

  it("finds the idea from the saved rows a request used, and a second brief tells nobody again", async () => {
    const saves: Row[] = [
      { id: "11111111-1111-4111-8111-111111111111", client_id: CLIENT, source: "pattern", ref_id: "p1", saved_by: B, used_at: null, title: "UGC" },
      { id: "22222222-2222-4222-8222-222222222222", client_id: CLIENT, source: "pattern", ref_id: "p1", saved_by: C, used_at: null, title: "UGC" },
    ];
    const { db } = fakeDb({ client_saved_references: saves, clients: [{ id: CLIENT, name: "Acme" }] });
    const first = await markIdeasUsed(db, { savedIds: ["11111111-1111-4111-8111-111111111111"], by: { id: B, name: "Ben" } });
    expect(first).toEqual({ marked: 2, notified: 1 });
    const again = await markIdeasUsed(db, { clientId: CLIENT, keys: [{ source: "pattern", refId: "p1" }], by: { id: A, name: "Ana" } });
    expect(again).toEqual({ marked: 0, notified: 0 });
  });
});

describe("allotment colors", () => {
  it("shows a pool at its cap in green and over it in red", () => {
    expect(POOL_TONE[allotmentPool("images", 3, 3).state]).toBe("text-ok");
    expect(POOL_TONE[allotmentPool("images", 3, 4).state]).toBe("text-bad");
    expect(POOL_TONE[allotmentPool("images", 3, 1).state]).toBe("");
  });
});
