import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideWrite, managerHref, switchHref } from "@/lib/write-status-core";

const client = { id: "c1", name: "Giant Party Sports", slug: "giant-party-sports" };

describe("decideWrite", () => {
  it("Meta: the sandbox off writes everywhere", () => {
    expect(decideWrite({ platform: "meta", account: "act_123", client, configured: true, sandbox: false, sandboxAccount: "999", clientLive: false }).live).toBe(true);
  });
  it("Meta: sandbox on, the client switched off: off, named, with the reason", () => {
    const s = decideWrite({ platform: "meta", account: "act_123", client, configured: true, sandbox: true, sandboxAccount: "999", clientLive: false });
    expect(s.live).toBe(false);
    expect(s.off).toBe("client");
    expect(s.reason).toBe("Live changes are off for Giant Party Sports.");
  });
  it("Meta: sandbox on but the client is live, or it's Kaizen's own account", () => {
    expect(decideWrite({ platform: "meta", account: "123", client, configured: true, sandbox: true, sandboxAccount: "999", clientLive: true }).live).toBe(true);
    expect(decideWrite({ platform: "meta", account: "act_999", client: null, configured: true, sandbox: true, sandboxAccount: "999", clientLive: false }).live).toBe(true);
  });
  it("not connected, or no account", () => {
    expect(decideWrite({ platform: "meta", account: "123", client, configured: false, sandbox: false, clientLive: true })).toMatchObject({ live: false, off: "disconnected" });
    expect(decideWrite({ platform: "google", account: null, client, configured: true, googleGlobal: true, clientLive: true })).toMatchObject({ live: false, off: "no_account" });
  });
  it("Google: the global switch or the client's own", () => {
    expect(decideWrite({ platform: "google", account: "123-456-7890", client, configured: true, googleGlobal: true, clientLive: false }).live).toBe(true);
    expect(decideWrite({ platform: "google", account: "123-456-7890", client, configured: true, googleGlobal: false, clientLive: true }).live).toBe(true);
    const off = decideWrite({ platform: "google", account: "123-456-7890", client, configured: true, googleGlobal: false, clientLive: false });
    expect(off.reason).toBe("Live changes are off for Giant Party Sports's Google Ads.");
  });
  it("links: the client's Team & setup, and the account by hand", () => {
    expect(switchHref({ client })).toBe("/clients/giant-party-sports?tab=team");
    expect(managerHref("meta", "act_123")).toBe("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123");
    expect(managerHref("google", "123-456-7890")).toBe("https://ads.google.com/aw/campaigns?__e=1234567890");
    expect(managerHref("meta", null)).toBeNull();
  });
});

// The server side reads what the gates read: the sandbox setting, the live clients' accounts, the client's name
const state = { metaOn: true, googleOn: true, sandbox: true, live: new Set<string>() };
vi.mock("@/lib/context/meta", () => ({ metaConfigured: () => state.metaOn }));
vi.mock("@/lib/context/google-ads", () => ({ googleAdsConfigured: () => state.googleOn }));
vi.mock("@/lib/meta-write", () => ({
  metaWriteSetting: async () => ({ sandbox: state.sandbox, sandboxAccount: "999" }),
  liveAccounts: async () => state.live,
}));

type Row = Record<string, unknown>;
function fakeAdmin(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      not: (k: string) => ((rows = rows.filter((r) => r[k] != null)), q),
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      then: (ok: (v: { data: Row[] }) => unknown) => ok({ data: rows }),
    };
    return q;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("writeStatus", () => {
  const admin = fakeAdmin({
    clients: [{ id: "c1", name: "Giant Party Sports", slug: "giant-party-sports", live_ad_writes: false }],
    kpi_targets: [
      { client_id: "c1", platform: "meta", ad_account_id: "act_123" },
      { client_id: "c1", platform: "google", ad_account_id: "123-456-7890" },
    ],
    app_settings: [{ key: "google_write", value: { enabled: false } }],
  });
  beforeEach(() => {
    state.metaOn = true;
    state.sandbox = true;
    state.live = new Set();
  });

  it("from the client: finds its Meta account, off while the client isn't live", async () => {
    const { writeStatus } = await import("@/lib/write-status");
    const s = await writeStatus(admin, "c1", "meta");
    expect(s).toMatchObject({ live: false, off: "client", client: { name: "Giant Party Sports", slug: "giant-party-sports" } });
  });
  it("from the account: finds its client, live once the account is", async () => {
    const { writeStatus } = await import("@/lib/write-status");
    state.live = new Set(["123"]);
    const s = await writeStatus(admin, { account: "123" }, "meta");
    expect(s.live).toBe(true);
    expect(s.client?.id).toBe("c1");
  });
  it("Google follows the global switch and the client's live accounts", async () => {
    const { writeStatus } = await import("@/lib/write-status");
    expect((await writeStatus(admin, "c1", "google")).live).toBe(false);
    state.live = new Set(["1234567890"]);
    expect((await writeStatus(admin, "c1", "google")).live).toBe(true);
  });
});
