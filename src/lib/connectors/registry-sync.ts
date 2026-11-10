import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { changes, latestByName, nonRemoteNames, pullRegistry, sinceFrom, toEntry, weeklyNoticeDue, type Entry, type Fetcher } from "./registry";

// The daily catalog sync (cron step "connectors"): new and changed servers from the registry into
// ai_connector_registry, never deleted (one that's no longer active is marked unavailable). A connector execs already
// offer follows its registry entry (a new URL or version updates it). Execs hear about new ones once a week.

const STATE = "main";
const CHUNK = 300;

type State = { id: string; source: string | null; cursor: string | null; cursor_since: string | null; last_complete_at: string | null; first_pull_done: boolean; last_notice_at: string | null };

const fetcher: Fetcher = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": "KaizenAds-ConnectorSync/1.0" }, signal: AbortSignal.timeout(20_000) });

export async function syncConnectorRegistry(admin: SupabaseClient, opts: { fetcher?: Fetcher; now?: Date; maxPages?: number } = {}) {
  const now = (opts.now ?? new Date()).toISOString();
  const { data: st, error: stErr } = await admin.from("ai_connector_registry_state").select("*").eq("id", STATE).maybeSingle();
  if (stErr) return { skipped: "Connectors need the latest database update first." };
  const state: State = (st as State | null) ?? { id: STATE, source: null, cursor: null, cursor_since: null, last_complete_at: null, first_pull_done: false, last_notice_at: null };
  const since = state.cursor ? state.cursor_since : sinceFrom(state.last_complete_at);
  const base = process.env.CONNECTOR_REGISTRY_URL?.replace(/\/$/, "");
  const pull = await pullRegistry({ fetcher: opts.fetcher ?? fetcher, since, cursor: state.cursor, maxPages: opts.maxPages ?? 60, ...(base ? { bases: [base] } : {}) });

  const entries = latestByName(pull.items.map(toEntry).filter((e): e is Entry => Boolean(e)));
  let added = 0;
  let changed = 0;
  const moved: { name: string; url: string; version: string | null; urlChanged: boolean }[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const { data: known } = await admin.from("ai_connector_registry").select("name, url, version, status, available, first_seen_at, changed_at").in("name", chunk.map((e) => e.name));
    const rows = (known ?? []) as { name: string; url: string; version: string | null; status: string; available: boolean; first_seen_at: string; changed_at: string | null }[];
    const diff = new Map(changes(chunk, rows).map((c) => [c.name, c]));
    const upserts = chunk.map((e) => {
      const k = rows.find((r) => r.name === e.name);
      const c = diff.get(e.name);
      if (c?.isNew) added++;
      else if (c) changed++;
      if (c && !c.isNew && (c.urlChanged || c.versionChanged)) moved.push({ name: e.name, url: e.url, version: e.version, urlChanged: c.urlChanged });
      return { ...e, source: pull.source, first_seen_at: k?.first_seen_at ?? now, changed_at: c && !c.isNew ? now : (k?.changed_at ?? null), last_seen_at: now };
    });
    const { error } = await admin.from("ai_connector_registry").upsert(upserts, { onConflict: "name" });
    if (error) return { error: error.message, pages: pull.pages };
  }
  // A server whose latest version is no longer remote: unavailable here, kept
  const gone = nonRemoteNames(pull.items);
  if (gone.length) await admin.from("ai_connector_registry").update({ available: false, status: "not_remote", changed_at: now }).in("name", gone).eq("available", true);

  // Connectors offered from the registry follow it
  if (moved.length) {
    const { data: offered } = await admin.from("ai_connectors").select("id, registry_name, url, registry_version").in("registry_name", moved.map((m) => m.name));
    for (const c of (offered ?? []) as { id: string; registry_name: string; url: string; registry_version: string | null }[]) {
      const m = moved.find((x) => x.name === c.registry_name)!;
      await admin.from("ai_connectors").update({ url: m.url, registry_version: m.version, updated_at: now }).eq("id", c.id);
      // A new URL means new OAuth endpoints and a new registration
      if (m.urlChanged && c.url !== m.url) await admin.from("ai_connector_secrets").update({ auth_meta: null, auth_meta_at: null, reg_client_id: null, reg_redirect_uri: null, reg_secret_iv: null, reg_secret_tag: null, reg_secret_ciphertext: null }).eq("connector_id", c.id);
    }
  }

  const firstPullDone = state.first_pull_done || (pull.complete && !since);
  const next: State = {
    ...state,
    source: pull.source,
    cursor: pull.cursor,
    cursor_since: pull.cursor ? since : null,
    last_complete_at: pull.complete ? now : state.last_complete_at,
    first_pull_done: firstPullDone,
    // The first full pull starts the weekly clock: what it found isn't "new"
    last_notice_at: !state.first_pull_done && firstPullDone ? now : state.last_notice_at,
  };

  // Once a week: one bell notice to the execs if anything new came in
  let noticed = 0;
  if (weeklyNoticeDue(state.last_notice_at, state.first_pull_done, Date.parse(now))) {
    const { count } = await admin.from("ai_connector_registry").select("name", { count: "exact", head: true }).eq("available", true).gt("first_seen_at", state.last_notice_at ?? "1970-01-01");
    next.last_notice_at = now;
    if (count) {
      const { data: execs } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
      noticed = (execs ?? []).length;
      if (noticed)
        await admin.from("notifications").upsert(
          (execs ?? []).map((e) => ({
            profile_id: e.id,
            kind: "ai",
            title: `${count} new connector${count === 1 ? "" : "s"} available`,
            body: "New services in the MCP registry the team could connect in Kaizen AI. Offer the ones you want in Settings, Connectors.",
            href: "/settings?tab=connectors&view=catalog",
            key: `connectors-new:${now.slice(0, 10)}`,
            priority: "normal",
          })),
          { onConflict: "profile_id,key", ignoreDuplicates: true },
        );
    }
  }
  await admin.from("ai_connector_registry_state").upsert({ ...next, last_run_at: now, last_error: pull.error, last_count: entries.length }, { onConflict: "id" });
  return { source: pull.source, since, pages: pull.pages, complete: pull.complete, remote: entries.length, added, changed, followed: moved.length, unavailable: gone.length, noticed, error: pull.error };
}
