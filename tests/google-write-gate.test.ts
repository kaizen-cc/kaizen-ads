import { afterEach, describe, expect, it, vi } from "vitest";

// The Google Ads write gate: only a client's own "Live changes in Google Ads" switch opens its account. Meta's switch
// (live_ad_writes) never does, and every real Google change is refused at googleMutate itself, whatever asked for it.

type Row = Record<string, unknown>;
function fakeAdmin(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      is: (k: string, v: unknown) => ((rows = rows.filter((r) => (r[k] ?? null) === v)), q),
      in: (k: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), q),
      then: (ok: (v: { data: Row[] }) => unknown) => ok({ data: rows }),
    };
    return q;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const tables = {
  clients: [
    // Live in Meta only (like Sierra Dreams today): its Google account must stay closed
    { id: "meta-only", live_ad_writes: true, live_google_writes: false, archived_at: null },
    { id: "google-on", live_ad_writes: false, live_google_writes: true, archived_at: null },
    { id: "archived", live_ad_writes: true, live_google_writes: true, archived_at: "2026-10-01" },
  ],
  kpi_targets: [
    { id: "t1", client_id: "meta-only", platform: "meta", ad_account_id: "act_111", label: null, active: true },
    { id: "t2", client_id: "meta-only", platform: "google", ad_account_id: "111-111-1111", label: null, active: true },
    { id: "t3", client_id: "google-on", platform: "google", ad_account_id: "222-222-2222", label: "Search", active: true },
    { id: "t4", client_id: "archived", platform: "google", ad_account_id: "333-333-3333", label: null, active: true },
  ],
};

vi.mock("@/lib/context/meta", () => ({ metaConfigured: () => true, metaGraph: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => true, createAdminClient: () => fakeAdmin(tables) }));

describe("googleWritesOn", () => {
  it("opens only accounts of clients with the Google switch on", async () => {
    const { googleWritesOn } = await import("@/lib/meta-write");
    const admin = fakeAdmin(tables);
    expect(await googleWritesOn(admin, "222-222-2222")).toBe(true);
    expect(await googleWritesOn(admin, "2222222222")).toBe(true);
    // Live in Meta isn't live in Google Ads
    expect(await googleWritesOn(admin, "111-111-1111")).toBe(false);
    // Archived clients are never live
    expect(await googleWritesOn(admin, "333-333-3333")).toBe(false);
    expect(await googleWritesOn(admin, null)).toBe(false);
  });
  it("Meta's live accounts still come from live_ad_writes", async () => {
    const { liveAccounts } = await import("@/lib/meta-write");
    expect([...(await liveAccounts(fakeAdmin(tables), "meta"))]).toEqual(["111"]);
    expect([...(await liveAccounts(fakeAdmin(tables), "google"))]).toEqual(["2222222222"]);
  });
  it("Team & setup lists the accounts the switch opens, read the same way", async () => {
    const { clientWriteAccounts } = await import("@/lib/meta-write");
    expect(await clientWriteAccounts(fakeAdmin(tables), "google-on", "google")).toEqual([{ account: "2222222222", label: "Search", targetId: "t3", active: true }]);
  });
});

describe("googleMutate", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("refuses a real change on a client without the Google switch, before anything reaches Google", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { googleMutate } = await import("@/lib/context/google-ads");
    await expect(googleMutate("111-111-1111", "campaigns", [{ update: {} }], false)).rejects.toThrow(/Live changes in Google Ads are off/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a launch's deploy batch the same way (a chat launch never writes with the switch off)", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { googleBulkMutate } = await import("@/lib/context/google-ads");
    await expect(googleBulkMutate("111-111-1111", [{ campaignBudgetOperation: { create: {} } }], false)).rejects.toThrow(/Live changes in Google Ads are off/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
