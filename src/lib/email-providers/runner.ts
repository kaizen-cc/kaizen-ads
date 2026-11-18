import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptionKey, seal, unseal } from "@/lib/meta-token-core";
import { LIVE } from "@/lib/live";
import { tracker } from "@/lib/progress";
import { runBounded } from "@/lib/bounded";
import { pickKlaviyoWindow, type KlaviyoWindow } from "../klaviyo/core";
import { errText, memoSource, readProgress, saveMemo, type SyncMemo } from "../klaviyo/store";
import { cleanSecret, emailClientState, plainEmailError, providerName, redactSecret, secretLast4, type CioRegion, type EmailProvider } from "./core";
import { connectedElsewhere, elsewhereMessage } from "./which";
import type { KlaviyoClientState, KlaviyoPlainError } from "../klaviyo/core";

// The connect, sync and roster machinery Brevo and Customer.io share, the way Klaviyo's store does it for Klaviyo: a
// sealed key per client, one read of the numbers into the SAME email tables (with source set), a read memo and progress
// bar in sync_state under the same keys the board and Sync health already read ("klaviyo:<client>", "klaviyo-read:<client>").
// Each provider supplies only its own API reading (a ProviderDef); nothing else is duplicated.

export type ProviderId = Exclude<EmailProvider, "klaviyo">;

export type ConnRow = {
  client_id: string;
  account_id: string;
  account_name: string | null;
  timezone: string | null;
  currency: string | null;
  key_iv: string;
  key_tag: string;
  key_ciphertext: string;
  key_last4: string | null;
  status: string;
  last_synced_at: string | null;
  backfilled_at: string | null;
  last_error: string | null;
  connected_at: string;
  connected_by: string | null;
  revenue_read: boolean | null;
  region?: CioRegion | null;
  revenue_event?: string | null;
};

export type ReadOut = { revenueRead: boolean | null; campaigns: number; flows: number; audiences: number; days: number; seriesError: string | null; storeError: string | null };

export type ConnectExtra = { region?: CioRegion; revenueEvent?: string | null };
export type Step = (pct: number, step: string) => Promise<void>;

export type ProviderDef = {
  id: ProviderId;
  table: string;
  keyProblem(raw: string): string | null;
  /** Checks the key against the provider and says which account it belongs to */
  check(key: string, extra: ConnectExtra): Promise<{ id: string; name: string | null; timezone: string | null; currency: string | null; region?: CioRegion }>;
  /** One read: the recent window or the full 90 days, written into the shared tables */
  read(ctx: { admin: SupabaseClient; conn: ConnRow; key: string; window: KlaviyoWindow; step: Step; /** A full read going further back than the usual 90 days (the history read) */ depth?: number }): Promise<ReadOut>;
  /** An error that means the key was refused */
  refused(e: unknown): boolean;
  costMs(w: KlaviyoWindow): number;
};

const SHARED_TABLES = ["klaviyo_campaigns", "klaviyo_flows", "klaviyo_audiences", "klaviyo_daily", "klaviyo_flow_daily"];

export function keyOfConn(r: Pick<ConnRow, "key_iv" | "key_tag" | "key_ciphertext">): string | null {
  const k = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!k) return null;
  try {
    return unseal({ iv: r.key_iv, tag: r.key_tag, ciphertext: r.key_ciphertext }, k);
  } catch {
    return null;
  }
}

export async function providerReady(admin: SupabaseClient, def: ProviderDef) {
  const { error } = await admin.from(def.table).select("client_id").limit(1);
  return !error;
}

export type ConnectResult = { ok: true; account: string | null; timezone: string | null } | { ok: false; error: string };

