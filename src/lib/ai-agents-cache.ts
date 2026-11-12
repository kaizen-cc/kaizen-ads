import "server-only";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CostRow } from "@/app/(team)/settings/expenses";

// Settings › AI agents: what the AI cost and how each skill ran, worked out once and shared for two minutes. Every
// tab click used to re-read the year's cost rollup and the last 30 days of calls (24k+ rows) under the viewer's
// row rules, which was slow and, when a read failed, showed $0. Read through the server and only cached when it
// worked (a failed read throws, so it isn't kept); who sees which agent is still filtered on the page.

export const AI_AGENTS_TAG = "ai-agents-stats";

export type Activity = { agent: string; label: string | null; runs7: number; failed7: number; in7: number; out7: number; ms_sum: number; ms_n: number; last_at: string };

async function rpcJson<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const admin = createAdminClient();
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await admin.rpc(fn as never, args as never);
    if (!error && data != null) return data as T;
    if (attempt >= 1) throw new Error(`${fn}: ${error?.message ?? "no data"}`);
  }
}

/** Every AI call rolled up by day, skill, model, kind and person, from `from` (a New York date) */
export const cachedCostRollup = unstable_cache(
  async (from: string, to: string) => {
    const rows = await rpcJson<CostRow[]>("ai_cost_rollup", { p_from: `${from}T00:00:00-05:00`, p_to: to });
    return rows.map((r) => ({ ...r, runs: Number(r.runs), failed: Number(r.failed), input: Number(r.input), output: Number(r.output), cache_w: Number(r.cache_w), cache_r: Number(r.cache_r), searches: Number(r.searches) }));
  },
  ["ai-cost-rollup"],
  { revalidate: 120, tags: [AI_AGENTS_TAG] },
);

/** Each skill's calls by label over 30 days: runs, failures, tokens and time this week, and when each last ran */
export const cachedActivity = unstable_cache(
  async (week: string) => {
    const rows = await rpcJson<Activity[]>("ai_agent_activity", { p_week: week });
    return rows.map((r) => ({ ...r, runs7: Number(r.runs7), failed7: Number(r.failed7), in7: Number(r.in7), out7: Number(r.out7), ms_sum: Number(r.ms_sum), ms_n: Number(r.ms_n) }));
  },
  ["ai-agent-activity"],
  { revalidate: 120, tags: [AI_AGENTS_TAG] },
);

/** When each skill last ran at all */
export const cachedLastRuns = unstable_cache(async () => rpcJson<Record<string, string>>("ai_agent_last_runs", {}), ["ai-agent-last-runs"], { revalidate: 600, tags: [AI_AGENTS_TAG] });
