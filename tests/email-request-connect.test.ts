import { describe, expect, it, vi } from "vitest";

// Issue #139 (Nov 24 2026): "Create in Asana" on an approved copy did nothing visible. Asana tasks go in as the person
// who asks, and someone who hadn't connected their own Asana was refused, after the Google Doc was already made, with
// the message far down the page. Now they're asked to connect first, and nothing is made until they have.

vi.mock("server-only", () => ({}));
const approveCopyDoc = vi.fn();
vi.mock("@/lib/copy-docs/server", () => ({ approveCopyDoc, clientFacts: vi.fn(), loadCopyDoc: vi.fn() }));
const asanaAsPerson = vi.fn();
vi.mock("@/lib/asana-user", () => ({ hasMyAsana: vi.fn(async (_admin: unknown, id: string) => id === "connected"), asanaAsPerson }));

describe("an email request for someone without their own Asana", () => {
  it("asks them to connect first, before any Doc or task is made", async () => {
    const { createRequests } = await import("@/lib/deliverables/server");
    const { newRun } = await import("@/lib/deliverables/engine");
    const { lineOf } = await import("@/lib/deliverables/lines");
    const { ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
    const cfg = lineOf("email")!;
    const state = { ...newRun("email", { id: "c1", name: "OceanBox" }), docId: "d1" };
    const me = { id: "niro", fullName: "Niro", email: "niro@example.com" };
    const r = await createRequests({} as never, {} as never, me, { id: "r1", state, cfg });
    expect(r).toEqual({ ok: false, error: ASANA_CONNECT_SAY, connect: true });
    expect(approveCopyDoc).not.toHaveBeenCalled();
    expect(asanaAsPerson).not.toHaveBeenCalled();

    asanaAsPerson.mockResolvedValueOnce({ ok: true, doc: "", tasks: [], fieldsMissing: [], followerMissing: null });
    await createRequests({} as never, {} as never, { ...me, id: "connected" }, { id: "r1", state, cfg });
    expect(asanaAsPerson).toHaveBeenCalledTimes(1);
  });
});