/** A pasted key: checked against the provider, refused when that account belongs to another client or the client has another provider, then sealed and saved */
export async function connectProvider(admin: SupabaseClient, def: ProviderDef, clientId: string, rawKey: string, by: string, extra: ConnectExtra = {}): Promise<ConnectResult> {
  const name = providerName(def.id);
  const problem = def.keyProblem(rawKey);
  if (problem) return { ok: false, error: problem };
  const k = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!k) return { ok: false, error: `Add TOKEN_ENCRYPTION_KEY in Vercel first: without it a ${name} key can't be stored safely.` };
  if (!(await providerReady(admin, def))) return { ok: false, error: `${name} isn't set up in the database yet: its migration hasn't been applied.` };
  const other = await connectedElsewhere(admin, clientId, def.id);
  if (other) return { ok: false, error: elsewhereMessage(other) };
  const key = cleanSecret(rawKey);
  try {
    const acc = await def.check(key, extra);
    const { data: dup } = await admin.from(def.table).select("client_id, clients(name)").eq("account_id", acc.id).neq("client_id", clientId).maybeSingle();
    if (dup) return { ok: false, error: `This ${name} account is already connected to ${(dup.clients as unknown as { name: string } | null)?.name ?? "another client"}. Remove it there first.` };
    const { data: had } = await admin.from(def.table).select("account_id").eq("client_id", clientId).maybeSingle();
    const sealed = seal(key, k);
    const now = new Date().toISOString();
    const sameAccount = had?.account_id === acc.id;
    const { error } = await admin.from(def.table).upsert(
      {
        client_id: clientId,
        account_id: acc.id,
        account_name: acc.name,
        timezone: acc.timezone,
        currency: acc.currency,
        key_iv: sealed.iv,
        key_tag: sealed.tag,
        key_ciphertext: sealed.ciphertext,
        key_last4: secretLast4(key),
        connected_by: by,
        connected_at: now,
        status: "active",
        last_error: null,
        updated_at: now,
        ...(acc.region ?? extra.region ? { region: acc.region ?? extra.region } : {}),
        ...(extra.revenueEvent !== undefined ? { revenue_event: extra.revenueEvent, revenue_read: null } : {}),
        // A different account starts over: its own 90 days
        ...(sameAccount ? {} : { backfilled_at: null, last_synced_at: null, revenue_read: null }),
      },
      { onConflict: "client_id" },
    );
    if (error) return { ok: false, error: `Saving the ${name} key: ${error.message}` };
    if (!sameAccount && had) await Promise.all(SHARED_TABLES.map((t) => admin.from(t).delete().eq("client_id", clientId)));
    if (!sameAccount) await admin.from("sync_state").delete().eq("source", memoSource(clientId));
    return { ok: true, account: acc.name, timezone: acc.timezone };
  } catch (e) {
    return { ok: false, error: redactSecret(errText(e), key) };
  }
}

/** Remove: the key is deleted; the email history already read stays with the client (client knowledge is never deleted) */
export async function removeProvider(admin: SupabaseClient, def: ProviderDef, clientId: string) {
  const { error } = await admin.from(def.table).delete().eq("client_id", clientId);
  if (error) return { ok: false as const, error: error.message };
  await admin.from("sync_state").delete().eq("source", memoSource(clientId));
  return { ok: true as const };
}

export type ProviderConnectionView = { provider: ProviderId; account: string | null; accountId: string; timezone: string | null; currency: string | null; last4: string | null; status: string; lastSyncedAt: string | null; backfilled: boolean; error: string | null; connectedAt: string; by: string | null; region: CioRegion | null; revenueEvent: string | null; revenueRead: boolean | null };

/** The client's connection as Team & setup shows it: null when not connected; undefined when the provider isn't set up */
export async function providerConnection(admin: SupabaseClient, def: ProviderDef, clientId: string): Promise<ProviderConnectionView | null | undefined> {
  const { data, error } = await admin.from(def.table).select("*, profiles:connected_by(full_name)").eq("client_id", clientId).maybeSingle();
  if (error) return undefined;
  if (!data) return null;
  const r = data as unknown as ConnRow & { profiles: { full_name: string } | null };
  return {
    provider: def.id,
    account: r.account_name,
    accountId: r.account_id,
    timezone: r.timezone,
    currency: r.currency,
    last4: r.key_last4,
    status: r.status,
    lastSyncedAt: r.last_synced_at,
    backfilled: Boolean(r.backfilled_at),
    error: r.last_error,
    connectedAt: r.connected_at,
    by: r.profiles?.full_name ?? null,
    region: r.region ?? null,
    revenueEvent: r.revenue_event ?? null,
    revenueRead: r.revenue_read,
  };
}

