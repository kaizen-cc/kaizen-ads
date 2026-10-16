import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Motion (motionapp.com) over its MCP server. Kaizen connects one Motion account (the central one with every client's
// boards): an exec signs in once, this app registers itself with Motion (dynamic client registration), and the
// refresh token keeps it connected. Read only: Motion's MCP can't change anything in Motion.

const BASE = "https://projects.motionapp.com";
export const MOTION_MCP = `${BASE}/mcp`;
const AUTH = `${BASE}/api/auth/oauth2`;
const SCOPE = "openid profile email offline_access";

export const motionRedirect = (origin: string) => `${origin}/api/motion/callback`;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** This app as a Motion OAuth client: registered once, kept. */
async function clientId(admin: SupabaseClient, redirectUri: string) {
  const { data } = await admin.from("motion_connection").select("client_id").eq("id", 1).maybeSingle();
  if (data?.client_id) return data.client_id as string;
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Kaizen Ads",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; error_description?: string; error?: string };
  if (!res.ok || !body.client_id) throw new Error(`Motion didn't register the app: ${body.error_description ?? body.error ?? res.status}`);
  await admin.from("motion_connection").upsert({ id: 1, client_id: body.client_id });
  return body.client_id;
}

/** Where to send the exec to sign in to Motion, and the PKCE verifier and state to keep (in a cookie) until they're back. */
export async function motionAuthorizeUrl(admin: SupabaseClient, redirectUri: string) {
  const id = await clientId(admin, redirectUri);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MOTION_MCP,
    prompt: "consent", // so Motion hands over a refresh token
  }).toString();
  return { url: url.toString(), verifier, state };
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };

async function token(params: Record<string, string>) {
  const res = await fetch(`${AUTH}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, resource: MOTION_MCP }) });
  const body = (await res.json().catch(() => ({}))) as Tokens & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Motion sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return body;
}

const expiry = (t: Tokens) => new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString();

/** Back from Motion's sign-in: swap the code for tokens, then read what Motion's tools take. */
export async function motionConnect(admin: SupabaseClient, code: string, verifier: string, redirectUri: string, by: string) {
  const { data } = await admin.from("motion_connection").select("client_id").eq("id", 1).single();
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: data!.client_id, code_verifier: verifier });
  await admin
    .from("motion_connection")
    .update({ access_token: t.access_token, refresh_token: t.refresh_token ?? null, expires_at: expiry(t), connected_by: by, connected_at: new Date().toISOString(), error: null })
    .eq("id", 1);
  const session = await openSession(admin);
  const tools = await session.list();
  const workspace = await session.call("get_auth_context", {}).catch(() => null);
  await admin.from("motion_connection").update({ tools, workspace }).eq("id", 1);
  return { tools: tools.length };
}

/** A live access token, refreshed when it's about to run out. */
async function accessToken(admin: SupabaseClient) {
  const { data: c } = await admin.from("motion_connection").select("client_id, access_token, refresh_token, expires_at").eq("id", 1).maybeSingle();
  if (!c?.access_token) throw new MotionNotConnected();
  if (c.expires_at && Date.parse(c.expires_at) - Date.now() > 120_000) return c.access_token as string;
  if (!c.refresh_token) throw new MotionNotConnected("Motion's sign-in ran out. An exec needs to connect Motion again in Settings.");
  try {
    const t = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id });
    await admin.from("motion_connection").update({ access_token: t.access_token, refresh_token: t.refresh_token ?? c.refresh_token, expires_at: expiry(t), error: null }).eq("id", 1);
    return t.access_token;
  } catch (e) {
    await admin.from("motion_connection").update({ error: e instanceof Error ? e.message : String(e) }).eq("id", 1);
    throw new MotionNotConnected("Motion's sign-in ran out. An exec needs to connect Motion again in Settings.");
  }
}

export class MotionNotConnected extends Error {
  constructor(message = "Motion isn't connected yet. An exec can connect it in Settings.") {
    super(message);
  }
}

export async function motionConnected(admin: SupabaseClient) {
  const { data } = await admin.from("motion_connection").select("access_token, connected_at, last_sync_at, last_result, error, workspace").eq("id", 1).maybeSingle();
  return data?.access_token ? { connectedAt: data.connected_at as string, lastSyncAt: data.last_sync_at as string | null, lastResult: data.last_result, error: data.error as string | null } : null;
}

export type MotionTool = { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] } };

/** Reads a JSON-RPC reply, whether Motion answers with plain JSON or an event stream. */
async function rpcReply(res: Response, id: number) {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const messages: { id?: number; result?: unknown; error?: { message: string } }[] = [];
  if (type.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) messages.push(JSON.parse(line.slice(5).trim()));
  } else if (text) messages.push(JSON.parse(text));
  const m = messages.find((x) => x.id === id);
  if (!m) throw new Error(`Motion didn't answer (${res.status})`);
  if (m.error) throw new Error(`Motion: ${m.error.message}`);
  return m.result;
}

/** One MCP session with Motion: initialize once, then call tools. */
export async function openSession(admin: SupabaseClient) {
  const auth = `Bearer ${await accessToken(admin)}`;
  let session: string | null = null;
  let next = 1;
  const post = async (body: object) =>
    fetch(MOTION_MCP, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  const request = async (method: string, params: object) => {
    const id = next++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    if (res.status === 401) throw new MotionNotConnected("Motion turned the sign-in down. An exec needs to connect Motion again in Settings.");
    session = res.headers.get("mcp-session-id") ?? session;
    return rpcReply(res, id);
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Kaizen Ads", version: "1.0" } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    list: async () => ((await request("tools/list", {})) as { tools: MotionTool[] }).tools ?? [],
    /** A tool's answer as data: its structured content, else its text parsed as JSON, else the text. */
    call: async (name: string, args: Record<string, unknown>) => {
      const r = (await request("tools/call", { name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
      const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      if (r.isError) throw new Error(`Motion ${name}: ${text.slice(0, 300)}`);
      if (r.structuredContent) return r.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

/** The arguments a tool takes, matched by name from Motion's own description of it (so small renames don't break us). */
export function argsFor(tool: MotionTool | undefined, want: Record<string, unknown>) {
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined || v === null) continue;
    const alts = k.split("|");
    const hit = props.find((p) => alts.includes(p)) ?? props.find((p) => alts.some((a) => p.toLowerCase().includes(a.toLowerCase())));
    if (hit) out[hit] = v;
  }
  return out;
}
