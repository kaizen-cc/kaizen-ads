import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshBriefing } from "./briefing";
import { collectDrive, collectGmail, contactMap, gmailMailboxes, googleConfigured } from "./google";
import { getCursor, saveItems, setCursor, type CollectResult } from "./shared";
import { collectMeta, metaConfigured } from "./meta";
import { collectSlack, slackConfigured } from "./slack";

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

async function pool<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>) {
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

/** Pull what's new from one source. Each runs on its own schedule slot with its own time limit. */
export async function collectStep(admin: SupabaseClient, step: Step, budgetMs = 600_000) {
  const deadline = Date.now() + budgetMs;
  if (step === "meta") return metaConfigured() ? [await collect(admin, "meta", () => collectMeta(admin))] : [{ source: "meta", skipped: "META_SYSTEM_USER_TOKEN not set" }];
  if (step === "slack") return slackConfigured() ? [await collect(admin, "slack", () => collectSlack(admin))] : [{ source: "slack", skipped: "not set up" }];
  if (!googleConfigured()) return [{ source: step, skipped: "Google not set up" }];
  if (step === "drive") return [await collect(admin, "drive", (since) => collectDrive(admin, since))];
  // Every mailbox keeps its own cursor, so someone new to the org starts with their last 30 days,
  // and a mailbox not reached before the time runs out is simply first in line next run
  const [mailboxes, contacts] = await Promise.all([gmailMailboxes(), contactMap(admin)]);
  const { data: states } = await admin.from("sync_state").select("source, last_run_at").like("source", "gmail:%");
  const last = new Map((states ?? []).map((s) => [s.source as string, (s.last_run_at as string) ?? ""]));
  mailboxes.sort((a, b) => (last.get(`gmail:${a}`) ?? "").localeCompare(last.get(`gmail:${b}`) ?? ""));
  return pool(mailboxes, 6, async (m): Promise<Record<string, unknown>> =>
    Date.now() > deadline ? { source: `gmail:${m}`, deferred: true } : collect(admin, `gmail:${m}`, (since) => collectGmail(m, since, contacts)),
  );
}

/** Step 2: refresh the briefings of clients with news, stalest first, until the time budget runs out. */
/** rebuild: redo every briefing from the last 30 days instead of only clients with news. */
export async function refreshAll(admin: SupabaseClient, budgetMs = 700_000, rebuild = false) {
  const deadline = Date.now() + budgetMs;
  const [{ data: list }, { data: done }] = await Promise.all([
    admin.from("clients").select("id, name").eq("creative_package", true),
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
