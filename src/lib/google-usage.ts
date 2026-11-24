import "server-only";
import { UsageBuckets, workspaceApiOf, type UsageRow, type Via, type WorkspaceApi } from "./google-usage-core";

// Every request this server makes to a Google Workspace API is counted, by New York day, API and path (REST or MCP),
// so Settings › Calls & usage can show the volume against Google's Standard tier. Node's fetch (undici) announces each
// request and its response on diagnostics channels: listening there counts every caller (our helpers, raw fetch,
// google-auth-library) without touching them. Counts are kept in memory and written in batches; an instance that stops
// before writing loses its last few, so the numbers are a close floor, not an invoice.

const buckets = new UsageBuckets();
const FLUSH_AT = 40;
const FLUSH_MS = 15_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

async function flush() {
  timer = null;
  if (writing || !buckets.pending) return;
  writing = true;
  const rows = buckets.drain();
  try {
    const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
    if (!adminConfigured()) return;
    const { error } = await createAdminClient().rpc("bump_google_usage", {
      p_rows: rows,
    });
    if (error) buckets.restore(rows.slice(0, 50));
  } catch {
    buckets.restore(rows.slice(0, 50));
  } finally {
    writing = false;
  }
}

function schedule() {
  if (buckets.pending >= FLUSH_AT) void flush();
  else if (!timer) {
    timer = setTimeout(() => void flush(), FLUSH_MS);
    timer.unref?.();
  }
}

/** Count one Workspace request (MCP calls made by our own client count here too) */
export function countWorkspace(api: WorkspaceApi, via: Via, ok: boolean) {
  buckets.add(api, via, ok);
  schedule();
}

/** Write what's waiting now (end of a cron run) */
export const flushWorkspaceUsage = () => flush();

type UndiciRequest = {
  origin?: string | URL;
  path?: string;
  __kzWs?: { api: WorkspaceApi; via: Via };
};
let listening = false;

/** Start counting (once per server instance, from instrumentation) */
export async function listenForWorkspaceRequests() {
  if (listening) return;
  listening = true;
  const dc = await import("node:diagnostics_channel");
  dc.subscribe("undici:request:create", (msg) => {
    const req = (msg as { request?: UndiciRequest }).request;
    if (!req?.origin) return;
    const hit = workspaceApiOf(`${String(req.origin).replace(/\/$/, "")}${req.path ?? "/"}`);
    if (hit) req.__kzWs = hit;
  });
  dc.subscribe("undici:request:headers", (msg) => {
    const m = msg as {
      request?: UndiciRequest;
      response?: { statusCode?: number };
    };
    const hit = m.request?.__kzWs;
    if (hit) countWorkspace(hit.api, hit.via, (m.response?.statusCode ?? 500) < 400);
  });
  dc.subscribe("undici:request:error", (msg) => {
    const hit = (msg as { request?: UndiciRequest }).request?.__kzWs;
    if (hit) countWorkspace(hit.api, hit.via, false);
  });
}

export type { UsageRow };
