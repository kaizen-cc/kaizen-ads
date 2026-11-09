import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ccFrom, holdersOf, onCard, orderSeats, primaryOf, seatKeys, seatPlatforms, secondariesOf, setPrimarySeat, withCoBuyers, type SeatRow } from "@/lib/buyer-seats";
import { can, clientPerms } from "@/lib/chat-permissions";

// A client can have a primary buyer and secondary buyers on one seat (client_assignments.is_primary). The primary is
// who a task picks; everyone on the seat sees the account, can act on it, and hears its alerts.

const ACME = "c-acme";
const OTHER = "c-other";
const seat = (profile_id: string, role: string, is_primary: boolean, created_at: string, client_id = ACME): SeatRow => ({ client_id, profile_id, role, is_primary, created_at });

const rows: SeatRow[] = [
  seat("sam", "meta_buyer", false, "2026-11-02"),
  seat("pat", "meta_buyer", true, "2026-11-05"),
  seat("lee", "meta_buyer", false, "2026-11-01"),
  seat("gil", "google_buyer", true, "2026-10-01"),
  seat("pat", "meta_buyer", true, "2026-09-01", OTHER),
];

describe("seat resolution", () => {
  it("puts the primary first, then the secondaries by when they joined", () => {
    expect(orderSeats(rows.filter((r) => r.client_id === ACME && r.role === "meta_buyer")).map((r) => r.profile_id)).toEqual(["pat", "lee", "sam"]);
  });
  it("finds the primary and the secondaries of a seat", () => {
    expect(primaryOf(rows, "meta_buyer", ACME)?.profile_id).toBe("pat");
    expect(holdersOf(rows, "meta_buyer", ACME)).toEqual(["pat", "lee", "sam"]);
    expect(secondariesOf(rows, "meta_buyer", ACME)).toEqual(["lee", "sam"]);
    expect(secondariesOf(rows, "google_buyer", ACME)).toEqual([]);
    expect(primaryOf(rows, "google_buyer", OTHER)).toBeNull();
  });
  it("reads a row not marked either way (before the migration) as the primary", () => {
    expect(primaryOf([{ profile_id: "old", role: "meta_buyer" }], "meta_buyer")?.profile_id).toBe("old");
  });
  it("a secondary holds the seat like the primary does", () => {
    expect(seatPlatforms(rows, "sam", ACME)).toEqual(["meta"]);
    expect(seatPlatforms(rows, "sam", OTHER)).toEqual([]);
    expect([...seatKeys(rows, "pat")].sort()).toEqual([`${ACME}:meta`, `${OTHER}:meta`]);
  });
});

describe("who hears an alert", () => {
  it("copies the secondaries in where the owner is told, each person once", () => {
    expect(ccFrom(rows.filter((r) => r.client_id === ACME), "meta", ["pat"])).toEqual(["pat", "lee", "sam"]);
    // The owner is one of the secondaries: still once each
    expect(ccFrom(rows.filter((r) => r.client_id === ACME), "meta", ["sam", "sam", null])).toEqual(["sam", "lee"]);
  });
  it("only that platform's seat", () => {
    expect(ccFrom(rows.filter((r) => r.client_id === ACME), "google", ["gil"])).toEqual(["gil"]);
  });
  it("adds nobody when nobody was being told", () => {
    expect(ccFrom(rows, "meta", [null, undefined])).toEqual([]);
  });
  it("a client with one buyer hears exactly as before", () => {
    expect(ccFrom(rows.filter((r) => r.client_id === OTHER), "meta", ["pat"])).toEqual(["pat"]);
    expect(ccFrom(rows.filter((r) => r.client_id === OTHER), "meta", ["someone-else"])).toEqual(["someone-else"]);
  });
  it("reads the seat from the database", async () => {
    const db = fakeDb(rows);
    expect(await withCoBuyers(db, ACME, "meta", ["pat"])).toEqual(["pat", "lee", "sam"]);
    expect(await withCoBuyers(db, OTHER, "meta", ["pat"])).toEqual(["pat"]);
    expect(await withCoBuyers(db, ACME, "meta", [null])).toEqual([]);
  });
});

describe("a secondary buyer's permissions", () => {
  const buyer = { role: "media_buyer", isExec: false };
  it("can change and launch on the platform they're a secondary on", () => {
    const seats = seatPlatforms(rows, "sam", ACME);
    expect(can(buyer, "ads.change", { platform: "meta", seats }).ok).toBe(true);
    expect(can(buyer, "ads.launch", { platform: "meta", seats }).ok).toBe(true);
    expect(clientPerms(buyer, seats).change.meta).toBe(true);
  });
  it("not on another platform, nor on a client they're not on", () => {
    expect(can(buyer, "ads.change", { platform: "google", seats: seatPlatforms(rows, "sam", ACME) }).ok).toBe(false);
    expect(can(buyer, "ads.change", { platform: "meta", seats: seatPlatforms(rows, "sam", OTHER) }).ok).toBe(false);
  });
});

