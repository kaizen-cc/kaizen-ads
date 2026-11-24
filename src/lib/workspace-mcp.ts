import "server-only";
import {
  argsFor,
  initializeBody,
  MCP_PROTOCOL,
  readRpc,
  rpc,
  toolErrorText,
  toolValue,
  WORKSPACE_MCP_SCOPES,
  WORKSPACE_MCP_URL,
  workspaceMcpMode,
  type ToolResult,
  type WorkspaceServer,
} from "./workspace-mcp-core";

// Our own MCP client for Google's Workspace MCP servers. Every Workspace action an AI agent takes (the assistant in chat
// and on calls, Kaizen AI, agents, routines' agent steps) goes through here when WORKSPACE_MCP is on, as the person
// (a domain-wide-delegation token minted for their address, which Google's MCP servers accept without the "AI agent"
// OAuth client setting), so the agent tools keep their names and our rules (drafts not sends, confirm the folder,
// view-as read only) while the data path is the one Google's AI Tools Addendum requires. The token stays on our
// server: it is never handed to the model provider. See docs/WORKSPACE-MCP.md.

export { workspaceMcpMode } from "./workspace-mcp-core";
export const workspaceMcpOn = () => workspaceMcpMode() !== "off";

type Jwt = { getAccessToken: () => Promise<{ token?: string | null }> };
const CLIENTS = new Map<string, Jwt>();

/** A token for a person on one server, read only unless the action writes (google-auth-library caches it till expiry) */
async function tokenFor(server: WorkspaceServer, subject: string, write: boolean): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Google isn't connected to Kaizen OS.");
  const scopes = write ? [...WORKSPACE_MCP_SCOPES[server].read, ...WORKSPACE_MCP_SCOPES[server].write] : WORKSPACE_MCP_SCOPES[server].read;
  const k = `${server}|${subject}|${write ? "w" : "r"}`;
  let c = CLIENTS.get(k);
  if (!c) {
    const key = JSON.parse(raw) as {
      client_email: string;
      private_key: string;
    };
    const { JWT } = await import("google-auth-library");
    c = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes,
      subject,
    });
    if (CLIENTS.size > 400) CLIENTS.clear();
    CLIENTS.set(k, c);
  }
  const t = (await c.getAccessToken()).token;
  if (!t) throw new Error("Google didn't give a token");
  return t;
}

const SESSIONS = new Map<string, { id: string | null; at: number }>();
const SESSION_TTL_MS = 10 * 60_000;
let seq = 10;

/**
 * Every MCP request is a POST, so the server-wide view-as guard (which judges by method and URL) would refuse reads
 * too. This client decides itself: a write is refused while the owner views as someone (workspaceTool), and the
 * requests themselves go out on the unguarded fetch.
 */
async function post(url: string, token: string, body: unknown, session: string | null) {
  const { unguardedFetch } = await import("@/lib/view-as-fetch");
  return unguardedFetch()(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
}

/** A session with the server (initialize, then the initialized notice), kept ten minutes per person and server */
async function session(server: WorkspaceServer, subject: string, token: string): Promise<string | null> {
  const k = `${server}|${subject}`;
  const hit = SESSIONS.get(k);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.id;
  const url = WORKSPACE_MCP_URL[server];
  const res = await post(url, token, initializeBody(1), null);
  const text = await res.text();
  if (!res.ok) throw new Error(`Google ${server} MCP: ${res.status} ${text.slice(0, 200)}`);
  const id = res.headers.get("mcp-session-id");
  await post(url, token, rpc("notifications/initialized"), id).then((r) => r.body?.cancel());
  SESSIONS.set(k, { id, at: Date.now() });
  return id;
}

export class WorkspaceMcpError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "disabled" | "quota" | "tool" | "other",
  ) {
    super(message);
  }
}

const kindOf = (status: number, text: string): WorkspaceMcpError["kind"] =>
  status === 401 || status === 403
    ? /SERVICE_DISABLED|has not been used|is disabled|not enabled/i.test(text)
      ? "disabled"
      : "auth"
    : status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)
      ? "quota"
      : "other";

