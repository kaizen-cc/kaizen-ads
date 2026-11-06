import { beforeEach, describe, expect, it, vi } from "vitest";

// The server gates behind the chat: whoever asks, a Google buyer never deploys or changes anything in Meta (and the
// other way round), the creative team never touches an ad account, and briefs only come from those who write them, in
// their formats. Each gate runs before anything reaches the platform or the AI.

type Row = Record<string, unknown>;
type Write = { table: string; op: string; value: unknown };

function fakeAdmin(tables: Record<string, Row[]>) {
  const writes: Write[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let update: unknown = null;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      in: (k: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), q),
      not: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      is: () => q,
      update: (p: unknown) => ((update = p), q),
      insert: (p: Row) => {
        writes.push({ table, op: "insert", value: p });
        rows = [{ id: `new-${table}`, ...p }];
        return q;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: "none" } }),
      then: (ok: (v: { data: Row[] }) => unknown, bad?: (e: unknown) => unknown) => {
        if (update) writes.push({ table, op: "update", value: update });
        return Promise.resolve({ data: rows }).then(ok, bad);
      },
    };
    return q;
  };
  return { admin: { from } as unknown as import("@supabase/supabase-js").SupabaseClient, writes };
}

const profiles = [
  { id: "exec", role: "executive", is_exec: true },
  { id: "hmeta", role: "head_of_meta", is_exec: false },
  { id: "hgoogle", role: "head_of_google", is_exec: false },
  { id: "mbuyer", role: "media_buyer", is_exec: false },
  { id: "mbuyer2", role: "media_buyer", is_exec: false },
  { id: "gbuyer", role: "google_buyer", is_exec: false },
  { id: "hcreative", role: "head_of_creative", is_exec: false },
  { id: "designer", role: "graphic_designer", is_exec: false },
  { id: "copy", role: "copywriter", is_exec: false },
];
const base = () => ({
  profiles,
  // mbuyer is c1's Meta buyer and gbuyer its Google buyer; mbuyer2 isn't on c1
  client_assignments: [
    { client_id: "c1", profile_id: "mbuyer", role: "meta_buyer" },
    { client_id: "c1", profile_id: "gbuyer", role: "google_buyer" },
  ],
  kpi_targets: [
    { id: "tm", client_id: "c1", platform: "meta", active: true, ad_account_id: "act_111", owner_id: null },
    { id: "tg", client_id: "c1", platform: "google", active: true, ad_account_id: "222-222-2222", owner_id: null },
  ],
  launch_runs: [
    { id: "run-meta", client_id: "c1", platform: "meta", status: "applying" },
    { id: "run-google", client_id: "c1", platform: "google", status: "applying" },
  ],
  ad_changes: [
    { id: "ch-meta", client_id: "c1", platform: "meta", account: "111", ops: [], sprint_action_id: null, status: "ready" },
    { id: "ch-google", client_id: "c1", platform: "google", account: "2222222222", ops: [], sprint_action_id: null, status: "ready" },
  ],
});

const bulk = vi.fn();
const metaWriteFn = vi.fn();
vi.mock("@/lib/context/google-ads", async (orig) => ({ ...(await orig<typeof import("@/lib/context/google-ads")>()), googleBulkMutate: (...a: unknown[]) => bulk(...a), googleMutate: (...a: unknown[]) => bulk(...a) }));
vi.mock("@/lib/meta-write", async (orig) => ({ ...(await orig<typeof import("@/lib/meta-write")>()), metaWrite: (...a: unknown[]) => metaWriteFn(...a), writeBlocked: async () => null, googleWritesOn: async () => true }));

// The signed-in person for the server actions
const signedIn = vi.hoisted(() => ({ me: {} as Record<string, unknown> }));
vi.mock("@/lib/auth", () => ({ requireStaff: async () => signedIn.me, isExecOrLead: () => false, seesAllClients: () => false }));

beforeEach(() => {
  bulk.mockReset();
  metaWriteFn.mockReset();
});

