import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { accountFromPath, checkDebugToken, encryptionKey, isWriteCall, pickToken, redactTokens, seal, unseal, type TokenReach } from "@/lib/meta-token-core";

// Client Business Manager tokens: encrypted at rest, never in any text that leaves the server, used only for the ad
// accounts they reach (and for writes, only where they can manage), and only when they're Kaizen's app with the right
// permissions.

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
  const reach: TokenReach[] = [
    { tokenId: "zen", account: "111", canManage: true, status: "active", createdAt: "2026-11-01" },
    { tokenId: "zen", account: "222", canManage: false, status: "active", createdAt: "2026-11-01" },
    { tokenId: "old", account: "333", canManage: true, status: "invalid", createdAt: "2026-10-01" },
  ];
  it("a covered account uses the client token", () => {
    expect(pickToken("111", reach, false)).toBe("zen");
    expect(pickToken("act_111", reach, true)).toBe("zen");
  });
  it("an uncovered account uses Kaizen's own (null)", () => {
    expect(pickToken("999", reach, false)).toBeNull();
    expect(pickToken(null, reach, false)).toBeNull();
  });
  it("a write needs a token that can manage the account", () => {
    expect(pickToken("222", reach, false)).toBe("zen");
    expect(pickToken("222", reach, true)).toBeNull();
  });
  it("an invalid or revoked token is never used", () => {
    expect(pickToken("333", reach, false)).toBeNull();
    expect(pickToken("333", reach, true)).toBeNull();
  });
  it("prefers a token that can manage, then the newest", () => {
    const two: TokenReach[] = [
      { tokenId: "a", account: "5", canManage: false, status: "active", createdAt: "2026-11-05" },
      { tokenId: "b", account: "5", canManage: true, status: "active", createdAt: "2026-11-01" },
      { tokenId: "c", account: "5", canManage: true, status: "active", createdAt: "2026-11-03" },
    ];
    expect(pickToken("5", two, false)).toBe("c");
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
