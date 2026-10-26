import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditSummary, QuickAction } from "@/app/(team)/kpis/audit-panel";
import { inPlatform } from "@/lib/in-platform";

// The latest audit on each KPI, as the KPI board and the client page both show it. Both read the same audits, so one
// started from either place shows in both.

type Raw = { title: string; short?: string; area: string; owner: string; when: string; effort: string; impact: string; steps?: string[]; why: string; inPlatform?: boolean };

export async function latestAudits(db: SupabaseClient, targetIds?: string[]) {
  let q = db.from("account_audits").select("id, target_id, status, progress, step, steps, created_at, result, done, error, auto, profiles(full_name), kpi_targets(platform)").order("created_at", { ascending: false });
  q = targetIds ? q.in("target_id", targetIds.length ? targetIds : ["00000000-0000-0000-0000-000000000000"]).limit(100) : q.limit(400);
  const { data: audits } = await q;
  // A run left "running" 15+ minutes timed out
  const stale = new Date(Date.now() - 15 * 60_000).toISOString();
  const by = new Map<string, AuditSummary>();
  for (const a of audits ?? []) {
    if (by.has(a.target_id)) continue;
    const res = a.result as { verdict?: NonNullable<AuditSummary>["verdict"]; actions?: Raw[] } | null;
    const platform = ((a.kpi_targets as unknown as { platform: string } | null)?.platform === "google" ? "google" : "meta") as "google" | "meta";
    const done = (a.done ?? {}) as Record<string, unknown>;
    // The moves Kaizen Ads can make in the ad account itself, for the quick list under the verdict
    const quick: QuickAction[] = (res?.actions ?? [])
      .map((x, index) => ({ x, index }))
      .filter(({ x }) => x.owner === "media_buyer" && inPlatform(x, platform))
      .map(({ x, index }) => ({ index, label: x.short?.trim() || x.title, title: x.title, area: x.area, when: x.when, effort: x.effort, impact: x.impact, steps: x.steps ?? [], why: x.why, done: Boolean(done[String(index)]) }));
    const timedOut = a.status === "running" && a.created_at < stale;
    by.set(a.target_id, {
      id: a.id,
      status: (timedOut ? "failed" : a.status) as NonNullable<AuditSummary>["status"],
      progress: a.progress,
      step: a.step,
      createdAt: a.created_at,
      by: a.auto ? "Kaizen Ads (the account is off target)" : ((a.profiles as unknown as { full_name: string } | null)?.full_name ?? null),
      verdict: res?.verdict ?? null,
      actions: res?.actions?.length ?? 0,
      done: Object.keys(done).length,
      quick,
      platform,
      error: timedOut ? "It didn't finish in time. Try again." : a.error,
      steps: (a.steps ?? []) as NonNullable<AuditSummary>["steps"],
    });
  }
  return by;
}
