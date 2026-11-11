import { describe, expect, it } from "vitest";
import { appSetupFor, appStepText, authFromProbe } from "@/lib/connectors/shared";
import { authMetaFrom, clientMetadataDocument, clientRoute, discoverWith, type Net } from "@/lib/connectors/discovery";

// Metadata shapes recorded from the live servers (Nov 11 2026), trimmed to what discovery reads.

const ASANA_V1_PRM = { resource: "https://mcp.asana.com", authorization_servers: ["https://mcp.asana.com"], scopes_supported: ["default"], bearer_methods_supported: ["header"] };
const ASANA_V1_AS = {
  issuer: "https://mcp.asana.com",
  authorization_endpoint: "https://mcp.asana.com/authorize",
  token_endpoint: "https://mcp.asana.com/token",
  registration_endpoint: "https://mcp.asana.com/register",
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  code_challenge_methods_supported: ["plain", "S256"],
};
const ASANA_V2_PRM = { resource: "https://mcp.asana.com/v2/mcp", authorization_servers: ["https://app.asana.com"], scopes_supported: ["default"] };
const ASANA_V2_AS = {
  issuer: "https://app.asana.com",
  authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
  token_endpoint: "https://app.asana.com/-/oauth_token",
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  code_challenge_methods_supported: ["S256"],
};
const CANVA_AS = {
  issuer: "https://mcp.canva.com",
  authorization_endpoint: "https://mcp.canva.com/authorize",
  token_endpoint: "https://mcp.canva.com/token",
  registration_endpoint: "https://mcp.canva.com/register",
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  client_id_metadata_document_supported: true,
};
const MONDAY_PRM = { resource: "https://mcp.monday.com/mcp", authorization_servers: ["https://auth.monday.com/mcp"], bearer_methods_supported: ["header"] };
const MONDAY_AS = {
  issuer: "https://auth.monday.com/mcp",
  authorization_endpoint: "https://auth.monday.com/oauth2/authorize",
  token_endpoint: "https://auth.monday.com/oauth_ms/oauth/token",
  registration_endpoint: "https://auth.monday.com/oauth_ms/oauth/register",
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
  client_id_metadata_document_supported: true,
};
const GITHUB_PRM = { resource: "https://api.githubcopilot.com/mcp", authorization_servers: ["https://github.com/login/oauth"], scopes_supported: ["repo", "read:org"] };
const GITHUB_OIDC = { issuer: "https://github.com/login/oauth", authorization_endpoint: "https://github.com/login/oauth/authorize", token_endpoint: "https://github.com/login/oauth/access_token" };

/** A network that answers from a table: GETs by URL, and the initialize probe's status and WWW-Authenticate */
function fakeNet(json: Record<string, unknown>, probe: { status: number; wwwAuthenticate: string | null } | null): Net & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    json: async (u) => {
      asked.push(u);
      return (json[u] as Record<string, unknown> | undefined) ?? null;
    },
    probe: async () => probe,
  };
}

