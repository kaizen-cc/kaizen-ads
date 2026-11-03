import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BenchmarkTarget } from "./success";

type Bench = { metric: string; good: number | null; great: number | null; unit: string; source: string; year: string };

/**
 * The industry benchmark that stands in for a missing target: the client's sub-vertical, the platform's researched
 * figures (Meta, or Google from WordStream and the like), a good cost per result, or a good ROAS for a ROAS KPI.
 * null when the client isn't placed or nothing was researched.
 */
export async function benchmarksFor(admin: SupabaseClient, clientIds: string[]) {
  const out = new Map<string, { vertical: string; meta: Bench[]; google: Bench[] }>();
  if (!clientIds.length) return out;
  const { data: cs } = await admin.from("clients").select("id, vertical_id").in("id", clientIds).not("vertical_id", "is", null);
  const vids = [...new Set((cs ?? []).map((c) => c.vertical_id as string))];
  if (!vids.length) return out;
  const { data: vs } = await admin.from("verticals").select("id, name, benchmarks, google_benchmarks").in("id", vids);
  const byId = new Map((vs ?? []).map((v) => [v.id as string, v]));
  for (const c of cs ?? []) {
    const v = byId.get(c.vertical_id as string);
    if (v) out.set(c.id as string, { vertical: v.name as string, meta: (v.benchmarks ?? []) as Bench[], google: (v.google_benchmarks ?? []) as Bench[] });
  }
  return out;
}

export function benchmarkTarget(b: { vertical: string; meta: Bench[]; google: Bench[] } | undefined, platform: string, roas: boolean): BenchmarkTarget | null {
  if (!b) return null;
  const want = roas ? "roas" : "cost_per_result";
  const hit = (platform === "google" ? b.google : b.meta).find((x) => x.metric === want && x.good != null && x.good > 0);
  return hit ? { value: Number(hit.good), metric: want, unit: hit.unit, source: hit.source, year: hit.year, vertical: b.vertical } : null;
}
