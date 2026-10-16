import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshBriefing } from "./briefing";
import { collectDrive, collectGmail, contactMap, gmailMailboxes, googleConfigured } from "./google";
import { getCursor, saveItems, setCursor, type CollectResult } from "./shared";
import { collectMeta, metaConfigured } from "./meta";
import { prewriteRefreshes, runFatigue } from "@/lib/fatigue";
import { collectSlack, slackConfigured } from "./slack";
import { LIVE } from "@/lib/live";
import { tracker, type Tracker } from "@/lib/progress";

/** Pull what's new from one source since its cursor, save it, and move the cursor. A failure stays with that source. */
async function collect(admin: SupabaseClient, source: string, run: (since: Date) => Promise<CollectResult>) {
  const started = new Date();
  const since = await getCursor(admin, source);
  try {
    const { items, notes } = await run(since);
    await saveItems(admin, items);
    // Small overlap so a message posted mid-run isn't missed; duplicates are ignored on save
    await setCursor(admin, source, new Date(started.getTime() - 5 * 60_000), { ok: true, items: items.length, ...notes });
    return { source, items: items.length + Number(notes?.saved ?? 0) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("sync_state").upsert({ source, last_run_at: started.toISOString(), last_result: { ok: false, error } });
    return { source, error };
  }
}

export async function pool<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, list.length) }, async () => {
      while (next < list.length) out.push(await fn(list[next++]));
    }),
  );
  return out;
}

export type Step = "slack" | "drive" | "gmail" | "meta";

/** One inbox now (Sync health's Retry). */
export async function collectMailbox(admin: SupabaseClient, mailbox: string) {
  if (!googleConfigured()) return { source: `gmail:${mailbox}`, error: "Google not set up" };
  return collect(admin, `gmail:${mailbox}`, async (since) => collectGmail(mailbox, since, await contactMap(admin)));
}