describe("discovery: recorded servers", () => {
  it("Asana v1 (mcp.asana.com/mcp): the 401 points at the root resource metadata; its server registers apps itself", async () => {
    const net = fakeNet(
      { "https://mcp.asana.com/.well-known/oauth-protected-resource": ASANA_V1_PRM, "https://mcp.asana.com/.well-known/oauth-authorization-server": ASANA_V1_AS },
      { status: 401, wwwAuthenticate: 'Bearer realm="OAuth", resource_metadata="https://mcp.asana.com/.well-known/oauth-protected-resource", error="invalid_token"' },
    );
    const d = await discoverWith(net, "https://mcp.asana.com/mcp");
    expect(d).toMatchObject({ reachable: true, signIn: true, dcr: true, cimd: false, route: "dcr" });
    expect(d.meta?.registration_endpoint).toBe("https://mcp.asana.com/register");
    expect(d.meta?.scopes).toBe("default");
    expect(authFromProbe(d)).toBe("oauth");
  });

  it("Asana v2 (mcp.asana.com/v2/mcp): path-suffixed metadata names app.asana.com, which has no registration, so it needs the app", async () => {
    const net = fakeNet(
      { "https://mcp.asana.com/.well-known/oauth-protected-resource/v2/mcp": ASANA_V2_PRM, "https://app.asana.com/.well-known/oauth-authorization-server": ASANA_V2_AS },
      { status: 401, wwwAuthenticate: 'Bearer realm="Asana MCP", resource_metadata="https://mcp.asana.com/.well-known/oauth-protected-resource/v2"' },
    );
    const d = await discoverWith(net, "https://mcp.asana.com/v2/mcp");
    // The header's URL 404s; the path-suffixed well-known one answers
    expect(net.asked.slice(0, 2)).toEqual(["https://mcp.asana.com/.well-known/oauth-protected-resource/v2", "https://mcp.asana.com/.well-known/oauth-protected-resource/v2/mcp"]);
    expect(d).toMatchObject({ signIn: true, dcr: false, cimd: false, route: "app" });
    expect(d.meta?.issuer).toBe("https://app.asana.com");
    expect(authFromProbe(d)).toBe("oauth_client");
  });

  it("Canva: the server takes a Client ID Metadata Document, so that wins over registering", async () => {
    const net = fakeNet(
      { "https://mcp.canva.com/.well-known/oauth-protected-resource/mcp": { resource: "https://mcp.canva.com/mcp", authorization_servers: ["https://mcp.canva.com"] }, "https://mcp.canva.com/.well-known/oauth-authorization-server": CANVA_AS },
      { status: 401, wwwAuthenticate: "Bearer" },
    );
    const d = await discoverWith(net, "https://mcp.canva.com/mcp");
    expect(d).toMatchObject({ cimd: true, dcr: true, route: "cimd" });
    expect(authFromProbe(d)).toBe("oauth");
  });

  it("monday: an issuer with a path (auth.monday.com/mcp) is read at the path-suffixed RFC 8414 address", async () => {
    const net = fakeNet(
      { "https://mcp.monday.com/.well-known/oauth-protected-resource/mcp": MONDAY_PRM, "https://auth.monday.com/.well-known/oauth-authorization-server/mcp": MONDAY_AS },
      { status: 401, wwwAuthenticate: null },
    );
    const d = await discoverWith(net, "https://mcp.monday.com/mcp");
    expect(d.meta?.token_endpoint).toBe("https://auth.monday.com/oauth_ms/oauth/token");
    expect(d.route).toBe("cimd");
  });

  it("an issuer with a path that only has OpenID configuration (path inserted, then appended) is found too", async () => {
    const as = { issuer: "https://login.example.com/tenant", authorization_endpoint: "https://login.example.com/tenant/authorize", token_endpoint: "https://login.example.com/tenant/token", registration_endpoint: "https://login.example.com/tenant/register" };
    const net = fakeNet(
      { "https://x.example.com/.well-known/oauth-protected-resource": { resource: "https://x.example.com/", authorization_servers: ["https://login.example.com/tenant"] }, "https://login.example.com/tenant/.well-known/openid-configuration": as },
      { status: 401, wwwAuthenticate: null },
    );
    const d = await discoverWith(net, "https://x.example.com/");
    expect(d.route).toBe("dcr");
    expect(net.asked).toContain("https://login.example.com/.well-known/oauth-authorization-server/tenant");
    expect(net.asked).toContain("https://login.example.com/.well-known/openid-configuration/tenant");
  });

  it("GitHub: OpenID metadata without registration or metadata documents means the one-time app", async () => {
    const net = fakeNet(
      { "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp": GITHUB_PRM, "https://github.com/.well-known/openid-configuration/login/oauth": GITHUB_OIDC },
      { status: 401, wwwAuthenticate: null },
    );
    const d = await discoverWith(net, "https://api.githubcopilot.com/mcp/");
    expect(d.route).toBe("app");
    expect(d.meta?.authorization_endpoint).toBe("https://github.com/login/oauth/authorize");
  });

  it("tries the next authorization server when the first has no metadata", async () => {
    const net = fakeNet(
      { "https://y.example.com/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["https://dead.example.com", "https://mcp.asana.com"] }, "https://mcp.asana.com/.well-known/oauth-authorization-server": ASANA_V1_AS },
      { status: 401, wwwAuthenticate: null },
    );
    expect((await discoverWith(net, "https://y.example.com/mcp")).route).toBe("dcr");
  });

  it("a server that answers without asking for a sign in needs nothing; one that doesn't answer is unknown", async () => {
    const open = await discoverWith(fakeNet({}, { status: 200, wwwAuthenticate: null }), "https://open.example.com/mcp");
    expect(open).toMatchObject({ reachable: true, signIn: false, route: null });
    expect(authFromProbe(open)).toBe("none");
    const down = await discoverWith(fakeNet({}, null), "https://down.example.com/mcp");
    expect(authFromProbe(down)).toBeNull();
  });

  it("no metadata at all after a 401 falls back to the earlier spec's default endpoints, marked guessed", async () => {
    const d = await discoverWith(fakeNet({}, { status: 401, wwwAuthenticate: null }), "https://old.example.com/mcp");
    expect(d.meta).toMatchObject({ authorization_endpoint: "https://old.example.com/authorize", registration_endpoint: "https://old.example.com/register", guessed: true });
    expect(d.route).toBe("dcr");
  });
});

describe("how Kaizen AI gets a client id", () => {
  it("prefers an exec's app, then our metadata document, then registering, and only then the app step", () => {
    expect(clientRoute({ cimd: true, registration_endpoint: "https://r" }, { hasApp: true })).toBe("app");
    expect(clientRoute({ cimd: true, registration_endpoint: "https://r" })).toBe("cimd");
    expect(clientRoute({ cimd: false, registration_endpoint: "https://r" })).toBe("dcr");
    expect(clientRoute({ cimd: false, registration_endpoint: null })).toBe("app");
    expect(clientRoute(null)).toBe("app");
  });
  it("skips the metadata document when our address isn't https (the server couldn't fetch it)", () => {
    expect(clientRoute({ cimd: true, registration_endpoint: "https://r" }, { httpsOrigin: false })).toBe("dcr");
    expect(clientRoute({ cimd: true, registration_endpoint: null }, { httpsOrigin: false })).toBe("app");
  });
  it("ignores metadata without the two endpoints, and a registration endpoint that isn't https", () => {
    expect(authMetaFrom({ authorization_endpoint: "https://a" }, "https://i", null)).toBeNull();
    expect(authMetaFrom({ authorization_endpoint: "https://a/x", token_endpoint: "https://a/t", registration_endpoint: "http://a/r" }, "https://i", null)?.registration_endpoint).toBeNull();
  });
  it("serves a metadata document whose client_id is its own URL, with our callback", () => {
    const doc = clientMetadataDocument("https://ads.kaizenmarketing.agency/");
    expect(doc).toMatchObject({
      client_id: "https://ads.kaizenmarketing.agency/api/connectors/client-metadata.json",
      client_name: "Kaizen AI",
      redirect_uris: ["https://ads.kaizenmarketing.agency/api/connectors/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("the one-time app step", () => {
  it("links the vendor's developer page when known", () => {
    expect(appSetupFor("https://mcp.box.com")?.vendor).toBe("Box");
    expect(appSetupFor("https://api.githubcopilot.com/mcp/")?.vendor).toBe("GitHub");
    expect(appSetupFor("https://mcp.hubspot.com/anthropic")?.url).toMatch(/^https:\/\/developers\.hubspot\.com/);
    expect(appSetupFor("https://mcp.slack.com/mcp")?.url).toBe("https://api.slack.com/apps");
    expect(appSetupFor("https://mcp.xero.com/mcp")?.vendor).toBe("Xero");
    expect(appSetupFor("https://mcp.unknown.example/mcp")).toBeNull();
  });
  it("says it's once for the whole team, like Claude's partner app, and never asks for a secret", () => {
    const t = appStepText("Box");
    expect(t).toMatch(/once for the whole team, not per person/);
    expect(t).toMatch(/the way Claude has a partner app/);
    expect(t).not.toMatch(/secret/i);
    expect(t).not.toMatch(/—/);
  });
});
