import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AtlassianMcp,
  AtlassianMcpError,
  argsFor,
  atlassianAuthMode,
  atlassianConfigured,
  atlassianMissing,
  findTool,
  loomVideosIn,
  needsCloudId,
  nextPageCursor,
  sitesIn,
  toolData,
  transcriptIn,
  userLabelIn,
  type McpTool,
} from "@/lib/atlassian-mcp";

// Every new Loom, pulled by itself through Atlassian's official MCP server (the Loom workspace linked to an Atlassian
// Cloud site). Each run lists the videos created since the last check (the first run looks back 30 days; an exec can
// pull everything since any date), page by page, and queues them like any other intake path; the Loom worker then
// reads and files them. A walk too long for one run keeps its place (page_cursor) and the next run continues it.
// When a video's public transcript can't be read (private, or shared to the workspace only), processLoom asks
// Atlassian for it instead.

type Admin = SupabaseClient;
const DAY = 86_400_000;
const FIRST_LOOKBACK = 30 * DAY;
/** Overlap with the last check, so a video Loom listed late isn't missed (duplicates are skipped by the queue) */
const OVERLAP = 2 * 3_600_000;
const PAGE = 50;

export type LoomConnection = {
  configured: boolean;
  mode: "service" | "token" | null;
  missing: string[];
  account: string | null;
  cloudId: string | null;
  lastSyncAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastFound: number;
  videoCount: number;
  since: string | null;
  walking: { from: string | null; all: boolean } | null;
};

type State = {
  cursor: string | null;
  walk_from: string | null;
  walk_all: boolean;
  walk_backfill: boolean;
  walk_started_at: string | null;
  page_cursor: string | null;
  account_label: string | null;
  cloud_id: string | null;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_found: number;
  video_count: number;
};

async function state(admin: Admin): Promise<State | null> {
  const { data } = await admin.from("loom_connection").select("*").eq("id", 1).maybeSingle();
  return (data as State | null) ?? null;
}

async function save(admin: Admin, patch: Partial<State>) {
  await admin.from("loom_connection").upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: "id" });
}

/** What the Settings card shows */
export async function loomConnection(admin: Admin | null): Promise<LoomConnection> {
  const s = admin ? await state(admin).catch(() => null) : null;
  const walking = s && s.walk_backfill && (s.walk_from || s.walk_all) ? { from: s.walk_from, all: s.walk_all } : null;
  return {
    configured: atlassianConfigured(),
    mode: atlassianAuthMode(),
    missing: atlassianMissing(),
    account: s?.account_label ?? null,
    cloudId: s?.cloud_id ?? null,
    lastSyncAt: s?.last_sync_at ?? null,
    lastOkAt: s?.last_ok_at ?? null,
    lastError: s?.last_error ?? null,
    lastFound: s?.last_found ?? 0,
    videoCount: s?.video_count ?? 0,
    since: s?.cursor ?? null,
    walking,
  };
}

// ─── Plain-language errors ──────────────────────────────────────────────────

export const NOT_CONFIGURED = "Not connected. Add ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (an Atlassian API token for that account), or ATLASSIAN_SERVICE_KEY (a service account key), in Vercel and redeploy.";
const AUTH =
  "Atlassian refused the sign-in. Either the API token is wrong, expired or for another email, or API-token sign-in is off for the MCP server: an org admin turns it on at admin.atlassian.com › Connectors › Atlassian MCP server.";
const NO_LOOM =
  "Atlassian answered, but it offers no Loom tools. The Loom workspace has to be linked to an Atlassian Cloud site (Loom › Workspace settings), and the account behind the token needs Loom access on that site.";

