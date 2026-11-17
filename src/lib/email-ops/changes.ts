import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readChangeObjects } from "@/lib/klaviyo/api";
import { changeLines, diffChanges, lastManual, type ChangeEvent, type ChangeState } from "./changes-core";

// The email account's change history: read on each Klaviyo sync (what changed since the last read, from created and
// updated times and statuses), kept in email_account_changes, and read back by the account sheet, the sprint checks,
// the audit and the chat. Never fails a sync: a read that goes wrong is noted and tried again next time.

/** Where the last read's statuses are kept between syncs (sync_state, server only) */
const stateSource = (clientId: string) => `klaviyo-changes:${clientId}`;
const FIRST_LOOK_DAYS = 30;
/** Each read looks back a little before the last one, so nothing falls between two reads */
const OVERLAP_MS = 2 * 3_600_000;

type Memo = ChangeState & { error?: string | null; readAt?: string };

/** One read: what changed since the last, saved. Returns how many new changes, or the error in plain words. */
export async function recordKlaviyoChanges(admin: SupabaseClient, clientId: string, key: string): Promise<{ added: number; error: string | null }> {
  const { data: m } = await admin.from("sync_state").select("last_result").eq("source", stateSource(clientId)).maybeSingle();
  const prev = (m?.last_result as Memo | null) ?? null;
  const now = new Date().toISOString();
  const since = prev?.at ? new Date(Date.parse(prev.at) - OVERLAP_MS).toISOString() : new Date(Date.now() - FIRST_LOOK_DAYS * 86_400_000).toISOString();
  try {
    const read = await readChangeObjects(key, since);
    const { events, state } = diffChanges(read.objects, prev?.status ? prev : null, { since, now, complete: read.complete });
    const rows = events.map((e) => ({
      client_id: clientId,
      provider: "klaviyo",
      object_type: e.type,
      object_id: e.objectId,
      object_name: e.name.slice(0, 300),
      kind: e.kind,
      detail: e.detail,
      parent_name: e.parent ?? null,
      step_kind: e.step ?? null,
      manual: e.manual,
      happened_at: e.at,
      dedupe_key: e.key,
    }));
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await admin.from("email_account_changes").upsert(rows.slice(i, i + 500), { onConflict: "client_id,dedupe_key", ignoreDuplicates: true }).select("id");
      // Before the migration is applied: keep the statuses anyway, so the first real read compares from here
      if (error) throw new Error(/relation .* does not exist|schema cache/i.test(error.message) ? "The change history table isn't set up yet." : error.message);
      added += data?.length ?? 0;
    }
    const error = read.errors.length ? `Part of the change history couldn't be read: ${read.errors.join("; ")}`.slice(0, 400) : null;
    await admin.from("sync_state").upsert({ source: stateSource(clientId), last_run_at: now, last_result: { ...state, readAt: now, error } satisfies Memo });
    return { added, error };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    // The statuses stay as they were (so nothing is missed next time); only the error and when are noted
    await admin.from("sync_state").upsert({ source: stateSource(clientId), last_run_at: now, last_result: { at: prev?.at ?? "", status: prev?.status ?? {}, readAt: now, error } satisfies Memo });
    return { added: 0, error };
  }
}

export type AccountChange = Pick<ChangeEvent, "type" | "name" | "kind" | "detail" | "parent" | "step" | "manual" | "at"> & { id: string };

const toChange = (r: Record<string, unknown>): AccountChange => ({
  id: r.id as string,
  type: r.object_type as AccountChange["type"],
  name: (r.object_name as string) ?? "",
  kind: r.kind as AccountChange["kind"],
  detail: (r.detail as string | null) ?? null,
  parent: (r.parent_name as string | null) ?? null,
  step: (r.step_kind as string | null) ?? null,
  manual: r.manual !== false,
  at: r.happened_at as string,
});

/** The latest changes in a client's email account, newest first (through whatever session is given) */
export async function loadAccountChanges(db: SupabaseClient, clientId: string, opts: { since?: string; limit?: number } = {}): Promise<AccountChange[]> {
  let q = db.from("email_account_changes").select("id, object_type, object_name, kind, detail, parent_name, step_kind, manual, happened_at").eq("client_id", clientId).order("happened_at", { ascending: false }).limit(opts.limit ?? 60);
  if (opts.since) q = q.gte("happened_at", opts.since);
  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as Record<string, unknown>[]).map(toChange);
}

/** When the change history was last read for a client, and what went wrong if it did (server's rights) */
export async function changeReadState(admin: SupabaseClient, clientId: string): Promise<{ readAt: string | null; error: string | null }> {
  const { data } = await admin.from("sync_state").select("last_result").eq("source", stateSource(clientId)).maybeSingle();
  const m = (data?.last_result as Memo | null) ?? null;
  return { readAt: m?.readAt ?? null, error: m?.error ?? null };
}

/** The changes as a block for an AI prompt (the audit, the chat, a sprint check) */
export async function changesBlock(db: SupabaseClient, clientId: string, days = 30): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const list = await loadAccountChanges(db, clientId, { since, limit: 80 });
  const last = lastManual(list);
  return `<changes_in_the_email_account_${days}d note="read from Klaviyo's created and updated times and statuses on each sync: several edits between two reads show as one, and who made them is not known">\n${list.length ? changeLines(list, 40).join("\n") : "(none seen: nothing was created, edited, scheduled or switched on or off in this time)"}\n${last ? `Last change someone made: ${last.at.slice(0, 10)}.` : "No change by anyone in this time."}\n</changes_in_the_email_account_${days}d>`;
}
