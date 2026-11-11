import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANTHROPIC_REGISTRY, changes, latestByName, nonRemoteNames, OFFICIAL_REGISTRY, pullRegistry, sinceFrom, toEntry, weeklyNoticeDue, type Entry, type Fetcher, type Pull } from "./registry";

// The catalog sync (cron step "connectors", daily, and Refresh now in Settings): new and changed servers from the
// registry into ai_connector_registry, never deleted (one that's no longer active is marked unavailable). Anthropic's
// registry first; whenever it has nothing, the official MCP registry too, each with its own place to carry on from
// (state rows "main" and "official"). Pages are read and saved a batch at a time until the time budget runs out, so a
// first full pull (about 620 pages of the official registry today) finishes in a run or two and a cut-off run loses
// nothing. A connector execs already offer follows its registry entry (a new URL or version updates it). Execs hear
// about new ones once a week, never for a first pull.

const MAIN = "main";
const OFFICIAL = "official";
const CHUNK = 150;
/** Pages read before saving (and moving the cursor on) */
const BATCH_PAGES = 25;

type State = { id: string; source: string | null; cursor: string | null; cursor_since: string | null; last_complete_at: string | null; first_pull_done: boolean; last_notice_at: string | null };
const blank = (id: string): State => ({ id, source: null, cursor: null, cursor_since: null, last_complete_at: null, first_pull_done: false, last_notice_at: null });

const fetcher: Fetcher = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": "KaizenAds-ConnectorSync/1.0" }, signal: AbortSignal.timeout(20_000) });

type Totals = { pages: number; remote: number; added: number; changed: number; followed: number; unavailable: number };

/** The featured/vendor columns come with 20261111120000_connector_directory.sql; before it, rows are saved without them */
const missingColumn = (e: { code?: string; message?: string } | null) => Boolean(e && (e.code === "PGRST204" || e.code === "42703" || /featured|vendor/.test(e.message ?? "")));

async function saveEntries(admin: SupabaseClient, entries: Entry[], source: string, now: string, t: Totals, legacy: { on: boolean }): Promise<string | null> {
  const moved: { name: string; url: string; version: string | null; urlChanged: boolean }[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const { data: known } = await admin.from("ai_connector_registry").select("name, url, version, status, available, first_seen_at, changed_at").in("name", chunk.map((e) => e.name));
    const rows = (known ?? []) as { name: string; url: string; version: string | null; status: string; available: boolean; first_seen_at: string; changed_at: string | null }[];
    const diff = new Map(changes(chunk, rows).map((c) => [c.name, c]));
    const upserts = chunk.map((e) => {
      const k = rows.find((r) => r.name === e.name);
      const c = diff.get(e.name);
      if (c?.isNew) t.added++;
      else if (c) t.changed++;
      if (c && !c.isNew && (c.urlChanged || c.versionChanged)) moved.push({ name: e.name, url: e.url, version: e.version, urlChanged: c.urlChanged });
      const row: Record<string, unknown> = { ...e, source, first_seen_at: k?.first_seen_at ?? now, changed_at: c && !c.isNew ? now : (k?.changed_at ?? null), last_seen_at: now };
      if (legacy.on) {
        delete row.featured;
        delete row.vendor;
      }
      return row;
    });
    let { error } = await admin.from("ai_connector_registry").upsert(upserts, { onConflict: "name" });
    if (error && !legacy.on && missingColumn(error)) {
      legacy.on = true;
      const plain = upserts.map((r) => {
        const x = { ...r };
        delete x.featured;
        delete x.vendor;
        return x;
      });
      ({ error } = await admin.from("ai_connector_registry").upsert(plain, { onConflict: "name" }));
    }
    if (error) return error.message;
  }
  t.remote += entries.length;

  // Connectors offered from the registry follow it
  if (moved.length) {
    const { data: offered } = await admin.from("ai_connectors").select("id, registry_name, url, registry_version").in("registry_name", moved.map((m) => m.name));
    for (const c of (offered ?? []) as { id: string; registry_name: string; url: string; registry_version: string | null }[]) {
      const m = moved.find((x) => x.name === c.registry_name)!;
      await admin.from("ai_connectors").update({ url: m.url, registry_version: m.version, updated_at: now }).eq("id", c.id);
      // A new URL means new OAuth endpoints and a new registration
      if (m.urlChanged && c.url !== m.url) await admin.from("ai_connector_secrets").update({ auth_meta: null, auth_meta_at: null, reg_client_id: null, reg_redirect_uri: null, reg_secret_iv: null, reg_secret_tag: null, reg_secret_ciphertext: null }).eq("connector_id", c.id);
    }
    t.followed += moved.length;
  }
  return null;
}