/** Pull what's new from one source. Each runs on its own schedule slot with its own time limit. */
export async function collectStep(admin: SupabaseClient, step: Step, budgetMs = 600_000) {
  // Live progress for Sync health, whoever started the run
  const t = await tracker(admin, step, step === "meta" ? "ad accounts" : step === "slack" ? "channels" : step === "gmail" ? "inboxes" : "files");
  try {
    const out = await runStep(admin, step, budgetMs, t);
    const failed = out.filter((x) => (x as { error?: string }).error).length;
    const items = out.reduce((n, x) => n + Number((x as { items?: number }).items ?? 0), 0);
    await t.finish({ summary: `${items} new items${failed ? `, ${failed} failed` : ""}` });
    return out;
  } catch (e) {
    await t.finish({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function runStep(admin: SupabaseClient, step: Step, budgetMs: number, t: Tracker): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + budgetMs;
  if (step === "meta") {
    if (!metaConfigured()) return [{ source: "meta", skipped: "META_SYSTEM_USER_TOKEN not set" }];
    // Leave time after the pull (the function stops at about 13 minutes): the Hall of Fame first, then the rest
    const out = await collect(admin, "meta", () => collectMeta(admin, Math.min(budgetMs * 0.65, 450_000), t));
    const then = async <T>(label: string, run: () => Promise<T>) => {
      t.on(label);
      const r = await run().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      t.tick(null);
      return r;
    };
    // The Hall of Fame: ads that ran 30+ days and beat their target (or their sub-vertical's benchmark)
    const { updateHallOfFame } = await import("@/lib/hall-of-fame");
    const hallOfFame = await then("Updating the Hall of Fame", () => updateHallOfFame(admin, Date.now() + 150_000));
    // Fresh daily numbers: check every ad for fatigue (no AI, just the numbers)
    const fatigue = await then("Checking every ad for fatigue", () => runFatigue(admin));
    // A refresh brief ready for each ad flagged
    const refreshes = await then("Writing refresh briefs for tiring ads", () => prewriteRefreshes(admin));
    // The read of each winning ad, ready before anyone hovers it
    const { analyzeWinners } = await import("@/lib/winner-insight");
    const winners = await then("Reading the winning ads", () => analyzeWinners(admin));
    return [{ ...out, fatigue, refreshes, winners, hallOfFame }];
  }
  if (step === "slack") return slackConfigured() ? [await collect(admin, "slack", () => collectSlack(admin, t))] : [{ source: "slack", skipped: "not set up" }];
  if (!googleConfigured()) return [{ source: step, skipped: "Google not set up" }];
  if (step === "drive") {
    t.on("Listing the client folders");
    return [await collect(admin, "drive", (since) => collectDrive(admin, since, t))];
  }
  // Every mailbox keeps its own cursor, so someone new to the org starts with their last 30 days,
  // and a mailbox not reached before the time runs out is simply first in line next run
  const [mailboxes, contacts] = await Promise.all([gmailMailboxes(), contactMap(admin)]);
  const { data: states } = await admin.from("sync_state").select("source, last_run_at, last_result").like("source", "gmail:%");
  // Offboarded (suspended, archived or deleted in Google Workspace): no longer synced, their email stays as history.
  // Marked so Sync health doesn't count them as behind; if they come back, the next sync clears it.
  const current = new Set(mailboxes.map((m) => `gmail:${m}`));
  const gone = (states ?? []).filter((s) => !current.has(s.source as string) && !(s.last_result as { offboarded?: boolean } | null)?.offboarded);
  for (const s of gone)
    await admin.from("sync_state").update({ last_result: { ...((s.last_result ?? {}) as object), offboarded: true, offboarded_at: new Date().toISOString() } }).eq("source", s.source);
  const last = new Map((states ?? []).map((s) => [s.source as string, (s.last_run_at as string) ?? ""]));
  mailboxes.sort((a, b) => (last.get(`gmail:${a}`) ?? "").localeCompare(last.get(`gmail:${b}`) ?? ""));
  t.total(mailboxes.length);
  return pool(mailboxes, 6, async (m): Promise<Record<string, unknown>> => {
    if (Date.now() > deadline) {
      t.tick(null);
      return { source: `gmail:${m}`, deferred: true };
    }
    t.on(m);
    const r = await collect(admin, `gmail:${m}`, (since) => collectGmail(m, since, contacts));
    t.tick(m, !("error" in r));
    return r;
  });
}

/** Step 2: refresh the briefings of clients with news, stalest first, until the time budget runs out. */
/** rebuild: redo every briefing from the last 30 days instead of only clients with news. */
export async function refreshAll(admin: SupabaseClient, budgetMs = 700_000, rebuild = false) {
  const deadline = Date.now() + budgetMs;
  const [{ data: list }, { data: done }] = await Promise.all([
    admin.from("clients").select("id, name").eq("creative_package", true).is("archived_at", null).in("status", LIVE),
    admin.from("client_briefings").select("client_id, generated_at"),
  ]);
  // Stalest first, so anything deferred last run goes early this time
  const at = new Map((done ?? []).map((b) => [b.client_id, b.generated_at as string]));
  const clients = (list ?? []).sort((a, b) => (at.get(a.id) ?? "").localeCompare(at.get(b.id) ?? ""));
  // Briefings that don't fit in this run's time are picked up by the next one (their news is still newer than their digest)
  const briefings = await pool(clients, 6, async (c) => {
    if (Date.now() > deadline) return { client: c.name, deferred: true };
    try {
      return { client: c.name, ...(await refreshBriefing(admin, c.id, rebuild)) };
    } catch (e) {
      return { client: c.name, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return {
    refreshed: briefings.filter((b) => !("skipped" in b && b.skipped) && !("deferred" in b)),
    skipped: briefings.filter((b) => "skipped" in b && b.skipped).length,
    deferred: briefings.filter((b) => "deferred" in b).map((b) => b.client),
  };
}
