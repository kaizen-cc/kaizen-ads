// A small client for Atlassian's official remote MCP server (streamable HTTP), enough to read Loom through it:
// initialize, tools/list and tools/call as JSON-RPC over POST, answered as JSON or as a server-sent event stream.
// Auth without OAuth: a personal API token (ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN, sent as Basic) or a service account
// key (ATLASSIAN_SERVICE_KEY, sent as Bearer). Nothing secret is ever logged or put in an error message.
//
// Tool arguments aren't hardcoded: each tool's input schema comes from tools/list, and argsFor() maps what we mean
// (a cloud id, created after, a page cursor, the objects to read, include the transcript) onto the names it declares.
// The parsing helpers below are pure so they can be tested on fixtures.

export const ATLASSIAN_MCP_URL = process.env.ATLASSIAN_MCP_URL || "https://mcp.atlassian.com/v2/mcp";
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 60_000;

export type McpTool = { name: string; description?: string; inputSchema?: JsonSchema };
export type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; items?: JsonSchema; format?: string; description?: string };
export type McpContent = { type: string; text?: string; resource?: { text?: string; uri?: string; mimeType?: string }; [k: string]: unknown };
export type McpToolResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

export type McpErrorKind = "config" | "auth" | "no_loom" | "http" | "rpc" | "tool";
export class AtlassianMcpError extends Error {
  constructor(
    public kind: McpErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AtlassianMcpError";
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Which credentials are set (never their values) */
export function atlassianAuthMode(): "service" | "token" | null {
  if (process.env.ATLASSIAN_SERVICE_KEY) return "service";
  if (process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN) return "token";
  return null;
}
export const atlassianConfigured = () => atlassianAuthMode() !== null;

/** The env vars still missing, by name, for the Settings card */
export function atlassianMissing(): string[] {
  if (atlassianConfigured()) return [];
  const m: string[] = [];
  if (!process.env.ATLASSIAN_EMAIL) m.push("ATLASSIAN_EMAIL");
  if (!process.env.ATLASSIAN_API_TOKEN) m.push("ATLASSIAN_API_TOKEN");
  return m;
}

function authHeader(): string {
  const key = process.env.ATLASSIAN_SERVICE_KEY;
  if (key) return `Bearer ${key}`;
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) throw new AtlassianMcpError("config", "Atlassian isn't configured.");
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

// ─── The wire: JSON-RPC over streamable HTTP ────────────────────────────────

type RpcMessage = { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; method?: string };

/** The JSON-RPC messages in a server-sent event stream (each event's data lines joined; non-JSON events ignored) */
export function parseSse(body: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  for (const block of body.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      const v = JSON.parse(data) as RpcMessage | RpcMessage[];
      out.push(...(Array.isArray(v) ? v : [v]));
    } catch {}
  }
  return out;
}

/** The answer to request `id` in a response body (JSON, a JSON batch, or an event stream) */
export function rpcAnswer(body: string, contentType: string, id: number): RpcMessage | null {
  let msgs: RpcMessage[] = [];
  if (/text\/event-stream/i.test(contentType)) msgs = parseSse(body);
  else {
    try {
      const v = JSON.parse(body) as RpcMessage | RpcMessage[];
      msgs = Array.isArray(v) ? v : [v];
    } catch {
      // Some servers answer an event stream without the header
      msgs = parseSse(body);
    }
  }
  return msgs.find((m) => m && m.id === id && ("result" in m || "error" in m)) ?? null;
}

/** A plain reason from a failed HTTP answer (no headers, no body that might echo a credential) */
function httpError(status: number): AtlassianMcpError {
  if (status === 401 || status === 403) return new AtlassianMcpError("auth", `Atlassian refused the credentials (HTTP ${status}).`, status);
  return new AtlassianMcpError("http", `Atlassian's MCP server answered HTTP ${status}.`, status);
}

export class AtlassianMcp {
  private session: string | null = null;
  private protocol = PROTOCOL;
  private nextId = 1;
  private tools: McpTool[] | null = null;
  constructor(private url = ATLASSIAN_MCP_URL) {}

  private headers(): Record<string, string> {
    return {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocol,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
    };
  }

  private async post(payload: object): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "couldn't be reached";
      throw new AtlassianMcpError("http", `Atlassian's MCP server ${why}.`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => null);
      throw httpError(res.status);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return res;
  }

