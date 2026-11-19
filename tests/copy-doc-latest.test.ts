import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { docKindsFor } from "@/lib/copy-docs/core";

// A request asked for on a later call or chat finds the copy without its id (issue #45)
function fakeDb(row: Record<string, unknown> | null) {
  const calls: [string, ...unknown[]][] = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["select", "in", "neq", "eq", "order", "limit"]) q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q);
  q.maybeSingle = async () => ({ data: row });
  return { db: { from: (t: string) => (calls.push(["from", t]), q) } as never, calls };
}

describe("the latest copy document", () => {
  it("maps each line to its document kinds", () => {
    expect(docKindsFor("email")).toEqual(["campaign", "flow", "sms"]);
    expect(docKindsFor("creative")).toEqual(["creative"]);
    expect(docKindsFor("social")).toEqual(["social"]);
  });
  it("picks the client's newest email copy that isn't requested yet", async () => {
    const { latestCopyDoc } = await import("@/lib/copy-docs/server");
    const { db, calls } = fakeDb({ id: "554a1ca1-0570-417d-ab2a-2eab22205894", client_id: "c1", created_by: "p", content: { kind: "campaign", title: "December", emails: [], brief: {} }, version: 2, status: "draft", updated_at: "2026-11-18", clients: { name: "OceanBox", slug: "oceanbox" } });
    const d = await latestCopyDoc(db, { line: "email", clientId: "c1", createdBy: "p" });
    expect(d?.id).toBe("554a1ca1-0570-417d-ab2a-2eab22205894");
    expect(d?.client).toBe("OceanBox");
    expect(calls).toContainEqual(["in", "kind", ["campaign", "flow", "sms"]]);
    expect(calls).toContainEqual(["neq", "status", "requested"]);
    expect(calls).toContainEqual(["eq", "client_id", "c1"]);
    expect(calls).toContainEqual(["order", "updated_at", { ascending: false }]);
  });
  it("falls back to the person's own when no client is named, and is null when there's none", async () => {
    const { latestCopyDoc } = await import("@/lib/copy-docs/server");
    const { db, calls } = fakeDb(null);
    expect(await latestCopyDoc(db, { line: "email", createdBy: "p" })).toBeNull();
    expect(calls).toContainEqual(["eq", "created_by", "p"]);
  });
});