/**
 * One registry, from where its state says, a batch of pages at a time until it's done, a page fails, or the deadline
 * passes. The state is saved after every batch.
 */
async function syncSource(admin: SupabaseClient, base: string, state: State, o: { fetcher: Fetcher; now: string; deadline: number; maxPages: number; clock: () => number; legacy: { on: boolean } }) {
  const t: Totals = { pages: 0, remote: 0, added: 0, changed: 0, followed: 0, unavailable: 0 };
  // A source that changed under the state (a different registry URL) starts over
  let st: State = state.source && state.source !== base ? { ...blank(state.id), last_notice_at: state.last_notice_at, first_pull_done: state.first_pull_done } : state;
  const since = st.cursor ? st.cursor_since : sinceFrom(st.last_complete_at);
  const wasFirstPullDone = st.first_pull_done;
  let last: Pull | null = null;
  let error: string | null = null;
  let items = 0;
  for (;;) {
    const pull = await pullRegistry({ fetcher: o.fetcher, since, cursor: st.cursor, maxPages: Math.min(BATCH_PAGES, o.maxPages - t.pages), bases: [base], deadline: o.deadline, now: o.clock });
    last = pull;
    // Not reached at all: the cursor stays where it was for the next run
    if (!pull.pages && pull.error) {
      error = pull.error;
      await admin.from("ai_connector_registry_state").upsert({ ...st, last_run_at: o.now, last_error: pull.error }, { onConflict: "id" });
      break;
    }
    t.pages += pull.pages;
    items += pull.items.length;
    const entries = latestByName(pull.items.map(toEntry).filter((e): e is Entry => Boolean(e)));
    const saveErr = entries.length ? await saveEntries(admin, entries, base, o.now, t, o.legacy) : null;
    if (saveErr) {
      error = saveErr;
      break; // the cursor stays where it was: this batch is read again next time
    }
    // A server whose latest version is no longer remote: unavailable here, kept
    const gone = nonRemoteNames(pull.items);
    if (gone.length) {
      await admin.from("ai_connector_registry").update({ available: false, status: "not_remote", changed_at: o.now }).in("name", gone).eq("available", true);
      t.unavailable += gone.length;
    }
    const firstDone = st.first_pull_done || (pull.complete && !since);
    st = {
      ...st,
      source: base,
      cursor: pull.cursor,
      cursor_since: pull.cursor ? since : null,
      last_complete_at: pull.complete ? o.now : st.last_complete_at,
      first_pull_done: firstDone,
    };
    await admin.from("ai_connector_registry_state").upsert({ ...st, last_run_at: o.now, last_error: pull.error, last_count: items }, { onConflict: "id" });
    if (pull.error) error = pull.error;
    if (pull.complete || pull.error || !pull.cursor || o.clock() >= o.deadline || t.pages >= o.maxPages) break;
  }
  return { base, since, state: st, totals: t, items, complete: Boolean(last?.complete) && !error, error, firstPullFinished: !wasFirstPullDone && st.first_pull_done, reached: t.pages > 0 };
}

export type SyncResult = {
  skipped?: string;
  source?: string;
  sources?: string[];
  since?: string | null;
  pages?: number;
  complete?: boolean;
  remote?: number;
  added?: number;
  changed?: number;
  followed?: number;
  unavailable?: number;
  noticed?: number;
  catalog?: number;
  error?: string | null;
  ms?: number;
};

