import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountFromPath, checkDebugToken, encryptionKey, isWriteCall, ownersFrom, reachLine, redactTokens, routeToken, seal, unseal, type BmState, type RouteCtx, type TokenReach } from "@/lib/meta-token-core";

// Business Manager tokens: encrypted at rest, never in any text that leaves the server, used for the ad accounts of
// the clients that picked that Business Manager (Kaizen's own otherwise), and only when they're Kaizen's app with the
// right permissions.

const FAKE = `EAAB${"x7Y2kQ9".repeat(20)}`;

describe("token encryption", () => {
  const key = randomBytes(32);
  it("round trips", () => {
    const s = seal(FAKE, key);
    expect(s.ciphertext).not.toContain(FAKE.slice(0, 20));
    expect(unseal(s, key)).toBe(FAKE);
  });
  it("uses a fresh IV each time", () => {
    expect(seal(FAKE, key).iv).not.toBe(seal(FAKE, key).iv);
  });
  it("detects a changed ciphertext, tag or IV", () => {
    const s = seal(FAKE, key);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[0] ^= 1;
      return b.toString("base64");
    };
    expect(() => unseal({ ...s, ciphertext: flip(s.ciphertext) }, key)).toThrow();
    expect(() => unseal({ ...s, tag: flip(s.tag) }, key)).toThrow();
    expect(() => unseal({ ...s, iv: flip(s.iv) }, key)).toThrow();
  });
  it("refuses the wrong key", () => {
    expect(() => unseal(seal(FAKE, key), randomBytes(32))).toThrow();
  });
  it("reads the key from hex, base64 or a passphrase, and none when unset", () => {
    const k = randomBytes(32);
    expect(encryptionKey(k.toString("hex"))?.equals(k)).toBe(true);
    expect(encryptionKey(k.toString("base64"))?.equals(k)).toBe(true);
    expect(encryptionKey("a long passphrase someone typed")?.length).toBe(32);
    expect(encryptionKey(undefined)).toBeNull();
    expect(encryptionKey("  ")).toBeNull();
  });
});

describe("which token a call uses", () => {
  // Kaizen (default), ZenChange (connected), Get Me Friends (not connected), Blue Cherry Group (stopped working)
  const bms = new Map<string, BmState>([
    ["kaizen", { id: "kaizen", isDefault: true, status: "active", hasToken: false }],
    ["zen", { id: "zen", isDefault: false, status: "active", hasToken: true }],
    ["gmf", { id: "gmf", isDefault: false, status: "not_connected", hasToken: false }],
    ["blue", { id: "blue", isDefault: false, status: "invalid", hasToken: false }],
  ]);
  const reach: TokenReach[] = [
    { tokenId: "zen", account: "111", canManage: true },
    { tokenId: "zen", account: "222", canManage: false },
  ];
  // Client → Business Manager, by the accounts each client owns
  const owners = ownersFrom([
    { account: "act_111", bm: "zen" },
    { account: "222", bm: "zen" },
    { account: "333", bm: "zen" },
    { account: "444", bm: null },
    { account: "555", bm: "kaizen" },
    { account: "666", bm: "gmf" },
    { account: "777", bm: "blue" },
  ]);
  const ctx: RouteCtx = { owners, bms, reach };
  it("a client on a partner Business Manager reads and writes through its token", () => {
    expect(routeToken("111", false, ctx)).toEqual({ tokenId: "zen", owned: true });
    expect(routeToken("act_111", true, ctx)).toEqual({ tokenId: "zen", owned: true });
  });
  it("a client with no pick, or Kaizen picked, uses Kaizen's own", () => {
    expect(routeToken("444", false, ctx)).toEqual({ tokenId: null, owned: true });
    expect(routeToken("555", true, ctx)).toEqual({ tokenId: null, owned: true });
  });
  it("a Business Manager that isn't connected or stopped working falls back to Kaizen's", () => {
    expect(routeToken("666", false, ctx)).toEqual({ tokenId: null, owned: true });
    expect(routeToken("777", true, ctx)).toEqual({ tokenId: null, owned: true });
  });
  it("a write where the token is known to only view the account goes through Kaizen's; reads stay on the partner", () => {
    expect(routeToken("222", false, ctx).tokenId).toBe("zen");
    expect(routeToken("222", true, ctx).tokenId).toBeNull();
  });
  it("an account the last check didn't list is left for Meta to decide", () => {
    expect(routeToken("333", true, ctx).tokenId).toBe("zen");
  });
  it("an account no client owns uses Kaizen's own", () => {
    expect(routeToken("999", false, ctx)).toEqual({ tokenId: null, owned: false });
    expect(routeToken(null, false, ctx)).toEqual({ tokenId: null, owned: false });
  });
  it("one account on two clients: a partner pick wins over Kaizen's", () => {
    const o = ownersFrom([
      { account: "8", bm: null },
      { account: "act_8", bm: "zen" },
      { account: "8", bm: null },
    ]);
    expect(o.get("8")).toBe("zen");
  });
  it("says whether the chosen token reaches each account, in plain words", () => {
    const zen = { name: "ZenChange", isDefault: false, status: "active" as const, checked: true };
    expect(reachLine("111", zen, { canManage: true })).toEqual({ ok: true, text: "Reached via ZenChange · can change" });
    expect(reachLine("123", zen, null)).toEqual({ ok: false, text: "ZenChange's token can't see act_123: assign it to the system user in ZenChange's Business Manager" });
    expect(reachLine("222", zen, { canManage: false }).ok).toBe(false);
    expect(reachLine("1", { ...zen, checked: false }, null).ok).toBe(true);
    expect(reachLine("1", { ...zen, status: "not_connected" }, null).ok).toBe(false);
    expect(reachLine("1", { name: "Kaizen", isDefault: true, status: "active", checked: true }, null).ok).toBe(true);
  });
  it("reads the account from the path", () => {
    expect(accountFromPath("act_123/insights")).toBe("123");
    expect(accountFromPath("act_123")).toBe("123");
    expect(accountFromPath("me/adaccounts")).toBeNull();
    expect(accountFromPath("120200/ads")).toBeNull();
  });
  it("an insights POST is a read; other POSTs are writes", () => {
    expect(isWriteCall("act_1/insights", "POST")).toBe(false);
    expect(isWriteCall("act_1/campaigns", "POST")).toBe(true);
    expect(isWriteCall("act_1/campaigns", "GET")).toBe(false);
  });
});

