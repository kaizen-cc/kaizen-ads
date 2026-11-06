import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Account reads a launch needs (the live Google Ads account with its setup snapshot, a Meta account's Pages), kept for
// ten minutes so a second launch, a retry, the warm-up started while the chat is still answering, or the "suggest
// more" step after a deploy reads them instantly instead of asking Google or Meta again. Kept in
// keyword_research_cache (a server-only key/value table, keys prefixed "launch:"), so every server instance shares it;
// two reads of the same key in one instance share one request.

const TTL = 10 * 60_000;
const inFlight = new Map<string, Promise<unknown>>();

export async function cachedRead<T>(admin: SupabaseClient, key: string, read: () => Promise<T>, o: { clientId?: string | null; ttl?: number; fresh?: boolean } = {}): Promise<{ value: T; cached: boolean; at: string }> {
  const k = `launch:${key}`;
  if (!o.fresh) {
    const { data } = await admin
      .from("keyword_research_cache")
      .select("result, created_at")
      .eq("key", k)
      .gte("created_at", new Date(Date.now() - (o.ttl ?? TTL)).toISOString())
      .maybeSingle()
      .then(
        (r) => r,
        () => ({ data: null }),
      );
    if (data?.result) return { value: data.result as T, cached: true, at: data.created_at as string };
  }
  const running = inFlight.get(k) as Promise<T> | undefined;
  if (running) return { value: await running, cached: true, at: new Date().toISOString() };
  const p = read();
  inFlight.set(k, p);
  try {
    const value = await p;
    const at = new Date().toISOString();
    const { error } = await admin.from("keyword_research_cache").upsert({ key: k, client_id: o.clientId ?? null, result: value as unknown as object, created_by: null, created_at: at });
    if (error) console.error("[launch cache] couldn't keep", key, error.message);
    return { value, cached: false, at };
  } finally {
    inFlight.delete(k);
  }
}

/** Drops a kept read (the account changed: a launch was just created in it) */
export async function forgetCached(admin: SupabaseClient, key: string) {
  await admin.from("keyword_research_cache").delete().eq("key", `launch:${key}`).then(
    () => null,
    () => null,
  );
}

/** Time one step of a launch and log it (production too: these are the numbers to watch) */
export async function step<T>(scope: string, label: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const start = Date.now();
  try {
    return await (typeof work === "function" ? work() : work);
  } finally {
    console.log(`[launch] ${scope} · ${label} ${Date.now() - start}ms`);
  }
}
