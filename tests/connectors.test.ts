import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  authServerMetadataUrls,
  connectorError,
  isWriteTool,
  keyFrom,
  mcpPayload,
  offeredTo,
  pkceChallenge,
  pkcePair,
  protectedResourceUrls,
  resourceMetadataFrom,
  safeReturn,
  serversNamed,
  signState,
  threadKeys,
  tokenDecision,
  toolMetaFrom,
  verifyState,
  type Ready,
} from "@/lib/connectors/core";

describe("PKCE", () => {
  it("makes a 43 character verifier and its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
    expect(challenge).not.toContain("=");
  });
  it("matches RFC 7636's example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("the signed state", () => {
  const secret = "s".repeat(32);
  const s = { p: "person", c: "connector", n: "nonce", exp: Date.now() + 60_000, r: "/ai?t=1" };
  it("comes back as it was signed", () => {
    expect(verifyState(signState(s, secret), secret)).toEqual(s);
  });
  it("refuses a changed body, another secret, or an expired one", () => {
    const t = signState(s, secret);
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, p: "someone else" })).toString("base64url");
    expect(verifyState(`${forged}.${mac}`, secret)).toBeNull();
    expect(verifyState(`${body}.${mac}x`, secret)).toBeNull();
    expect(verifyState(t, "another secret")).toBeNull();
    expect(verifyState(signState({ ...s, exp: Date.now() - 1 }, secret), secret)).toBeNull();
    expect(verifyState("nonsense", secret)).toBeNull();
  });
  it("only returns into the app", () => {
    expect(safeReturn("/ai?t=abc")).toBe("/ai?t=abc");
    expect(safeReturn("/settings?tab=my-connections")).toBe("/settings?tab=my-connections");
    expect(safeReturn("https://evil.example")).toBeNull();
    expect(safeReturn("//evil.example/ai")).toBeNull();
    expect(safeReturn("/aiming")).toBeNull();
  });
});

describe("token refresh decision", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("uses a token with no expiry or time left", () => {
    expect(tokenDecision({ expiresAt: null, hasRefresh: false }, now)).toBe("use");
    expect(tokenDecision({ expiresAt: "2026-11-10T13:00:00Z", hasRefresh: true }, now)).toBe("use");
  });
  it("refreshes one that has run out or is about to", () => {
    expect(tokenDecision({ expiresAt: "2026-11-10T11:00:00Z", hasRefresh: true }, now)).toBe("refresh");
    expect(tokenDecision({ expiresAt: "2026-11-10T12:01:00Z", hasRefresh: true }, now)).toBe("refresh");
  });
  it("asks to reconnect when it can't refresh", () => {
    expect(tokenDecision({ expiresAt: "2026-11-10T11:00:00Z", hasRefresh: false }, now)).toBe("reconnect");
  });
});

describe("who sees a connector", () => {
  it("offers to everyone, to listed roles, and to execs; never when it's off", () => {
    expect(offeredTo({ roles: null, enabled: true }, "copywriter")).toBe(true);
    expect(offeredTo({ roles: [], enabled: true }, "copywriter")).toBe(true);
    expect(offeredTo({ roles: ["media_buyer"], enabled: true }, "media_buyer")).toBe(true);
    expect(offeredTo({ roles: ["media_buyer"], enabled: true }, "copywriter")).toBe(false);
    expect(offeredTo({ roles: ["media_buyer"], enabled: true }, "executive", true)).toBe(true);
    expect(offeredTo({ roles: null, enabled: false }, "executive", true)).toBe(false);
  });
  it("keys connectors in lowercase", () => {
    expect(keyFrom("Shopify")).toBe("shopify");
    expect(keyFrom("Google Drive")).toBe("google-drive");
    expect(keyFrom("123 Tool")).toBe("c-123-tool");
  });
});

describe("which tools write", () => {
  it("follows the server's hints, then the name", () => {
    expect(isWriteTool({ name: "delete_order", readOnly: true, destructive: null })).toBe(false);
    expect(isWriteTool({ name: "get_orders", readOnly: null, destructive: true })).toBe(true);
    expect(isWriteTool({ name: "get_orders", readOnly: null, destructive: null })).toBe(false);
    expect(isWriteTool({ name: "create_discount", readOnly: null, destructive: null })).toBe(true);
    expect(isWriteTool({ name: "refundOrder", readOnly: null, destructive: null })).toBe(true);
    expect(isWriteTool({ name: "orders.cancel", readOnly: false, destructive: false })).toBe(true);
  });
  it("reads tools/list", () => {
    expect(toolMetaFrom([{ name: "search", description: "Find", annotations: { readOnlyHint: true } }, { nope: 1 }])).toEqual([{ name: "search", title: null, about: "Find", readOnly: true, destructive: null }]);
  });
});

