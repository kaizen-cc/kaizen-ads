"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/error-report";

export type SyncJob = "kpi" | "slack" | "gmail" | "drive" | "meta" | "calls" | "verticals" | "asana" | "sheet" | "docs";
const JOBS: SyncJob[] = ["kpi", "slack", "gmail", "drive", "meta", "calls", "verticals", "asana", "sheet", "docs"];

/** Runs one job the way the schedule does. */
async function runJob(job: SyncJob) {
  const admin = createAdminClient();
  if (job === "kpi") return (await import("@/lib/kpi/sync")).refreshAllKpis(admin, 600_000);
  if (job === "calls") return (await import("@/lib/calls")).collectCalls(admin);
  if (job === "verticals") return (await import("@/lib/verticals")).keepVerticals(admin);
  if (job === "docs") return (await import("@/lib/context/docs")).watchDocs(admin);
  if (job === "sheet") {
    const { sheetConfigured, syncAccountSheet } = await import("@/lib/account-sheet");
    if (!sheetConfigured()) throw new Error("Google isn't connected");
    return syncAccountSheet(admin);
  }
  if (job === "asana") {
    const { asanaConfigured, syncAsana } = await import("@/lib/asana");
    if (!asanaConfigured()) throw new Error("ASANA_TOKEN isn't set in Vercel yet");
    return syncAsana(admin);
  }
  return (await import("@/lib/context/run")).collectStep(admin, job, 600_000);
}

/**
 * Sync health's "Sync now": runs a whole job on the server, outside its schedule (leaving or refreshing the page
 * doesn't stop it), and notes it as running (sync_state "run:<job>") so the card can show its progress until it's done.
 */
export async function syncNow(job: SyncJob): Promise<{ ok: true } | { error: string }> {
  const me = await requireExec();
  if (!JOBS.includes(job)) return { error: "Unknown sync" };
  if (!adminConfigured()) return { error: "Server key missing" };
  const admin = createAdminClient();
  const source = `run:${job}`;
  const { data: prev } = await admin.from("sync_state").select("last_result").eq("source", source).maybeSingle();
  const p = prev?.last_result as { running?: boolean; startedAt?: string; durationMs?: number } | null;
  if (p?.running && p.startedAt && Date.now() - Date.parse(p.startedAt) < 14 * 60_000) return { error: "Already running" };
  const startedAt = new Date().toISOString();
  // How long the last run took, for the progress estimate on jobs that can't be counted
  await admin.from("sync_state").upsert({ source, last_run_at: startedAt, last_result: { running: true, startedAt, by: me.fullName, durationMs: p?.durationMs ?? null } });
  after(async () => {
    let result: unknown;
    let error: string | null = null;
    try {
      result = await runJob(job);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await reportError({ message: `Sync now (${job}): ${error}`, path: "/settings?tab=sync", kind: "server", stack: e instanceof Error ? e.stack : null });
    }
    // Each job reports its own progress and finish; only close the run here if it didn't (or failed before starting)
    const { data: now } = await admin.from("sync_state").select("last_result").eq("source", source).maybeSingle();
    const cur = (now?.last_result ?? {}) as Record<string, unknown>;
    if (cur.running || error)
      await admin.from("sync_state").upsert({
        source,
        last_run_at: new Date().toISOString(),
        last_result: { ...cur, running: false, startedAt: cur.startedAt ?? startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(String(cur.startedAt ?? startedAt)), by: me.fullName, error, summary: summarize(result) },
      });
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** A short line from a job's result, for the card. */
function summarize(r: unknown): string {
  if (!r || typeof r !== "object") return "";
  if (Array.isArray(r)) {
    const items = r.reduce((n, x) => n + Number((x as { items?: number }).items ?? 0), 0);
    const errors = r.filter((x) => (x as { error?: string }).error).length;
    const deferred = r.filter((x) => (x as { deferred?: boolean }).deferred).length;
    return [`${items} new items`, errors && `${errors} failed`, deferred && `${deferred} left for the next run`].filter(Boolean).join(", ");
  }
  const o = r as Record<string, unknown>;
  if ("accounts" in o) return [`${o.accounts} accounts`, Array.isArray(o.errors) && o.errors.length && `${o.errors.length} failed`, Number(o.deferred) && `${o.deferred} left for the next run`].filter(Boolean).join(", ");
  return Object.entries(o)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

/** Retry one failing (or behind) source now and wait for it: an ad account's KPIs or an inbox. */
export async function syncOne(source: string): Promise<{ ok: true; note: string } | { error: string }> {
  await requireExec();
  if (!adminConfigured()) return { error: "Server key missing" };
  const admin = createAdminClient();
  try {
    if (source.startsWith("kpi:")) {
      const r = (await (await import("@/lib/kpi/sync")).refreshAccountKpis(admin, source.slice(4))) as { error?: string; deferred?: boolean };
      revalidatePath("/settings");
      return r.error ? { error: r.error } : { ok: true, note: "Pulled and recomputed" };
    }
    if (source.startsWith("gmail:")) {
      const r = (await (await import("@/lib/context/run")).collectMailbox(admin, source.slice(6))) as { error?: string; items?: number };
      revalidatePath("/settings");
      return r.error ? { error: r.error } : { ok: true, note: `${r.items ?? 0} new` };
    }
    return { error: "This one syncs with its whole group" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
