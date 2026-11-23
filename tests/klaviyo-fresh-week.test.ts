import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// La Jetée's weekly report said $6,939 from campaigns where Klaviyo's summary said $7,560.32: the campaigns kept earning
// after they went out, and the frequent read only rewrote yesterday and today. Now it rewrites the last seven days, and
// a day it has no store numbers for is saved without those columns (never written empty).
describe("rows saved by the columns they carry", () => {
  it("keeps a day without the store's numbers apart from one with them", async () => {
    const { byColumns } = await import("@/lib/klaviyo/store");
    const groups = byColumns([
      { client_id: "c", date: "2026-11-18", revenue: 10 },
      { client_id: "c", date: "2026-11-22", revenue: 5, store_revenue: 100, store_orders: 3 },
      { client_id: "c", date: "2026-11-19", revenue: 7 },
    ]);
    expect(groups.map((g) => g.map((r) => r.date))).toEqual([["2026-11-18", "2026-11-19"], ["2026-11-22"]]);
  });
});