describe("Meta launch deploy (launch sheets)", () => {
  it("a Google buyer, a Meta buyer not on the client and the creative team are refused before anything is created", async () => {
    const { applyRun } = await import("@/lib/launch-sheet/runs");
    for (const by of ["gbuyer", "hgoogle", "mbuyer2", "hcreative", "designer", "copy"]) {
      const { admin, writes } = fakeAdmin(base());
      const r = await applyRun(admin, "run-meta", { by });
      expect(r).toEqual({ blocked: expect.stringMatching(/Launching in Meta is for the Head of Meta/) });
      // Only the run's own status is written back (never a launch item or a Meta object)
      expect(writes.every((w) => w.table === "launch_runs")).toBe(true);
    }
    expect(metaWriteFn).not.toHaveBeenCalled();
  });

  it("starting one from the chat is refused the same way, and allowed for the client's Meta buyer", async () => {
    const { startRun } = await import("@/lib/launch-sheet/runs");
    const src = { kind: "link" as const, url: "https://docs.google.com/spreadsheets/d/x", name: "Sheet" };
    expect(await startRun(fakeAdmin(base()).admin, "c1", "gbuyer", src, "client_chat")).toEqual({ error: expect.stringMatching(/Head of Meta/) });
    expect(await startRun(fakeAdmin(base()).admin, "c1", "designer", src, "kaizen_ai")).toEqual({ error: expect.stringMatching(/Head of Meta/) });
    expect(await startRun(fakeAdmin(base()).admin, "c1", "mbuyer", src, "client_chat")).toEqual({ id: "new-launch_runs" });
    expect(await startRun(fakeAdmin(base()).admin, "c1", "hmeta", src, "client_chat")).toEqual({ id: "new-launch_runs" });
  });
});

describe("Google launch deploy", () => {
  it("a Meta buyer, the Head of Meta and the creative team never reach Google", async () => {
    const { applyGoogleRun } = await import("@/lib/google-launch/runs");
    for (const by of ["mbuyer", "hmeta", "hcreative", "designer", "copy"]) {
      const { admin } = fakeAdmin(base());
      const r = await applyGoogleRun(admin, "run-google", by);
      expect(r).toEqual({ blocked: expect.stringMatching(/Launching in Google Ads is for the Head of Google/) });
    }
    expect(bulk).not.toHaveBeenCalled();
  });

  it("starting one is refused for the Meta side and allowed for the client's Google buyer", async () => {
    const { startGoogleRun } = await import("@/lib/google-launch/runs");
    expect(await startGoogleRun(fakeAdmin(base()).admin, "c1", "mbuyer", { request: "Launch a new ad group" })).toEqual({ error: expect.stringMatching(/Head of Google/) });
    expect(await startGoogleRun(fakeAdmin(base()).admin, "c1", "hcreative", { request: "Launch a new ad group" })).toEqual({ error: expect.stringMatching(/Head of Google/) });
    expect(await startGoogleRun(fakeAdmin(base()).admin, "c1", "gbuyer", { request: "Launch a new ad group" })).toEqual({ id: "new-launch_runs" });
  });
});

