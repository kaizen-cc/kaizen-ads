import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshBriefing } from "./briefing";
import { collectDrive, collectGmail, gmailMailboxes, googleConfigured } from "./google";
import { getCursor, saveItems, setCursor, type CollectResult } from "./shared";
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
    return { source, items: items.length };
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

export async function runContextSync(admin: SupabaseClient, budgetMs = 240_000) {
  const deadline = Date.now() + budgetMs;
  const sources = [];
  if (slackConfigured()) sources.push(await collect(admin, "slack", (since) => collectSlack(admin, since)));
  if (googleConfigured()) {
    sources.push(await collect(admin, "drive", (since) => collectDrive(admin, since)));
    for (const mailbox of gmailMailboxes()) sources.push(await collect(admin, `gmail:${mailbox}`, (since) => collectGmail(admin, mailbox, since)));
  }

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
      return { client: c.name, ...(await refreshBriefing(admin, c.id)) };
    } catch (e) {
      return { client: c.name, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return {
    sources,
    refreshed: briefings.filter((b) => !("skipped" in b && b.skipped) && !("deferred" in b)),
    skipped: briefings.filter((b) => "skipped" in b && b.skipped).length,
    deferred: briefings.filter((b) => "deferred" in b).map((b) => b.client),
  };
}
