// Google Workspace request counting, the plain parts (no network, no database) so they can be tested: which Workspace
// API a request URL belongs to, the New York day it falls on, and the buckets counts are kept in until they're written.
// Google's Workspace API tiers (Standard: free with fixed quotas; Scaled: needed for quota increases from Nov 24 2026,
// billed from Apr 1 2027) are set per API and per Cloud project, so counts are kept per API, per day, and per path
// ("rest" for our own calls, "mcp" for Google's Workspace MCP servers). See docs/WORKSPACE-MCP.md.

export type WorkspaceApi = "gmail" | "drive" | "calendar" | "docs" | "sheets" | "slides" | "directory" | "chat" | "people";
export type Via = "rest" | "mcp";

/** The Workspace API a request goes to and whether it's through MCP, or null when it isn't a Workspace API we count */
export function workspaceApiOf(raw: string): { api: WorkspaceApi; via: Via } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".googleapis.com")) return null;
  const sub = host.slice(0, -".googleapis.com".length);
  // Google's MCP endpoints: <api>mcp.googleapis.com, or <api>.googleapis.com/mcp...
  const mcpHost = /^([a-z]+)mcp$/.exec(sub);
  const name = mcpHost ? mcpHost[1] : sub;
  const via: Via = mcpHost || /^\/mcp(\/|$)/.test(u.pathname) ? "mcp" : "rest";
  const direct: Record<string, WorkspaceApi> = {
    gmail: "gmail",
    drive: "drive",
    calendar: "calendar",
    docs: "docs",
    sheets: "sheets",
    slides: "slides",
    admin: "directory",
    chat: "chat",
    people: "people",
  };
  if (direct[name]) return { api: direct[name], via };
  if (name === "www") {
    const p = u.pathname;
    if (/^\/(upload\/)?drive\//.test(p)) return { api: "drive", via };
    if (/^\/calendar\//.test(p)) return { api: "calendar", via };
    if (/^\/admin\/directory\//.test(p)) return { api: "directory", via };
  }
  return null;
}

/** The New York date (YYYY-MM-DD) a moment falls on: the day counts are kept under */
export function nyDay(at = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

export type UsageKey = `${string}|${WorkspaceApi}|${Via}`;
export type UsageRow = {
  day: string;
  api: WorkspaceApi;
  via: Via;
  requests: number;
  errors: number;
};

/** Counts waiting to be written, by day, API and path */
export class UsageBuckets {
  private m = new Map<UsageKey, { requests: number; errors: number }>();
  add(api: WorkspaceApi, via: Via, ok: boolean, at = Date.now()) {
    const k = `${nyDay(at)}|${api}|${via}` as UsageKey;
    const b = this.m.get(k) ?? { requests: 0, errors: 0 };
    b.requests += 1;
    if (!ok) b.errors += 1;
    this.m.set(k, b);
  }
  get pending() {
    let n = 0;
    for (const b of this.m.values()) n += b.requests;
    return n;
  }
  /** Everything waiting, as rows, and the buckets emptied */
  drain(): UsageRow[] {
    const rows = [...this.m.entries()].map(([k, b]) => {
      const [day, api, via] = k.split("|") as [string, WorkspaceApi, Via];
      return { day, api, via, ...b };
    });
    this.m.clear();
    return rows;
  }
  /** Rows that couldn't be written go back in, to try again with the next write */
  restore(rows: UsageRow[]) {
    for (const r of rows) {
      const k = `${r.day}|${r.api}|${r.via}` as UsageKey;
      const b = this.m.get(k) ?? { requests: 0, errors: 0 };
      b.requests += r.requests;
      b.errors += r.errors;
      this.m.set(k, b);
    }
  }
}