describe("applyChange per platform", () => {
  const staff = (id: string) => {
    const p = profiles.find((x) => x.id === id)!;
    return { kind: "staff" as const, id, email: "", fullName: id, avatarUrl: null, role: p.role as import("@/lib/roles").TeamRole, isExec: p.is_exec, isLead: p.role.startsWith("head_of"), isCreative: false, isBuyer: false, isCopywriter: false, isCoordinator: false };
  };

  it("Meta changes: refused for the Google side, the creative team and a Meta buyer not on the client", async () => {
    const { applyChange } = await import("@/lib/ad-changes");
    for (const id of ["gbuyer", "hgoogle", "hcreative", "designer", "copy", "mbuyer2"]) {
      const { admin, writes } = fakeAdmin(base());
      await expect(applyChange(admin, "ch-meta", staff(id))).rejects.toThrow(/Changing the Meta account is for the Head of Meta/);
      expect(writes).toEqual([]);
    }
  });

  it("Meta changes: allowed for the client's Meta buyer, the Head of Meta and an exec", async () => {
    const { applyChange } = await import("@/lib/ad-changes");
    for (const id of ["mbuyer", "hmeta", "exec"]) await expect(applyChange(fakeAdmin(base()).admin, "ch-meta", staff(id))).resolves.toBeTypeOf("string");
  });

  it("Google changes: refused for the Meta side and the creative team, allowed for the client's Google buyer", async () => {
    const { applyChange } = await import("@/lib/ad-changes");
    for (const id of ["mbuyer", "hmeta", "hcreative"]) await expect(applyChange(fakeAdmin(base()).admin, "ch-google", staff(id))).rejects.toThrow(/Changing the Google Ads account is for the Head of Google/);
    for (const id of ["gbuyer", "hgoogle"]) await expect(applyChange(fakeAdmin(base()).admin, "ch-google", staff(id))).resolves.toBeTypeOf("string");
  });

  it("a chat plan isn't even started for someone who can't change that account", async () => {
    const { startChatChange } = await import("@/lib/chat-changes");
    expect(await startChatChange(fakeAdmin(base()).admin, "c1", "gbuyer", "meta", "Pause the prospecting campaign")).toEqual({ error: expect.stringMatching(/Head of Meta/) });
    expect(await startChatChange(fakeAdmin(base()).admin, "c1", "designer", "google", "Pause the brand campaign")).toEqual({ error: expect.stringMatching(/Head of Google/) });
    expect(await startChatChange(fakeAdmin(base()).admin, "c1", "hcreative", "team", "Make someone the Meta buyer")).toEqual({ error: expect.stringMatching(/media buyer is for the executives/) });
    expect(await startChatChange(fakeAdmin(base()).admin, "c1", "mbuyer", "meta", "Pause the prospecting campaign")).toEqual({ id: "new-ad_changes" });
  });
});

describe("brief generation", () => {
  const as = (role: string) => (signedIn.me = { kind: "staff", id: role, role, isExec: role === "executive", isLead: role.startsWith("head_of"), fullName: role, email: "" });

  it("the copywriter can't get even a quick preview", async () => {
    as("copywriter");
    const { previewBrief } = await import("@/app/(team)/quick-brief-actions");
    const r = await previewBrief("00000000-0000-0000-0000-000000000001", { kind: "idea", label: "x", text: "y" } as unknown as import("@/lib/quick-brief").BriefSource);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/As the copywriter you can write the copy/) });
  });

  it("customer success can't either", async () => {
    as("customer_success");
    const { previewBrief } = await import("@/app/(team)/quick-brief-actions");
    const r = await previewBrief("00000000-0000-0000-0000-000000000001", { kind: "idea", label: "x", text: "y" } as unknown as import("@/lib/quick-brief").BriefSource);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Briefs are for the creative team/) });
  });

  it("a request in someone else's format is refused before the AI writes it", async () => {
    const { ideaDraft } = await import("@/app/(team)/requests/new/actions");
    as("graphic_designer");
    expect(await ideaDraft({ kind: "market", adId: "a1" }, "c1", "video")).toEqual({ ok: false, error: expect.stringMatching(/^Video briefs are for the video editors/) });
    as("video_editor");
    expect(await ideaDraft({ kind: "market", adId: "a1" }, "c1", "carousel")).toEqual({ ok: false, error: expect.stringMatching(/^Image and carousel briefs/) });
    as("copywriter");
    expect(await ideaDraft({ kind: "market", adId: "a1" }, "c1", "image")).toEqual({ ok: false, error: expect.stringMatching(/copywriter/) });
  });

  it("the full brief from a quick preview is refused for the copywriter", async () => {
    as("copywriter");
    const { startBrief, retryBriefJob } = await import("@/app/(team)/brief-job-actions");
    const seed = { title: "T", formats: [{ format: "image", new: 1, variations: 0 }] } as unknown as import("@/lib/quick-brief").QuickBrief;
    expect(await startBrief("00000000-0000-0000-0000-000000000001", { kind: "idea", label: "x", text: "y" } as unknown as import("@/lib/quick-brief").BriefSource, seed, false)).toEqual({ ok: false, error: expect.stringMatching(/copywriter/) });
    expect(await retryBriefJob("00000000-0000-0000-0000-000000000002")).toEqual({ ok: false, error: expect.stringMatching(/copywriter/) });
  });
});