export async function syncConnectorRegistry(admin: SupabaseClient, opts: { fetcher?: Fetcher; now?: Date; maxPages?: number; budgetMs?: number; clock?: () => number } = {}): Promise<SyncResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const now = (opts.now ?? new Date()).toISOString();
  const { data: rows, error: stErr } = await admin.from("ai_connector_registry_state").select("*").in("id", [MAIN, OFFICIAL]);
  if (stErr) return { skipped: "Connectors need the latest database update first." };
  const states = (rows ?? []) as State[];
  const main = states.find((s) => s.id === MAIN) ?? blank(MAIN);
  const official = states.find((s) => s.id === OFFICIAL) ?? blank(OFFICIAL);
  const o = { fetcher: opts.fetcher ?? fetcher, now, deadline: started + (opts.budgetMs ?? 600_000), maxPages: opts.maxPages ?? 2000, clock, legacy: { on: false } };

  // One registry set by hand (CONNECTOR_REGISTRY_URL) replaces both
  const only = process.env.CONNECTOR_REGISTRY_URL?.replace(/\/$/, "");
  const runs: Awaited<ReturnType<typeof syncSource>>[] = [];
  const first = await syncSource(admin, only || ANTHROPIC_REGISTRY, main, o);
  runs.push(first);
  if (!only) {
    // Anthropic's registry has nothing (this pull brought nothing and nothing from it is stored) or can't be reached:
    // the official registry too
    let anthropicHas = first.items > 0;
    if (!anthropicHas && first.reached) {
      const { count } = await admin.from("ai_connector_registry").select("name", { count: "exact", head: true }).eq("source", ANTHROPIC_REGISTRY);
      anthropicHas = (count ?? 0) > 0;
    }
    if (!anthropicHas) runs.push(await syncSource(admin, OFFICIAL_REGISTRY, official, o));
  }

  // Once a week: one bell notice to the execs if anything new came in. A first full pull restarts the clock (what it
  // found isn't "new"), and none goes out while one is still under way.
  const mainNow = runs[0].state;
  let lastNotice = mainNow.last_notice_at;
  const firstPullRunning = runs.some((r) => r.reached && !r.state.first_pull_done);
  if (runs.some((r) => r.firstPullFinished)) lastNotice = now;
  let noticed = 0;
  if (!firstPullRunning && lastNotice !== now && weeklyNoticeDue(lastNotice, true, Date.parse(now))) {
    const { count } = await admin.from("ai_connector_registry").select("name", { count: "exact", head: true }).eq("available", true).gt("first_seen_at", lastNotice ?? "1970-01-01");
    lastNotice = now;
    if (count) {
      const { data: execs } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
      noticed = (execs ?? []).length;
      if (noticed)
        await admin.from("notifications").upsert(
          (execs ?? []).map((e) => ({
            profile_id: e.id,
            kind: "ai",
            title: `${count} new connector${count === 1 ? "" : "s"} available`,
            body: "New services in the MCP registry the team could connect in Kaizen AI. Add the ones you want from the Directory in Settings, Connections.",
            href: "/settings?tab=connections&section=team&add=directory",
            key: `connectors-new:${now.slice(0, 10)}`,
            priority: "normal",
          })),
          { onConflict: "profile_id,key", ignoreDuplicates: true },
        );
    }
  }
  if (lastNotice !== mainNow.last_notice_at) await admin.from("ai_connector_registry_state").upsert({ ...mainNow, last_notice_at: lastNotice }, { onConflict: "id" });

  const sum = (k: keyof Totals) => runs.reduce((n, r) => n + r.totals[k], 0);
  const used = runs[runs.length - 1];
  const { count: catalog } = await admin.from("ai_connector_registry").select("name", { count: "exact", head: true }).eq("available", true);
  return {
    source: used.base,
    sources: runs.map((r) => r.base),
    since: used.since,
    pages: sum("pages"),
    complete: used.complete,
    remote: sum("remote"),
    added: sum("added"),
    changed: sum("changed"),
    followed: sum("followed"),
    unavailable: sum("unavailable"),
    noticed,
    catalog: catalog ?? 0,
    error: runs.map((r) => r.error).filter(Boolean).join(" ") || null,
    ms: clock() - started,
  };
}