describe("the mcp_servers payload from a thread's switches", () => {
  const shopify: Ready = {
    key: "shopify",
    name: "Shopify",
    url: "https://shop.example/mcp",
    token: "tok-1",
    tools: [
      { name: "get_orders", readOnly: true, destructive: false },
      { name: "refund_order", readOnly: false, destructive: true },
    ],
  };
  const drive: Ready = { key: "drive", name: "Drive", url: "https://drive.example/mcp", token: null, tools: [] };

  it("is every connected one when the thread never set its own, else only what it switched on", () => {
    expect(threadKeys(null, ["shopify", "drive"])).toEqual(["shopify", "drive"]);
    expect(threadKeys(["drive"], ["shopify", "drive"])).toEqual(["drive"]);
    expect(threadKeys([], ["shopify", "drive"])).toEqual([]);
    expect(threadKeys(["asana"], ["shopify"])).toEqual([]);
  });
  it("names each server by its key, with the person's token, and one toolset each", () => {
    const p = mcpPayload([shopify, drive]);
    expect(p.servers).toEqual([
      { type: "url", url: "https://shop.example/mcp", name: "shopify", authorization_token: "tok-1" },
      { type: "url", url: "https://drive.example/mcp", name: "drive" },
    ]);
    expect(p.toolsets.map((t) => t.mcp_server_name)).toEqual(["shopify", "drive"]);
  });
  it("keeps writes off unless that exact tool was approved", () => {
    expect(mcpPayload([shopify]).toolsets[0].configs).toEqual({ refund_order: { enabled: false } });
    expect(mcpPayload([shopify], { key: "shopify", tool: "refund_order" }).toolsets[0].configs).toBeUndefined();
    expect(mcpPayload([shopify], { key: "drive", tool: "refund_order" }).toolsets[0].configs).toEqual({ refund_order: { enabled: false } });
  });
  it("leaves out a repeated key", () => {
    expect(mcpPayload([shopify, shopify]).servers).toHaveLength(1);
  });
});

describe("discovery", () => {
  it("reads resource_metadata from WWW-Authenticate", () => {
    expect(resourceMetadataFrom('Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"')).toBe("https://x.example/.well-known/oauth-protected-resource");
    expect(resourceMetadataFrom("Bearer")).toBeNull();
  });
  it("looks in the well-known places", () => {
    expect(protectedResourceUrls("https://x.example/mcp")).toEqual(["https://x.example/.well-known/oauth-protected-resource/mcp", "https://x.example/.well-known/oauth-protected-resource"]);
    expect(authServerMetadataUrls("https://auth.example")).toEqual(["https://auth.example/.well-known/oauth-authorization-server", "https://auth.example/.well-known/openid-configuration"]);
    expect(authServerMetadataUrls("https://auth.example/tenant")[0]).toBe("https://auth.example/.well-known/oauth-authorization-server/tenant");
  });
  it("builds the authorization URL with PKCE and the resource", () => {
    const u = new URL(authorizeUrl({ authorization_endpoint: "https://auth.example/authorize" }, { clientId: "c", redirectUri: "https://app/cb", state: "s", challenge: "ch", scope: null, resource: "https://x.example/mcp" }));
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: "c", redirect_uri: "https://app/cb", state: "s", code_challenge: "ch", code_challenge_method: "S256", resource: "https://x.example/mcp" });
  });
});

describe("errors in plain words", () => {
  it("says to reconnect on a sign in problem", () => {
    expect(connectorError("MCP server returned 401 Unauthorized", "Shopify").reconnect).toBe(true);
    expect(connectorError("connection timed out", "Shopify")).toEqual({ text: "Shopify isn't answering right now. Try again in a bit.", reconnect: false });
  });
  it("finds the server an API error names", () => {
    expect(serversNamed("Failed to connect to MCP server 'shopify'", ["shopify", "drive"])).toEqual(["shopify"]);
    expect(serversNamed("Something else", ["shopify"])).toEqual([]);
  });
});
