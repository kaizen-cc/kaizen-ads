import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Graph call goes out with the token that reaches its ad account: a client business's for accounts it covers
// (writes only where it can manage), Kaizen's own for everything else. The token never shows in an error.

vi.mock("server-only", () => ({}));
const CLIENT = "EAAclient000000000000000000000000000000";
const KAIZEN = "EAAkaizen000000000000000000000000000000";
vi.mock("@/lib/meta-tokens", () => ({
  metaTokenFor: async (account: string, o: { write?: boolean }) => {
    if (account === "111") return { token: CLIENT, tokenId: "t", businessId: "9", businessName: "ZenChange" };
    if (account === "222" && !o.write) return { token: CLIENT, tokenId: "t", businessId: "9", businessName: "ZenChange" };
    return null;
  },
  clientTokens: async () => [CLIENT],
}));

const { metaGraph, withMetaAccount } = await import("@/lib/context/meta");

let calls: { url: string; body: string; token: string }[] = [];
const respond = (fn: (token: string, url: string) => unknown) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : "";
    const token = new URLSearchParams(url.split("?")[1] ?? body).get("access_token") ?? "";
    calls.push({ url, body, token });
    return new Response(JSON.stringify(fn(token, url)));
  });

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = KAIZEN;
});
afterEach(() => vi.restoreAllMocks());

describe("Graph token routing", () => {
  it("a covered account reads and writes with the client token", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_111/campaigns", { fields: "name" });
    await metaGraph("act_111/campaigns", { name: "x" }, "POST", { account: "111", write: true });
    expect(calls.map((c) => c.token)).toEqual([CLIENT, CLIENT]);
  });
  it("an uncovered account and calls tied to no account use Kaizen's own", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_999/ads", {});
    await metaGraph("me/permissions", {});
    expect(calls.map((c) => c.token)).toEqual([KAIZEN, KAIZEN]);
  });
  it("a write to an account the client token only reads uses Kaizen's own", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_222", {});
    await metaGraph("act_222/campaigns", { name: "x" }, "POST");
    expect(calls.map((c) => c.token)).toEqual([CLIENT, KAIZEN]);
  });
  it("an object read inside an account scope uses that account's token", async () => {
    respond(() => ({ id: "1" }));
    await withMetaAccount("111", () => metaGraph("120000123", { fields: "name" }));
    expect(calls[0].token).toBe(CLIENT);
  });
  it("an object Kaizen's token can't see is read with a client token, once", async () => {
    respond((token) => (token === KAIZEN ? { error: { message: "Unsupported get request. Object with ID '5' does not exist", code: 100, error_subcode: 33 } } : { name: "ad" }));
    expect(await metaGraph<{ name: string }>("5", { fields: "name" })).toEqual({ name: "ad" });
    expect(calls.map((c) => c.token)).toEqual([KAIZEN, CLIENT]);
  });
  it("never falls back on a write", async () => {
    respond(() => ({ error: { message: "Unsupported post request", code: 100, error_subcode: 33 } }));
    await expect(metaGraph("5", { status: "PAUSED" }, "POST")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("keeps the token out of errors", async () => {
    respond(() => ({ error: { message: `Bad request for access_token=${CLIENT}`, code: 100 } }));
    const e = await metaGraph("act_111", {}).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain(CLIENT);
  });
});