describe("the KPI board's buyer filter", () => {
  it("shows a card to its owner and to its secondary buyers", () => {
    const card = { ownerKey: "pat", buyerIds: ["lee", "sam"] };
    expect(onCard("pat", card)).toBe(true);
    expect(onCard("sam", card)).toBe(true);
    expect(onCard("gil", card)).toBe(false);
  });
  it("a card with one buyer is unchanged", () => {
    expect(onCard("pat", { ownerKey: "pat" })).toBe(true);
    expect(onCard("lee", { ownerKey: "pat", buyerIds: [] })).toBe(false);
  });
});

describe("changing the primary", () => {
  it("replaces the primary and keeps the secondaries", async () => {
    const db = fakeDb(rows);
    expect(await setPrimarySeat(db, ACME, "meta_buyer", "new")).toEqual({ ok: true, from: "pat", to: "new" });
    expect(holdersOf(db.rows, "meta_buyer", ACME)).toEqual(["new", "lee", "sam"]);
    expect(holdersOf(db.rows, "meta_buyer", OTHER)).toEqual(["pat"]);
  });
  it("moves a secondary up when they're picked", async () => {
    const db = fakeDb(rows);
    expect(await setPrimarySeat(db, ACME, "meta_buyer", "sam")).toEqual({ ok: true, from: "pat", to: "sam" });
    expect(holdersOf(db.rows, "meta_buyer", ACME)).toEqual(["sam", "lee"]);
  });
  it("clearing the primary moves the longest-serving secondary up", async () => {
    const db = fakeDb(rows);
    expect(await setPrimarySeat(db, ACME, "meta_buyer", null)).toEqual({ ok: true, from: "pat", to: "lee" });
    expect(holdersOf(db.rows, "meta_buyer", ACME)).toEqual(["lee", "sam"]);
    expect(db.rows.filter((r) => r.client_id === ACME && r.role === "meta_buyer" && r.is_primary).map((r) => r.profile_id)).toEqual(["lee"]);
  });
  it("one buyer: replaced, or cleared, as before", async () => {
    const db = fakeDb(rows);
    expect(await setPrimarySeat(db, OTHER, "meta_buyer", "kim")).toEqual({ ok: true, from: "pat", to: "kim" });
    expect(holdersOf(db.rows, "meta_buyer", OTHER)).toEqual(["kim"]);
    expect(await setPrimarySeat(db, OTHER, "meta_buyer", null)).toEqual({ ok: true, from: "kim", to: null });
    expect(holdersOf(db.rows, "meta_buyer", OTHER)).toEqual([]);
  });
  it("picking the current primary changes nothing", async () => {
    const db = fakeDb(rows);
    expect(await setPrimarySeat(db, ACME, "meta_buyer", "pat")).toEqual({ ok: true, from: "pat", to: "pat" });
    expect(db.rows).toHaveLength(rows.length);
  });
});

// ─── A tiny in-memory client_assignments, enough for the queries above ───────
type Row = SeatRow & { client_id: string };
function fakeDb(initial: SeatRow[]) {
  const state = { rows: initial.map((r) => ({ ...r })) as Row[] };
  const query = (op: "select" | "delete" | "update" | "insert", payload?: unknown) => {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[c] !== v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes((r as Record<string, unknown>)[c])), q),
      then: (done: (x: { data: unknown; error: null }) => unknown) => {
        const hit = (r: Row) => filters.every((f) => f(r));
        if (op === "select") return Promise.resolve(done({ data: state.rows.filter(hit), error: null }));
        if (op === "delete") state.rows = state.rows.filter((r) => !hit(r));
        if (op === "update") state.rows = state.rows.map((r) => (hit(r) ? { ...r, ...(payload as object) } : r));
        if (op === "insert") state.rows.push(...([payload].flat() as Row[]).map((r) => ({ created_at: "2026-11-09", ...r })));
        return Promise.resolve(done({ data: null, error: null }));
      },
    };
    return q;
  };
  const db = {
    from: () => ({ select: () => query("select"), delete: () => query("delete"), update: (p: unknown) => query("update", p), insert: (p: unknown) => query("insert", p) }),
    get rows() {
      return state.rows;
    },
  };
  return db as unknown as SupabaseClient & { rows: Row[] };
}