  private async request<T>(method: string, params?: object): Promise<T> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const body = await res.text();
    const msg = rpcAnswer(body, res.headers.get("content-type") ?? "", id);
    if (!msg) throw new AtlassianMcpError("rpc", `Atlassian's MCP server gave no answer to ${method}.`);
    if (msg.error) {
      const code = msg.error.code;
      // Auth problems sometimes come back inside a 200 as a JSON-RPC error
      if (/unauthori[sz]ed|forbidden|invalid (api )?token|authentication/i.test(msg.error.message ?? "")) throw new AtlassianMcpError("auth", `Atlassian refused the credentials (${(msg.error.message ?? "").slice(0, 160)}).`);
      throw new AtlassianMcpError("rpc", `${method} failed${code !== undefined ? ` (${code})` : ""}: ${(msg.error.message ?? "unknown error").slice(0, 200)}`);
    }
    return msg.result as T;
  }

  async connect() {
    const r = await this.request<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }>("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "kaizen-ads", version: "1.0.0" },
    });
    if (r?.protocolVersion) this.protocol = r.protocolVersion;
    // The initialized notification has no answer (202); a failure here isn't fatal
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" })
      .then((res) => res.body?.cancel())
      .catch(() => null);
    return r?.serverInfo ?? null;
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const all: McpTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await this.request<{ tools?: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      all.push(...(r?.tools ?? []));
      cursor = r?.nextCursor || undefined;
      if (!cursor) break;
    }
    this.tools = all;
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const r = await this.request<McpToolResult>("tools/call", { name, arguments: args });
    if (r?.isError) {
      const text = (r.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      if (/unauthori[sz]ed|forbidden|401|403|scope/i.test(text)) throw new AtlassianMcpError("auth", `${name}: Atlassian refused it (${text.slice(0, 200)}).`);
      throw new AtlassianMcpError("tool", `${name} failed: ${text.slice(0, 300) || "no reason given"}`);
    }
    return r ?? {};
  }

  /** End the session (best effort) */
  async close() {
    if (!this.session) return;
    await fetch(this.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(10_000) })
      .then((r) => r.body?.cancel())
      .catch(() => null);
    this.session = null;
  }
}

// ─── Reading tools/call results ─────────────────────────────────────────────

/**
 * What a tool answered, as data: its structured content when it gives one, else each content item's text parsed as
 * JSON where it is JSON (kept as a string where it isn't). Embedded resources count as text.
 */
