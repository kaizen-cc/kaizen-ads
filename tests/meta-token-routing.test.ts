import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Graph call goes out with the token of the Business Manager its account's client picked: ZenChange's for a
// client on ZenChange (writes only where it isn't known to be view only), Kaizen's own for clients on Kaizen and for
// accounts no client owns. The token never shows in an error.

vi.mock("server-only", () => ({}));
const ZEN = "EAAzenchange00000000000000000000000000000";
const KAIZEN = "EAAkaizen000000000000000000000000000000";
const via = { token: ZEN, tokenId: "zen", name: "ZenChange", businessId: "9", businessName: "ZenChange LLC" };
vi.mock("@/lib/meta-tokens", () => ({
  metaRoute: async (account: string, o: { write?: boolean }) => {
    // 111: client on ZenChange, can change · 222: on ZenChange, view only · 444: client on Kaizen · else: no client
    if (account === "111") return { hit: via, owned: true };
    if (account === "222") return { hit: o.write ? null : via, owned: true };
    if (account === "444") return { hit: null, owned: true };
    return { hit: null, owned: false };
  },
  partnerTokens: async () => [{ id: "zen", name: "ZenChange", token: ZEN }],
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
const UNSEEN = { error: { message: "Unsupported get request. Object with ID '5' does not exist", code: 100, error_subcode: 33 } };

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = KAIZEN;
});
afterEach(() => vi.restoreAllMocks());

describe("Graph token routing", () => {
  it("a client on a partner Business Manager reads and writes with its token", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_111/campaigns", { fields: "name" });
    await metaGraph("act_111/campaigns", { name: "x" }, "POST", { account: "111", write: true });
    expect(calls.map((c) => c.token)).toEqual([ZEN, ZEN]);
  });
  it("a client on Kaizen, an account no client owns and calls tied to no account use Kaizen's own", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_444/ads", {});
    await metaGraph("act_999/ads", {});
    await metaGraph("me/permissions", {});
    expect(calls.map((c) => c.token)).toEqual([KAIZEN, KAIZEN, KAIZEN]);
  });
  it("a write the partner token can only view goes through Kaizen's own", async () => {
    respond(() => ({ id: "1" }));
    await metaGraph("act_222", {});
    await metaGraph("act_222/campaigns", { name: "x" }, "POST");
    expect(calls.map((c) => c.token)).toEqual([ZEN, KAIZEN]);
  });
  it("an object read inside an account scope uses that account's token", async () => {
    respond(() => ({ id: "1" }));
    await withMetaAccount("111", () => metaGraph("120000123", { fields: "name" }));
    expect(calls[0].token).toBe(ZEN);
  });
  it("a partner token that can't see an object is read with Kaizen's own", async () => {
    respond((token) => (token === ZEN ? UNSEEN : { name: "ad" }));
    expect(await withMetaAccount("111", () => metaGraph<{ name: string }>("5", { fields: "name" }))).toEqual({ name: "ad" });
    expect(calls.map((c) => c.token)).toEqual([ZEN, KAIZEN]);
  });
  it("an object or unowned account Kaizen's token can't see is read with a partner token, once", async () => {
    respond((token) => (token === KAIZEN ? UNSEEN : { name: "ad" }));
    expect(await metaGraph<{ name: string }>("5", { fields: "name" })).toEqual({ name: "ad" });
    expect(await metaGraph<{ name: string }>("act_999", { fields: "name" })).toEqual({ name: "ad" });
    expect(calls.map((c) => c.token)).toEqual([KAIZEN, ZEN, KAIZEN, ZEN]);
  });
  it("a client on Kaizen never borrows a partner's token", async () => {
    respond(() => UNSEEN);
    await expect(metaGraph("act_444", { fields: "name" })).rejects.toThrow();
    expect(calls.map((c) => c.token)).toEqual([KAIZEN]);
  });
  it("never falls back on a write", async () => {
    respond(() => ({ error: { message: "Unsupported post request", code: 100, error_subcode: 33 } }));
    await expect(metaGraph("5", { status: "PAUSED" }, "POST")).rejects.toThrow();
    await expect(metaGraph("act_111/campaigns", { name: "x" }, "POST")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it("keeps the token out of errors", async () => {
    respond(() => ({ error: { message: `Bad request for access_token=${ZEN}`, code: 100 } }));
    const e = await metaGraph("act_111", {}).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain(ZEN);
  });
});