export type ProviderRosterRow = { id: string; name: string; slug: string; account: string | null; last4: string | null; state: KlaviyoClientState; error: KlaviyoPlainError | null; lastSyncedAt: string | null; window: KlaviyoWindow | null; fullAt: string | null };

/**
 * Every live client connected to this provider, for Settings > Sync health. Only the clients that already have it are
 * listed: the ones without any email provider are the Klaviyo card's (it is where a provider is chosen and connected).
 */
export async function providerRoster(admin: SupabaseClient, def: ProviderDef): Promise<ProviderRosterRow[] | null> {
  const { data: conns, error } = await admin.from(def.table).select("client_id, account_name, key_last4, status, last_synced_at, last_error");
  if (error) return null;
  if (!conns?.length) return [];
  const ids = conns.map((c) => c.client_id as string);
  const [{ data: clients }, { data: memos }] = await Promise.all([
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed").in("id", ids).is("archived_at", null).in("status", LIVE).order("name"),
    admin.from("sync_state").select("source, last_result").in("source", ids.map(memoSource)),
  ]);
  const by = new Map(conns.map((c) => [c.client_id as string, c]));
  const memo = new Map((memos ?? []).map((m) => [String(m.source).slice("klaviyo:".length), (m.last_result ?? {}) as SyncMemo]));
  return (clients ?? []).map((c) => {
    const k = by.get(c.id as string)!;
    const m = memo.get(c.id as string);
    const st = emailClientState(def.id, { status: k.status as string, lastSyncedAt: (k.last_synced_at as string | null) ?? null, error: (k.last_error as string | null) ?? null });
    // A part of the read that failed while the rest worked shows as a warning instead of passing silently
    if (!st.error && m?.seriesError) st.error = { message: m.seriesError.slice(0, 160), fix: "It tries again on the next run.", severity: "warn" };
    return { id: c.id as string, name: c.name as string, slug: c.slug as string, account: (k.account_name as string | null) ?? null, last4: (k.key_last4 as string | null) ?? null, state: st.state, error: st.error, lastSyncedAt: (k.last_synced_at as string | null) ?? null, window: m?.window ?? null, fullAt: m?.fullAt ?? null };
  });
}

export type SyncResult = { client: string; ok: boolean; window?: KlaviyoWindow; campaigns?: number; flows?: number; audiences?: number; days?: number; error?: string };

/** One client's read: the full window once a day (or when it never had one), the recent window otherwise; noted for Sync health */
export async function syncProvider(admin: SupabaseClient, def: ProviderDef, clientId: string, opts: { window?: KlaviyoWindow | "auto"; depthDays?: number } = {}): Promise<SyncResult> {
  const name = providerName(def.id);
  const { data: row, error } = await admin.from(def.table).select("*").eq("client_id", clientId).maybeSingle();
  if (error || !row) return { client: clientId, ok: false, error: error ? `${name} isn't set up in the database yet.` : `${name} isn't connected for this client.` };
  const conn = row as ConnRow;
  const { data: m } = await admin.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle();
  const memo = (m?.last_result as SyncMemo | null) ?? null;
  const lastFullAt = memo ? (memo.fullAt ?? null) : conn.last_synced_at;
  const window: KlaviyoWindow = opts.window && opts.window !== "auto" ? opts.window : pickKlaviyoWindow({ lastFullAt });
  const key = keyOfConn(conn);
  if (!key) {
    const msg = "The key can't be read: TOKEN_ENCRYPTION_KEY is missing or changed. Replace the key.";
    await admin.from(def.table).update({ last_error: msg, updated_at: new Date().toISOString() }).eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: msg, account: conn.account_name });
    return { client: clientId, ok: false, window, error: "The key can't be decrypted." };
  }
  const progress = readProgress(admin, clientId);
  const step: Step = async (pct, label) => {
    if (window === "full") await progress(pct, label);
  };
  try {
    const out = await def.read({ admin, conn, key, window, step, depth: opts.depthDays });
    const now = new Date().toISOString();
    await admin
      .from(def.table)
      .update({ last_synced_at: now, updated_at: now, status: "active", last_error: out.revenueRead === false ? `No ecommerce revenue can be read for this ${name} account yet.` : null, revenue_read: out.revenueRead ?? conn.revenue_read, ...(window === "full" && !conn.backfilled_at ? { backfilled_at: now } : {}) })
      .eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: window === "full" ? now : lastFullAt, error: null, account: conn.account_name, seriesError: out.seriesError, storeError: out.storeError });
    if (window === "full") await progress(100, "Done", { done: true });
    return { client: clientId, ok: true, window, campaigns: out.campaigns, flows: out.flows, audiences: out.audiences, days: out.days };
  } catch (e) {
    const msg = redactSecret(errText(e), key);
    const refused = def.refused(e);
    await admin.from(def.table).update({ last_error: msg, updated_at: new Date().toISOString(), ...(refused ? { status: "invalid" } : {}) }).eq("client_id", clientId);
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: msg, account: conn.account_name });
    if (window === "full") await progress(0, "Couldn't finish", { done: true, error: msg.slice(0, 200) });
    return { client: clientId, ok: false, window, error: msg };
  }
}