describe("the Business Managers migration", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261109140000_meta_business_tokens.sql"), "utf8");
  it("seeds Kaizen as the default with no stored token, and the three partners not connected", () => {
    expect(sql).toMatch(/\('Kaizen', true, 0, 'active'\)/);
    expect(sql).toMatch(/\('ZenChange', false, 1, 'not_connected'\)/);
    expect(sql).toMatch(/\('Get Me Friends', false, 2, 'not_connected'\)/);
    expect(sql).toMatch(/\('Blue Cherry Group', false, 3, 'not_connected'\)/);
    expect(sql).toMatch(/on conflict \(name\) do nothing/);
  });
  it("gives each client a Business Manager (null: Kaizen) and keeps tokens server only", () => {
    expect(sql).toMatch(/add column if not exists meta_business uuid references public\.meta_business_tokens \(id\) on delete set null/);
    expect(sql).not.toMatch(/client_id/);
    expect(sql).toMatch(/revoke all on public\.meta_business_tokens from anon, authenticated/);
    expect(sql).toMatch(/is_default and token_ciphertext is null/);
  });
});
describe("redaction", () => {
  it("removes access_token and friends from URLs and bodies", () => {
    const s = redactTokens(`fetch failed https://graph.facebook.com/v24.0/act_1?fields=x&access_token=${FAKE}&appsecret_proof=abc123 {"input_token":"${FAKE}"}`);
    expect(s).not.toContain(FAKE);
    expect(s).not.toContain("abc123");
    expect(s).toContain("access_token=[redacted]");
    expect(s).toContain("fields=x");
  });
  it("removes token-shaped strings and exact secrets anywhere", () => {
    expect(redactTokens(`Meta said ${FAKE} is bad`)).toBe("Meta said [redacted] is bad");
    expect(redactTokens("token xyz-secret-123 here", ["xyz-secret-123"])).toBe("token [redacted] here");
  });
  it("redacts URL-encoded tokens", () => {
    expect(redactTokens(`access_token%3D${FAKE}`)).not.toContain(FAKE);
  });
});

describe("validating a pasted token", () => {
  const good = { app_id: "42", is_valid: true, expires_at: 0, scopes: ["ads_management", "ads_read", "business_management", "pages_show_list"] };
  it("accepts Kaizen's app with the permissions, never-expiring", () => {
    const r = checkDebugToken(good, "42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expiresAt).toBeNull();
      expect(r.missingSuggested).toEqual(["pages_read_engagement"]);
    }
  });
  it("refuses another app with a plain reason", () => {
    const r = checkDebugToken({ ...good, app_id: "7", application: "Other App" }, "42");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/another app/);
  });
  it("refuses missing permissions, naming them", () => {
    const r = checkDebugToken({ ...good, scopes: ["ads_read"] }, "42");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ads_management, business_management");
  });
  it("refuses invalid and expired tokens", () => {
    expect(checkDebugToken({ ...good, is_valid: false }, "42").ok).toBe(false);
    expect(checkDebugToken({ ...good, expires_at: Math.floor(Date.now() / 1000) - 60 }, "42").ok).toBe(false);
    expect(checkDebugToken(null, "42").ok).toBe(false);
  });
  it("reports a future expiry", () => {
    const at = Math.floor(Date.now() / 1000) + 86_400 * 30;
    const r = checkDebugToken({ ...good, expires_at: at }, "42");
    expect(r.ok && r.expiresAt).toBe(new Date(at * 1000).toISOString());
  });
});