export function toolData(result: McpToolResult | null | undefined): unknown[] {
  if (!result) return [];
  const out: unknown[] = [];
  if (result.structuredContent !== undefined && result.structuredContent !== null) out.push(result.structuredContent);
  for (const c of result.content ?? []) {
    const text = c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text : undefined;
    if (typeof text !== "string" || !text.trim()) continue;
    const t = text.trim();
    if (/^[[{]/.test(t)) {
      try {
        out.push(JSON.parse(t));
        continue;
      } catch {}
    }
    // JSON fenced in markdown
    const fenced = t.match(/```(?:json)?\s*([[{][\s\S]*?[\]}])\s*```/);
    if (fenced) {
      try {
        out.push(JSON.parse(fenced[1]));
        continue;
      } catch {}
    }
    out.push(t);
  }
  return out;
}

/** Every plain object anywhere inside a value (depth first, the value itself first) */
export function walkObjects(v: unknown, visit: (o: Record<string, unknown>) => void, depth = 0) {
  if (depth > 12 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) walkObjects(x, visit, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  visit(o);
  for (const x of Object.values(o)) walkObjects(x, visit, depth + 1);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return null;
};
const VIDEO_URL = /loom\.com\/(?:share|embed|v)\/([a-f0-9]{16,40})(?![a-f0-9])/i;
const HEX_ID = /^[a-f0-9]{32}$/i;
// An ARI like ari:cloud:loom:<site>:video/<id> (the id part, whatever the resource type is called)
const LOOM_ARI = /^ari:cloud:loom:[^:]*:(?:video|recording|loom|object)\/([a-z0-9-]+)$/i;

export type FoundLoom = { id: string; url: string; title: string | null; createdAt: string | null; ari: string | null };

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One object as a Loom video, when it is one (a share link, an embed link, an ARI with a video id, or a 32-hex id with a video type) */
export function asLoomVideo(o: Record<string, unknown>): FoundLoom | null {
  const urlish = pick(o, ["shareUrl", "share_url", "shareURL", "url", "link", "webUrl", "web_url", "embedUrl", "embed_url", "href"]);
  const ari = pick(o, ["ari", "ARI", "objectAri", "object_ari", "id"]);
  const type = (pick(o, ["type", "contentType", "content_type", "objectType", "object_type", "kind", "__typename"]) ?? "").toLowerCase();
  if (/folder|space|comment|user|workspace/.test(type)) return null;
  let id: string | null = null;
  const m = urlish?.match(VIDEO_URL);
  if (m) id = m[1].toLowerCase();
  if (!id && ari) {
    const a = ari.match(LOOM_ARI);
    if (a && HEX_ID.test(a[1])) id = a[1].toLowerCase();
  }
  if (!id) {
    const raw = pick(o, ["videoId", "video_id", "loomId", "loom_id", "id"]);
    if (raw && HEX_ID.test(raw) && (!type || /video|loom|recording/.test(type) || urlish)) id = raw.toLowerCase();
  }
  if (!id) return null;
  return {
    id,
    url: `https://www.loom.com/share/${id}`,
    title: pick(o, ["title", "name", "videoTitle", "video_title"]),
    createdAt: toIso(o.createdAt ?? o.created_at ?? o.createdDate ?? o.creationDate ?? o.created ?? o.createTime ?? o.recordedAt ?? o.recorded_at),
    ari: ari && /^ari:/i.test(ari) ? ari : null,
  };
}

/** Every Loom video in a tool's answer, once each (objects first, then any bare share links in the text) */
export function loomVideosIn(data: unknown[]): FoundLoom[] {
  const seen = new Map<string, FoundLoom>();
  for (const d of data) {
    walkObjects(d, (o) => {
      const v = asLoomVideo(o);
      if (!v) return;
      const had = seen.get(v.id);
      // The richer record wins (a nested object may only carry the link)
      if (!had) seen.set(v.id, v);
      else seen.set(v.id, { ...had, title: had.title ?? v.title, createdAt: had.createdAt ?? v.createdAt, ari: had.ari ?? v.ari });
    });
    if (typeof d === "string")
      for (const m of d.matchAll(new RegExp(VIDEO_URL.source, "gi"))) {
        const id = m[1].toLowerCase();
        if (!seen.has(id)) seen.set(id, { id, url: `https://www.loom.com/share/${id}`, title: null, createdAt: null, ari: null });
      }
  }
  return [...seen.values()];
}

/** The next page's cursor in a tool's answer, when there's more (null at the end) */
export function nextPageCursor(data: unknown[]): string | null {
  for (const d of data) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    for (const k of ["nextCursor", "next_cursor", "nextPageToken", "next_page_token", "cursor", "next"]) {
      const v = str(o[k]);
      if (v && !/^https?:/i.test(v)) return v;
    }
    const info = (o.pageInfo ?? o.page_info ?? o.pagination ?? o.paging) as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      const more = info.hasNextPage ?? info.has_next_page ?? info.hasMore ?? info.has_more;
      const c = str(info.endCursor ?? info.end_cursor ?? info.nextCursor ?? info.next_cursor ?? info.cursor);
      if (c && more !== false) return c;
    }
  }
  for (const d of data) if (typeof d === "string") {
    const m = d.match(/(?:next[ _-]?cursor|nextPageToken)["'\s:=]+([A-Za-z0-9+/=_-]{6,})/i);
    if (m) return m[1];
  }
  return null;
}

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function seconds(p: Record<string, unknown>): number | null {
  for (const k of ["start", "startTime", "start_time", "startSeconds", "start_seconds", "ts", "time", "offset", "startMs", "start_ms"]) {
    const v = p[k];
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
    if (n === null) continue;
    return /ms$/i.test(k) || n > 100_000 ? n / 1000 : n;
  }
  return null;
}

/** A transcript as text: a string, or phrases with their start times as "[m:ss] text" lines (like readLoom) */
function transcriptText(v: unknown): string | null {
  const s = str(v);
  if (s) return s;
  if (Array.isArray(v)) {
    const lines = v
      .map((p) => {
        if (typeof p === "string") return p.trim();
        if (!p || typeof p !== "object") return "";
        const o = p as Record<string, unknown>;
        const text = pick(o, ["text", "value", "content", "phrase", "sentence"]);
        if (!text) return "";
        const at = seconds(o);
        return at === null ? text : `[${clock(at)}] ${text}`;
      })
      .filter(Boolean);
    return lines.length ? lines.join("\n") : null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return transcriptText(o.text ?? o.phrases ?? o.segments ?? o.paragraphs ?? o.items ?? o.content ?? o.value);
  }
  return null;
}

/** The transcript in a getLoomObjectsContent answer (for the video `id` when given), or null */
export function transcriptIn(data: unknown[], id?: string): string | null {
  let found: string | null = null;
  for (const d of data) {
    walkObjects(d, (o) => {
      if (found) return;
      if (id) {
        const v = asLoomVideo(o);
        if (v && v.id !== id.toLowerCase()) return;
      }
      for (const k of ["transcript", "transcription", "captions", "transcriptText", "transcript_text"]) {
        const t = transcriptText(o[k]);
        if (t && t.length > 20) {
          found = t;
          return;
        }
      }
    });
    if (found) return found;
  }
  // A markdown answer: the part under a Transcript heading
  for (const d of data) if (typeof d === "string") {
    const m = d.match(/(?:^|\n)#{0,4}\s*\**transcript\**:?\s*\n([\s\S]+?)(?:\n#{1,4}\s|\n\*\*[A-Z][^*\n]{2,40}\*\*:?\s*\n|$)/i);
    if (m && m[1].trim().length > 20) return m[1].trim();
  }
  return null;
}

// ─── Arguments from a tool's schema ─────────────────────────────────────────

export type Wanted = {
  cloudId?: string | null;
  createdAfter?: string | null;
  cursor?: string | null;
  limit?: number;
  /** The objects to read (share links or ARIs) */
  objects?: string[];
  transcript?: boolean;
  /** Videos only, where the tool filters by content type */
  videos?: boolean;
  /** The widest scope the tool offers (everything the account can see) */
  wideScope?: boolean;
};

const props = (s: JsonSchema | undefined) => Object.entries(s?.properties ?? {});
const typeOf = (s: JsonSchema) => (Array.isArray(s.type) ? s.type[0] : s.type) ?? (s.enum ? "string" : s.properties ? "object" : undefined);
const enumPick = (s: JsonSchema, re: RegExp) => (s.enum ?? []).find((e) => typeof e === "string" && re.test(e)) as string | undefined;

/**
 * The arguments for a tool from what we want, by the names its input schema declares. Throws when the tool requires
 * an argument we can't fill (naming it), so a change on Atlassian's side reads as a clear error.
 */
export function argsFor(tool: McpTool, want: Wanted): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const used = new Set<string>();
  const entries = props(tool.inputSchema);
  const find = (re: RegExp, ok: (s: JsonSchema) => boolean = () => true) => entries.find(([k, s]) => !used.has(k) && re.test(k) && ok(s));
  const set = (hit: [string, JsonSchema] | undefined, value: unknown) => {
    if (!hit || value === undefined || value === null) return;
    used.add(hit[0]);
    args[hit[0]] = value;
  };
  const dateValue = (s: JsonSchema, iso: string) => (s.format === "date" ? iso.slice(0, 10) : typeOf(s) === "number" || typeOf(s) === "integer" ? Math.floor(new Date(iso).getTime() / 1000) : iso);

  if (want.cloudId) set(find(/^cloud_?id$|cloud.?id/i), want.cloudId);
  if (want.createdAfter) {
    const hit = find(/(created|creation|date).*(after|from|since|start|gte|min)|^(since|from|after|createdafter|start_?date)$/i, (s) => typeOf(s) !== "boolean");
    if (hit) set(hit, dateValue(hit[1], want.createdAfter));
    else {
      // A nested filter object ({ createdAfter } inside filter/filters)
      const obj = find(/^(filter|filters|where|query)$/i, (s) => typeOf(s) === "object");
      if (obj) {
        const inner = argsFor({ name: tool.name, inputSchema: { properties: obj[1].properties ?? {} } }, { createdAfter: want.createdAfter, videos: want.videos });
        if (Object.keys(inner).length) set(obj, inner);
      }
    }
  }
  if (want.cursor) set(find(/cursor|page_?token|^after$|^next/i, (s) => typeOf(s) !== "boolean"), want.cursor);
  if (want.limit) {
    const hit = find(/^(limit|page_?size|first|max_?results|max|count|per_?page)$/i);
    if (hit) set(hit, typeOf(hit[1]) === "string" ? String(want.limit) : want.limit);
  }
  if (want.videos) {
    const hit = find(/content.?types?|object.?types?|^types?$|^kind$/i, (s) => Boolean(s.enum ?? s.items?.enum) || typeOf(s) === "array" || typeOf(s) === "string");
    if (hit) {
      const s = hit[1];
      if (typeOf(s) === "array") {
        const v = enumPick(s.items ?? {}, /video|loom|recording/i);
        if (v || !s.items?.enum) set(hit, [v ?? "VIDEO"]);
      } else {
        const v = enumPick(s, /video|loom|recording/i);
        if (v || !s.enum) set(hit, v ?? "VIDEO");
      }
    }
  }
  if (want.wideScope) {
    const hit = find(/scope|visibility|ownership|filter_?by/i, (s) => Boolean(s.enum ?? s.items?.enum));
    if (hit) {
      const s = hit[1];
      const order = [/^all$|everything/i, /workspace|visible|organi[sz]ation|org/i, /shared/i];
      const pool = typeOf(s) === "array" ? s.items ?? {} : s;
      const v = order.map((re) => enumPick(pool, re)).find(Boolean);
      if (v) set(hit, typeOf(s) === "array" ? [v] : v);
    }
  }
  if (want.objects?.length) {
    const hit = find(/^(ids|aris|urls|objects|object_?ids|object_?aris|identifiers|items|links|video_?ids)$/i) ?? find(/^(id|ari|url|object_?id|object_?ari|identifier|link|video_?id|share_?url)$/i);
    if (hit) set(hit, typeOf(hit[1]) === "array" ? want.objects : want.objects[0]);
  }
  if (want.transcript) {
    const flag = find(/transcript/i, (s) => typeOf(s) === "boolean");
    if (flag) set(flag, true);
    else {
      const list = find(/include|fields|content_?types|expand|with|sections/i, (s) => typeOf(s) === "array" || Boolean(s.enum));
      if (list) {
        const s = list[1];
        if (typeOf(s) === "array") {
          const v = enumPick(s.items ?? {}, /transcript/i);
          set(list, [v ?? "transcript"]);
        } else {
          const v = enumPick(s, /transcript/i);
          if (v) set(list, v);
        }
      }
    }
  }
  const missing = (tool.inputSchema?.required ?? []).filter((k) => !(k in args));
  if (missing.length) throw new AtlassianMcpError("tool", `${tool.name} needs ${missing.join(", ")}, which Kaizen doesn't know how to fill. Atlassian may have changed the tool.`);
  return args;
}

/** A tool by name (exact, then case-insensitive, then the first matching a fallback pattern) */
export function findTool(tools: McpTool[], name: string, fallback?: RegExp): McpTool | null {
  return tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? (fallback ? (tools.find((t) => fallback.test(t.name)) ?? null) : null);
}

/** Does this tool need a cloud id (declared as an argument)? */
export const needsCloudId = (t: McpTool) => props(t.inputSchema).some(([k]) => /cloud.?id/i.test(k));

/** The Atlassian sites in a getAccessibleAtlassianResources answer: id, name, url, and whether Loom is among its scopes */
export function sitesIn(data: unknown[]): { id: string; name: string | null; url: string | null; loom: boolean }[] {
  const out: { id: string; name: string | null; url: string | null; loom: boolean }[] = [];
  for (const d of data)
    walkObjects(d, (o) => {
      const id = pick(o, ["id", "cloudId", "cloud_id"]);
      const url = pick(o, ["url", "siteUrl", "site_url"]);
      if (!id || !/^[0-9a-f-]{20,}$/i.test(id) || (url && !/atlassian\.net|atlassian\.com|loom\.com/i.test(url) && !o.scopes)) return;
      if (out.some((x) => x.id === id)) return;
      const scopes = Array.isArray(o.scopes) ? (o.scopes as unknown[]).map(String) : [];
      const products = Array.isArray(o.products) ? (o.products as unknown[]).map(String) : [];
      out.push({ id, name: pick(o, ["name", "displayName"]), url, loom: [...scopes, ...products].some((s) => /loom/i.test(s)) });
    });
  return out;
}

/** Who the credentials read as, from a user-info answer (email or display name) */
export function userLabelIn(data: unknown[]): string | null {
  let label: string | null = null;
  for (const d of data)
    walkObjects(d, (o) => {
      if (label) return;
      label = pick(o, ["email", "emailAddress", "email_address"]) ?? (o.account_id || o.accountId ? pick(o, ["name", "displayName", "display_name"]) : null);
    });
  return label;
}
