// Google's Workspace MCP servers, the plain parts (no network) so they can be tested: where each server is, the scopes a
// token needs for it, the JSON-RPC bodies we send, and reading what comes back (JSON or an SSE stream, a tool's
// structured content or its text). Why: Google's Workspace AI Tools Addendum (Nov 24 2026, enforced Feb 1 2027)
// requires AI agents to reach Workspace data through Google's MCP servers, not the REST APIs. docs/WORKSPACE-MCP.md.

export type WorkspaceServer = "gmail" | "drive" | "calendar" | "docs" | "sheets" | "slides";

/** Google's endpoints (developers.google.com/workspace/guides/configure-mcp-servers) */
export const WORKSPACE_MCP_URL: Record<WorkspaceServer, string> = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  docs: "https://docsmcp.googleapis.com/mcp/v1",
  sheets: "https://sheetsmcp.googleapis.com/mcp/v1",
  slides: "https://slidesmcp.googleapis.com/mcp/v1",
};

const S = "https://www.googleapis.com/auth/";
/** The scopes a token asks for per server: reading, and writing for the few writes we allow (Gmail drafts) */
export const WORKSPACE_MCP_SCOPES: Record<WorkspaceServer, { read: string[]; write: string[] }> = {
  gmail: { read: [`${S}gmail.readonly`], write: [`${S}gmail.compose`] },
  drive: { read: [`${S}drive.readonly`], write: [`${S}drive`] },
  calendar: {
    read: [`${S}calendar.readonly`],
    write: [`${S}calendar.events`],
  },
  docs: {
    read: [`${S}drive.readonly`, `${S}documents.readonly`],
    write: [`${S}documents`],
  },
  sheets: {
    read: [`${S}drive.readonly`, `${S}spreadsheets.readonly`],
    write: [`${S}spreadsheets`],
  },
  slides: {
    read: [`${S}drive.readonly`, `${S}presentations.readonly`],
    write: [`${S}presentations`],
  },
};

/** Is the MCP path on? WORKSPACE_MCP=on routes agent Workspace actions through Google's MCP (REST stays as fallback) */
export function workspaceMcpMode(env: string | undefined = process.env.WORKSPACE_MCP): "off" | "on" | "only" {
  const v = String(env ?? "")
    .trim()
    .toLowerCase();
  if (v === "only") return "only";
  return v === "on" || v === "1" || v === "true" ? "on" : "off";
}

export const MCP_PROTOCOL = "2025-06-18";

export type RpcBody = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};
export const rpc = (method: string, params?: Record<string, unknown>, id?: number): RpcBody => ({
  jsonrpc: "2.0",
  ...(id !== undefined ? { id } : {}),
  method,
  ...(params ? { params } : {}),
});
export const initializeBody = (id = 1) =>
  rpc(
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "kaizen-os", version: "1.0" },
    },
    id,
  );

/** A JSON-RPC response from a plain JSON body or a Streamable HTTP event stream (the message with our id) */
export function readRpc(contentType: string | null, text: string, id: number): { result?: unknown; error?: { code?: number; message?: string } } | null {
  const pick = (v: unknown) => {
    const m = v as {
      id?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    return m && typeof m === "object" && m.id === id ? m : null;
  };
  if (/text\/event-stream/i.test(contentType ?? "")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const got = pick(JSON.parse(data));
        if (got) return got;
      } catch {
        /* not JSON: skip */
      }
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(pick).find(Boolean) ?? null;
    return pick(parsed);
  } catch {
    return null;
  }
}

export type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

/** A tool's answer as data: its structured content, else its text parsed as JSON when it is JSON, else the text */
export function toolValue(r: ToolResult): unknown {
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) return null;
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* plain text */
    }
  }
  return text;
}

/** A tool's error text (isError results carry it as content) */
export const toolErrorText = (r: ToolResult) =>
  (r.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .trim()
    .slice(0, 300) || "the tool failed";

/** Some fields of a result, whatever casing or nesting the server uses (threads, files...) */
export function listOf(v: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (v && typeof v === "object") {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x.filter((y) => y && typeof y === "object") as Record<string, unknown>[];
    }
  }
  return [];
}

/** A string field from the first of these names that has one */
export function field(o: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!o) return "";
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** A Gmail-style header value from a message object (payload.headers, headers, or a plain field) */
export function headerOf(m: Record<string, unknown>, name: string): string {
  const direct = field(m, name, name.toLowerCase(), name[0].toUpperCase() + name.slice(1));
  if (direct) return direct;
  const payload = m.payload as { headers?: { name: string; value: string }[] } | undefined;
  const headers = payload?.headers ?? (m.headers as { name: string; value: string }[] | undefined) ?? [];
  return Array.isArray(headers) ? (headers.find((h) => String(h?.name).toLowerCase() === name.toLowerCase())?.value ?? "") : "";
}

/**
 * The arguments a tool takes, from what we mean: each of our values goes under the first of its candidate names the
 * tool's input schema has (Google's names: query or q, pageSize or maxResults...). With no schema, the first name.
 */
export function argsFor(schema: unknown, want: Record<string, { names: string[]; value: unknown }>): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  const has = props && typeof props === "object" ? new Set(Object.keys(props)) : null;
  const out: Record<string, unknown> = {};
  for (const { names, value } of Object.values(want)) {
    if (value === undefined || value === null || value === "") continue;
    const name = has ? names.find((n) => has.has(n)) : names[0];
    if (name) out[name] = value;
  }
  return out;
}