/**
 * Run one tool on a Workspace MCP server as this person. Writes (create_draft...) ask for the write scope; the caller
 * decides whether a write may run at all (a yes, a confirmed folder), as with every other writing tool.
 */
export async function workspaceTool(server: WorkspaceServer, subject: string, tool: string, args: Record<string, unknown>, opts: { write?: boolean } = {}): Promise<unknown> {
  if (opts.write) {
    const { flagViewAsBlocked, viewAsCookieNow } = await import("@/lib/view-as");
    const choice = await viewAsCookieNow();
    if (choice) {
      await flagViewAsBlocked();
      const { ViewAsReadOnlyError } = await import("@/lib/view-as-core");
      throw new ViewAsReadOnlyError(choice.name);
    }
  }
  const token = await tokenFor(server, subject, Boolean(opts.write));
  const url = WORKSPACE_MCP_URL[server];
  for (let attempt = 0; ; attempt++) {
    const sid = await session(server, subject, token);
    const id = ++seq;
    const res = await post(url, token, rpc("tools/call", { name: tool, arguments: args }, id), sid);
    const text = await res.text();
    // A session the server forgot (404/400 with a session id): start a new one once
    if ((res.status === 404 || (res.status === 400 && sid)) && attempt === 0) {
      SESSIONS.delete(`${server}|${subject}`);
      continue;
    }
    if (!res.ok) throw new WorkspaceMcpError(`Google ${server} MCP ${tool}: ${res.status} ${text.slice(0, 200)}`, kindOf(res.status, text));
    const msg = readRpc(res.headers.get("content-type"), text, id);
    if (!msg) throw new WorkspaceMcpError(`Google ${server} MCP ${tool}: no answer`, "other");
    if (msg.error) throw new WorkspaceMcpError(`Google ${server} MCP ${tool}: ${msg.error.message ?? "error"}`, kindOf(msg.error.code === -32001 ? 401 : 400, msg.error.message ?? ""));
    const r = (msg.result ?? {}) as ToolResult;
    if (r.isError) throw new WorkspaceMcpError(`Google ${server} MCP ${tool}: ${toolErrorText(r)}`, "tool");
    return toolValue(r);
  }
}

/** The tools a server offers this person (the owner's check after enabling the servers) */
export async function workspaceToolList(
  server: WorkspaceServer,
  subject: string,
): Promise<
  {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: unknown;
  }[]
> {
  const token = await tokenFor(server, subject, false);
  const sid = await session(server, subject, token);
  const id = ++seq;
  const res = await post(WORKSPACE_MCP_URL[server], token, rpc("tools/list", {}, id), sid);
  const text = await res.text();
  if (!res.ok) throw new WorkspaceMcpError(`Google ${server} MCP tools/list: ${res.status} ${text.slice(0, 300)}`, kindOf(res.status, text));
  const msg = readRpc(res.headers.get("content-type"), text, id);
  return ((msg?.result as { tools?: [] } | undefined)?.tools ?? []) as {
    name: string;
  }[];
}


const LISTS = new Map<string, { at: number; tools: Promise<{ name: string; inputSchema?: unknown }[]> }>();

/** A tool run with our arguments put under the names its schema uses (the tool list kept ten minutes per server) */
export async function workspaceCall(
  server: WorkspaceServer,
  subject: string,
  tool: string,
  want: Record<string, { names: string[]; value: unknown }>,
  opts: { write?: boolean } = {},
): Promise<unknown> {
  let hit = LISTS.get(server);
  if (!hit || Date.now() - hit.at > SESSION_TTL_MS) {
    hit = {
      at: Date.now(),
      tools: workspaceToolList(server, subject).catch(() => []),
    };
    LISTS.set(server, hit);
  }
  const schema = (await hit.tools).find((t) => t.name === tool || t.name.endsWith(`.${tool}`));
  return workspaceTool(server, subject, schema?.name ?? tool, argsFor(schema?.inputSchema, want), opts);
}