export function plainError(e: unknown): string {
  if (e instanceof AtlassianMcpError) {
    if (e.kind === "config") return NOT_CONFIGURED;
    if (e.kind === "auth") return AUTH;
    if (e.kind === "no_loom") return NO_LOOM;
    if (e.kind === "http" && e.status && e.status >= 500) return `Atlassian's MCP server is having trouble (HTTP ${e.status}). It will try again on the next run.`;
    return `Atlassian's MCP server didn't answer as expected: ${e.message}`.slice(0, 400);
  }
  return `Couldn't check Loom: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
}

// ─── The session: tools, cloud id, who it reads as ──────────────────────────

type Session = { mcp: AtlassianMcp; tools: McpTool[]; list: McpTool; content: McpTool | null; cloudId: string | null; account: string | null };

async function open(known: { cloudId: string | null }): Promise<Session> {
  if (!atlassianConfigured()) throw new AtlassianMcpError("config", "Not configured.");
  const mcp = new AtlassianMcp();
  await mcp.connect();
  const tools = await mcp.listTools();
  const list = findTool(tools, "listLoomObjects", /loom.*(list|search).*object|list.*loom/i);
  const content = findTool(tools, "getLoomObjectsContent", /loom.*(object|video).*content|get.*loom.*content/i);
  if (!list) {
    await mcp.close();
    throw new AtlassianMcpError("no_loom", "No Loom tools.");
  }
  // A helper tool that takes no arguments we know: asked, and nothing when it fails
  const ask = async (t: McpTool | null) => {
    if (!t) return [];
    try {
      return toolData(await mcp.callTool(t.name, argsFor(t, {})));
    } catch {
      return [];
    }
  };
  let cloudId = process.env.ATLASSIAN_CLOUD_ID || known.cloudId;
  let site: string | null = null;
  const sitesTool = findTool(tools, "getAccessibleAtlassianResources", /accessible.*resources/i);
  if (sitesTool) {
    const sites = sitesIn(await ask(sitesTool));
    const pick = sites.find((s) => s.id === cloudId) ?? sites.find((s) => s.loom) ?? sites[0];
    if (pick) {
      cloudId = pick.id;
      site = pick.name ?? pick.url;
    }
  }
  if (needsCloudId(list) && !cloudId) {
    await mcp.close();
    throw new AtlassianMcpError("no_loom", "No Atlassian site found for Loom.");
  }
  const who = userLabelIn(await ask(findTool(tools, "atlassianUserInfo", /user.?info|current.?user/i)));
  const label = who ?? (atlassianAuthMode() === "service" ? "a service account" : (process.env.ATLASSIAN_EMAIL ?? null));
  return { mcp, tools, list, content, cloudId: cloudId ?? null, account: [label, site].filter(Boolean).join(" · ") || null };
}

// ─── Pulling new videos ─────────────────────────────────────────────────────

export type SyncResult = { configured: boolean; found: number; added: number; pages: number; done: boolean; error: string | null };

/**
 * Videos created since the last check, queued. `from` starts an exec's backfill (a date, or "all" for everything);
 * otherwise a walk in progress continues, or a new check starts from the stored cursor (30 days back the first time).
 * A backfill leaves the regular cursor where it was, so the checks after it still cover what was recorded meanwhile.
 */
export async function syncLoomFromAtlassian(admin: Admin, opts: { from?: string | "all" | null; budgetMs?: number; by?: string | null } = {}): Promise<SyncResult> {
  if (!atlassianConfigured()) return { configured: false, found: 0, added: 0, pages: 0, done: true, error: NOT_CONFIGURED };
  const began = Date.now();
  const until = began + (opts.budgetMs ?? 90_000);
  const s = await state(admin);
  const now = () => new Date().toISOString();

  // The walk: a new backfill, one in progress, or a new regular check
  type Walk = { from: string | null; all: boolean; backfill: boolean; startedAt: string; page: string | null };
  let walk: Walk;
  if (opts.from) walk = { from: opts.from === "all" ? null : new Date(opts.from).toISOString(), all: opts.from === "all", backfill: true, startedAt: now(), page: null };
  else if (s && (s.walk_from || s.walk_all) && s.walk_started_at)
    walk = { from: s.walk_from, all: s.walk_all, backfill: s.walk_backfill, startedAt: s.walk_started_at, page: s.page_cursor };
  else walk = { from: s?.cursor ?? new Date(began - FIRST_LOOKBACK).toISOString(), all: false, backfill: false, startedAt: now(), page: null };
  const since = walk.all ? null : walk.from;
  const keepWalk = () => ({ walk_from: walk.from, walk_all: walk.all, walk_backfill: walk.backfill, walk_started_at: walk.startedAt, page_cursor: walk.page });

  let session: Session | null = null;
  let found = 0;
  let added = 0;
  let pages = 0;
  try {
    session = await open({ cloudId: s?.cloud_id ?? null });
    const { queueLooms } = await import("@/lib/loom-intake");
    let done = false;
    const seenCursors = new Set<string>();
    while (!done && Date.now() < until && pages < 200) {
      const args = argsFor(session.list, { cloudId: session.cloudId, createdAfter: since, cursor: walk.page, limit: PAGE, videos: true, wideScope: true });
      const data = toolData(await session.mcp.callTool(session.list.name, args));
      pages++;
      const videos = loomVideosIn(data);
      // Where the tool doesn't filter by date, filter here (a video without a date is kept: the queue skips duplicates)
      const fresh = since ? videos.filter((v) => !v.createdAt || v.createdAt >= since) : videos;
      found += fresh.length;
      if (fresh.length) {
        const q = await queueLooms(
          admin,
          fresh.map((v) => ({ id: v.id, url: v.url, title: v.title, recordedAt: v.createdAt })),
          { source: "atlassian", by: opts.by ?? null, sourceRef: `atlassian:${session.list.name}` },
        );
        added += q.added;
      }
      const next = nextPageCursor(data);
      // A page listed newest first and entirely older than where we start: nothing further on is new
      const dated = videos.map((v) => v.createdAt).filter((d): d is string => Boolean(d));
      const newestFirst = dated.length > 1 && dated[0] >= dated[dated.length - 1];
      const pastIt = Boolean(since) && newestFirst && dated.length === videos.length && dated.every((d) => d < since!);
      if (!next || seenCursors.has(next) || pastIt || videos.length === 0) done = true;
      else {
        seenCursors.add(next);
        walk.page = next;
      }
    }
    const { count } = await admin.from("loom_videos").select("id", { count: "exact", head: true }).eq("source", "atlassian");
    // A finished regular check moves the cursor to when it began (with overlap); a finished backfill leaves it (or sets
    // it the first time)
    const cursor = !walk.backfill || !s?.cursor ? new Date(new Date(walk.startedAt).getTime() - OVERLAP).toISOString() : s.cursor;
    await save(admin, {
      ...(done ? { cursor, walk_from: null, walk_all: false, walk_backfill: false, walk_started_at: null, page_cursor: null } : keepWalk()),
      account_label: session.account,
      cloud_id: session.cloudId,
      last_sync_at: now(),
      last_ok_at: now(),
      last_error: null,
      last_found: found,
      video_count: count ?? 0,
    });
    return { configured: true, found, added, pages, done, error: null };
  } catch (e) {
    const error = plainError(e);
    // Keep the walk's place, so the next run continues from the last page that worked
    await save(admin, { ...keepWalk(), last_sync_at: now(), last_error: error, last_found: found, ...(session ? { account_label: session.account, cloud_id: session.cloudId } : {}) }).catch(() => null);
    return { configured: true, found, added, pages, done: false, error };
  } finally {
    await session?.mcp.close().catch(() => null);
  }
}

// ─── A transcript for a video the public page won't show ────────────────────

/** The transcript (and title) of one video through Atlassian, or null when it isn't configured or has none */
export async function atlassianTranscript(admin: Admin, url: string, loomId: string): Promise<{ transcript: string | null; title: string | null } | null> {
  if (!atlassianConfigured()) return null;
  const s = await state(admin).catch(() => null);
  let session: Session | null = null;
  try {
    session = await open({ cloudId: s?.cloud_id ?? null });
    if (!session.content) return null;
    const args = argsFor(session.content, { cloudId: session.cloudId, objects: [url], transcript: true });
    const data = toolData(await session.mcp.callTool(session.content.name, args));
    const transcript = transcriptIn(data, loomId);
    const title = loomVideosIn(data).find((v) => v.id === loomId.toLowerCase())?.title ?? null;
    return { transcript, title };
  } catch {
    return null;
  } finally {
    await session?.mcp.close().catch(() => null);
  }
}