/**
 * The cron step for one provider, on the same schedule as Klaviyo's: every connected live client, the ones read longest
 * ago first, a few at a time. A client isn't started without time left for its window; one read in the last 10 minutes
 * is left alone unless `force`. A client whose key was refused waits for a new key.
 */
export async function syncAllProvider(admin: SupabaseClient, def: ProviderDef, opts: { budgetMs?: number; force?: boolean; concurrency?: number } = {}) {
  if (!(await providerReady(admin, def))) return { skipped: `${providerName(def.id)} migration not applied` };
  const deadline = Date.now() + (opts.budgetMs ?? 600_000);
  const [{ data }, { data: memos }] = await Promise.all([
    admin.from(def.table).select("client_id, last_synced_at, clients!inner(name, status, archived_at)").eq("status", "active"),
    admin.from("sync_state").select("source, last_run_at, last_result").like("source", "klaviyo:%"),
  ]);
  type Row = { client_id: string; last_synced_at: string | null; clients: { name: string; status: string; archived_at: string | null } | null };
  const memo = new Map((memos ?? []).map((x) => [String(x.source).slice("klaviyo:".length), x as { last_run_at: string | null; last_result: SyncMemo | null }]));
  const recently = new Date(Date.now() - 10 * 60_000).toISOString();
  const plan = ((data ?? []) as unknown as Row[])
    .filter((r) => r.clients && !r.clients.archived_at && (LIVE as readonly string[]).includes(r.clients.status))
    .map((r) => {
      const m = memo.get(r.client_id);
      return { id: r.client_id, name: r.clients!.name, lastRun: m?.last_run_at ?? null, window: pickKlaviyoWindow({ lastFullAt: m ? (m.last_result?.fullAt ?? null) : r.last_synced_at }) };
    })
    .filter((p) => opts.force || !p.lastRun || p.lastRun < recently)
    .sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  const t = await tracker(admin, def.id, "accounts");
  t.total(plan.length);
  try {
    const r = await runBounded(plan, { limit: opts.concurrency ?? 4, deadline, cost: (p) => def.costMs(p.window) }, async (p) => {
      t.on(p.name);
      const out = await syncProvider(admin, def, p.id, { window: p.window });
      t.tick(p.name, out.ok);
      return out;
    });
    for (const f of r.failed) t.tick(f.item.name, false);
    const results = r.done.map((d) => d.result);
    const failed = [...results.filter((x) => !x.ok).map((x) => ({ client: x.client, error: x.error })), ...r.failed.map((f) => ({ client: f.item.id, error: f.error }))];
    const synced = results.filter((x) => x.ok).length;
    const full = results.filter((x) => x.ok && x.window === "full").length;
    await t.finish({ summary: `${synced} accounts read (${full} full)${failed.length ? `, ${failed.length} failed` : ""}${r.skipped.length ? `, ${r.skipped.length} left for the next run` : ""}` });
    return { due: plan.length, synced, full, failed, deferred: r.skipped.length };
  } catch (e) {
    await t.finish({ error: errText(e) });
    throw e;
  }
}

/** Plain words for a stored error of this provider (for the client card) */
export const plainProviderError = (def: ProviderDef, raw: string | null | undefined, status?: string | null) => plainEmailError(def.id, raw, status);
