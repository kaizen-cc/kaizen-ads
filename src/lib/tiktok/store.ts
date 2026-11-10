import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptionKey, last4, NO_KEY, redactTokens, seal, unseal } from "@/lib/meta-token-core";
import { matchClientName } from "@/lib/client-name-match";
import { LIVE } from "@/lib/live";
import { nyParts } from "@/lib/kpi/calc";
import { orderSeats, type SeatRow } from "@/lib/buyer-seats";
import { adDiagnosis, adGroups, advertiserInfo, advertisersOf, ads as listAds, exchangeCode, imageUrls, pixelEventStats, pixelList, report, TikTokError, videoCovers } from "./api";
import { diagnosticsText, parseDiagnosis, parsePixels, parsePixelStats, statusWarning, withCounts, type DiagnosisWarning, type PixelView, type TikTokDiagnostics } from "./diagnostics-core";
import { AD_ATTRS, CAMPAIGN_ATTRS, REPORT_METRICS, adDayRow, addUp, campaignDayRow, chunkRange, shiftDay, statusWord, summarize, summaryLine, tiktokConfigured, type TikTokSummary } from "./core";

// TikTok Ads in Kaizen Ads: the connection (an exec's OAuth grant, its token encrypted at rest), the advertisers it
// reaches and the client each belongs to, and the daily pulls (campaigns for the KPI board, ads for top ads and hook
// rates). Read only. Everything here returns early, touching nothing, while TikTok isn't set up (tiktokConfigured).

export const BACKFILL_DAYS = 90;
export const REVISE_DAYS = 7;
const DEFAULT_CONVERSION = "tiktok_conversions";

const today = () => nyParts(new Date()).date;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// ─── The connection ────────────────────────────────────────────────────────

type ConnRow = { id: string; advertiser_ids: string[] | null; token_iv: string | null; token_tag: string | null; token_ciphertext: string | null; token_last4: string | null; scopes: string[] | null; connected_by: string | null; connected_at: string; last_checked_at: string | null; status: string; last_error: string | null };

/** Whether the TikTok tables exist (the migration applied) */
export async function tiktokReady(admin: SupabaseClient) {
  if (!tiktokConfigured()) return false;
  const { error } = await admin.from("tiktok_connections").select("id").limit(1);
  return !error;
}

/** Any working connection: the KPI board shows TikTok only then (or once TikTok cards exist) */
export async function tiktokConnected(admin: SupabaseClient) {
  if (!tiktokConfigured()) return false;
  const { data, error } = await admin.from("tiktok_connections").select("id").eq("status", "active").limit(1);
  return !error && Boolean(data?.length);
}

function decrypt(r: Pick<ConnRow, "token_iv" | "token_tag" | "token_ciphertext">): string | null {
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key || !r.token_iv || !r.token_tag || !r.token_ciphertext) return null;
  try {
    return unseal({ iv: r.token_iv, tag: r.token_tag, ciphertext: r.token_ciphertext }, key);
  } catch {
    return null;
  }
}

/** The token that reads one advertiser: its own connection's, else the newest active connection that lists it */
export async function tokenFor(admin: SupabaseClient, advertiserId: string): Promise<{ token: string; connectionId: string } | null> {
  const { data: adv } = await admin.from("tiktok_advertisers").select("connection_id").eq("advertiser_id", advertiserId).maybeSingle();
  const { data: rows } = await admin.from("tiktok_connections").select("id, advertiser_ids, token_iv, token_tag, token_ciphertext, status").eq("status", "active").order("connected_at", { ascending: false });
  const list = (rows ?? []) as ConnRow[];
  const pick = list.find((c) => c.id === adv?.connection_id) ?? list.find((c) => (c.advertiser_ids ?? []).includes(advertiserId));
  if (!pick) return null;
  const token = decrypt(pick);
  return token ? { token, connectionId: pick.id } : null;
}

/** A connection TikTok refused: marked so an exec reconnects, never retried in a loop */
async function markInvalid(admin: SupabaseClient, connectionId: string, message: string) {
  await admin.from("tiktok_connections").update({ status: "invalid", last_error: message.slice(0, 500), last_checked_at: new Date().toISOString() }).eq("id", connectionId);
}

/**
 * Back from TikTok's consent screen: the code is exchanged for the token, which is encrypted and saved; the advertisers
 * it reaches are listed and kept, older grants covering the same advertisers are replaced, and an advertiser whose name
 * clearly names one client is linked to it.
 */
export async function connectTikTok(admin: SupabaseClient, authCode: string, by: string): Promise<{ advertisers: number; linked: string[] }> {
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error(NO_KEY.replace("a Business Manager's token", "TikTok's token"));
  const { token, advertiserIds, scopes } = await exchangeCode(authCode);
  try {
    const sealed = seal(token, key);
    const { data: conn, error } = await admin
      .from("tiktok_connections")
      .insert({ advertiser_ids: advertiserIds, token_iv: sealed.iv, token_tag: sealed.tag, token_ciphertext: sealed.ciphertext, token_last4: last4(token), scopes, connected_by: by, status: "active", last_checked_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error || !conn) throw new Error(`Saving the TikTok connection: ${error?.message ?? "no row"}`);
    const ids = await refreshAdvertisers(admin, conn.id as string, token, advertiserIds);
    // Older grants whose advertisers this one now covers aren't needed any more
    const { data: older } = await admin.from("tiktok_connections").select("id, advertiser_ids").eq("status", "active").neq("id", conn.id);
    for (const o of older ?? []) if (((o.advertiser_ids ?? []) as string[]).every((a) => ids.includes(a))) await admin.from("tiktok_connections").update({ status: "replaced", token_iv: null, token_tag: null, token_ciphertext: null }).eq("id", o.id);
    const linked = await autoLink(admin);
    return { advertisers: ids.length, linked };
  } catch (e) {
    throw new Error(redactTokens(errText(e), [token]));
  }
}

/** The advertisers a connection reaches, refreshed (names, currency, timezone, status). Returns their ids. */
async function refreshAdvertisers(admin: SupabaseClient, connectionId: string, token: string, fromGrant: string[] = []): Promise<string[]> {
  const listed = await advertisersOf(token).catch(() => [] as { id: string; name: string | null }[]);
  const ids = [...new Set([...fromGrant, ...listed.map((a) => a.id)])];
  if (!ids.length) return ids;
  const info = await advertiserInfo(token, ids).catch(() => [] as Awaited<ReturnType<typeof advertiserInfo>>);
  const now = new Date().toISOString();
  const rows = ids.map((id) => {
    const i = info.find((x) => x.id === id);
    const n = listed.find((x) => x.id === id)?.name ?? null;
    return { advertiser_id: id, connection_id: connectionId, name: i?.name ?? n, currency: i?.currency ?? null, timezone: i?.timezone ?? null, status: i?.status ?? null, updated_at: now };
  });
  const { error } = await admin.from("tiktok_advertisers").upsert(rows, { onConflict: "advertiser_id" });
  if (error) throw new Error(`Saving TikTok ad accounts: ${error.message}`);
  await admin.from("tiktok_connections").update({ advertiser_ids: ids, last_checked_at: now, last_error: null }).eq("id", connectionId);
  return ids;
}

/** An advertiser whose name clearly names one live client (and the client has no TikTok account yet) is linked to it */
async function autoLink(admin: SupabaseClient): Promise<string[]> {
  const [{ data: free }, { data: taken }, { data: clients }] = await Promise.all([
    admin.from("tiktok_advertisers").select("advertiser_id, name").is("client_id", null),
    admin.from("tiktok_advertisers").select("client_id").not("client_id", "is", null),
    admin.from("clients").select("id, name, website").is("archived_at", null).in("status", LIVE),
  ]);
  const has = new Set((taken ?? []).map((t) => t.client_id as string));
  const linked: string[] = [];
  for (const a of free ?? []) {
    if (!a.name) continue;
    const { sure } = matchClientName(String(a.name), ((clients ?? []) as { id: string; name: string; website: string | null }[]).filter((c) => !has.has(c.id)));
    if (!sure) continue;
    await linkAdvertiser(admin, String(a.advertiser_id), sure.id, null);
    has.add(sure.id);
    linked.push(`${sure.name} → ${a.name}`);
  }
  return linked;
}

/**
 * An advertiser linked to a client (or unlinked with null). Linking gives the client a TikTok KPI card (no target yet,
 * owned by its primary Meta buyer, who buys TikTok too) and starts the first 90-day pull on the next sync.
 */
export async function linkAdvertiser(admin: SupabaseClient, advertiserId: string, clientId: string | null, by: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await admin.from("tiktok_advertisers").update({ client_id: clientId, linked_at: clientId ? new Date().toISOString() : null }).eq("advertiser_id", advertiserId);
  if (error) return { ok: false, error: error.message };
  if (!clientId) return { ok: true };
  const { data: existing } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", clientId).eq("platform", "tiktok");
  if (existing?.some((t) => t.ad_account_id === advertiserId)) return { ok: true };
  const empty = existing?.find((t) => !t.ad_account_id);
  if (empty) {
    await admin.from("kpi_targets").update({ ad_account_id: advertiserId }).eq("id", empty.id);
    return { ok: true };
  }
  const owner = await tiktokOwner(admin, clientId);
  const { error: kErr } = await admin.from("kpi_targets").insert({ client_id: clientId, platform: "tiktok", ad_account_id: advertiserId, conversion: DEFAULT_CONVERSION, owner_id: owner, updated_by: by });
  return kErr ? { ok: false, error: kErr.message } : { ok: true };
}

/** Who owns a client's TikTok card: the primary TikTok buyer, else the primary Meta buyer (who buys TikTok until one is set) */
export async function tiktokOwner(admin: SupabaseClient, clientId: string): Promise<string | null> {
  const { data: seats } = await admin.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").eq("client_id", clientId).in("role", ["tiktok_buyer", "meta_buyer"]);
  const rows = (seats ?? []) as SeatRow[];
  return orderSeats(rows.filter((r) => r.role === "tiktok_buyer"))[0]?.profile_id ?? orderSeats(rows.filter((r) => r.role === "meta_buyer"))[0]?.profile_id ?? null;
}

/** Disconnect: the token is deleted (TikTok keeps the app's access until it's removed there too); the numbers stay */
export async function disconnectTikTok(admin: SupabaseClient, connectionId: string) {
  const { error } = await admin.from("tiktok_connections").update({ status: "revoked", token_iv: null, token_tag: null, token_ciphertext: null, last_checked_at: new Date().toISOString() }).eq("id", connectionId);
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

// ─── What Settings shows ───────────────────────────────────────────────────

export type TikTokAdvertiserView = { id: string; name: string | null; currency: string | null; timezone: string | null; status: string; clientId: string | null; client: string | null; lastSynced: string | null; error: string | null; suggestions: { id: string; name: string }[] };
export type TikTokConnectionView = { id: string; last4: string | null; status: string; connectedAt: string; by: string | null; advertisers: number; error: string | null; scopes: string[] };
export type TikTokView =
  | { state: "waiting"; missing: string[] }
  | { state: "not_ready"; error: string }
  | { state: "ready"; encryption: boolean; connections: TikTokConnectionView[]; advertisers: TikTokAdvertiserView[]; clients: { id: string; name: string }[] };

export async function tiktokView(admin: SupabaseClient): Promise<TikTokView> {
  const { tiktokMissing } = await import("./core");
  if (!tiktokConfigured()) return { state: "waiting", missing: tiktokMissing() };
  const [{ data: conns, error }, { data: advs }, { data: clients }] = await Promise.all([
    admin.from("tiktok_connections").select("id, advertiser_ids, token_last4, scopes, connected_by, connected_at, status, last_error").in("status", ["active", "invalid"]).order("connected_at", { ascending: false }),
    admin.from("tiktok_advertisers").select("advertiser_id, name, currency, timezone, status, client_id, last_synced_at, error").order("name"),
    admin.from("clients").select("id, name, website").is("archived_at", null).in("status", LIVE).order("name"),
  ]);
  if (error) return { state: "not_ready", error: "TikTok isn't set up in the database yet: the TikTok migration hasn't been applied." };
  const byIds = [...new Set((conns ?? []).map((c) => c.connected_by).filter(Boolean))] as string[];
  const { data: people } = byIds.length ? await admin.from("profiles").select("id, full_name").in("id", byIds) : { data: [] as { id: string; full_name: string }[] };
  const list = (clients ?? []) as { id: string; name: string; website: string | null }[];
  const nameOf = new Map(list.map((c) => [c.id, c.name]));
  const taken = new Set((advs ?? []).map((a) => a.client_id).filter(Boolean));
  return {
    state: "ready",
    encryption: Boolean(encryptionKey(process.env.TOKEN_ENCRYPTION_KEY)),
    connections: (conns ?? []).map((c) => ({
      id: c.id as string,
      last4: (c.token_last4 as string | null) ?? null,
      status: c.status as string,
      connectedAt: c.connected_at as string,
      by: (people ?? []).find((p) => p.id === c.connected_by)?.full_name ?? null,
      advertisers: ((c.advertiser_ids ?? []) as string[]).length,
      error: (c.last_error as string | null) ?? null,
      scopes: (c.scopes ?? []) as string[],
    })),
    advertisers: (advs ?? []).map((a) => ({
      id: a.advertiser_id as string,
      name: (a.name as string | null) ?? null,
      currency: (a.currency as string | null) ?? null,
      timezone: (a.timezone as string | null) ?? null,
      status: statusWord(a.status as string | null),
      clientId: (a.client_id as string | null) ?? null,
      client: a.client_id ? (nameOf.get(a.client_id as string) ?? "A client") : null,
      lastSynced: (a.last_synced_at as string | null) ?? null,
      error: (a.error as string | null) ?? null,
      // Unlinked: the clients its name might be, best first
      suggestions: a.client_id || !a.name ? [] : matchClientName(String(a.name), list.filter((c) => !taken.has(c.id))).maybe.slice(0, 3).map((c) => ({ id: c.id, name: c.name })),
    })),
    clients: list.map((c) => ({ id: c.id, name: c.name })),
  };
}

// ─── The pulls ─────────────────────────────────────────────────────────────

/** Where a pull starts: the whole 90 days the first time, then the last REVISE_DAYS again (TikTok revises them) */
async function since(admin: SupabaseClient, table: "tiktok_campaign_daily" | "tiktok_ad_daily", account: string) {
  const end = today();
  const { data: last } = await admin.from(table).select("date").eq("ad_account_id", account).order("date", { ascending: false }).limit(1).maybeSingle();
  const full = shiftDay(end, -(BACKFILL_DAYS - 1));
  const from = last?.date ? shiftDay(String(last.date), -REVISE_DAYS) : full;
  return { start: from < full ? full : from, end };
}

async function upsertAll(admin: SupabaseClient, table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`Saving ${table}: ${error.message}`);
  }
}

async function withToken<T>(admin: SupabaseClient, account: string, fn: (token: string) => Promise<T>): Promise<T> {
  const t = await tokenFor(admin, account);
  if (!t) throw new Error("No working TikTok connection reaches this ad account. Reconnect TikTok in Settings > Sync health > TikTok.");
  try {
    return await fn(t.token);
  } catch (e) {
    if (e instanceof TikTokError && e.auth) await markInvalid(admin, t.connectionId, e.message);
    throw new Error(redactTokens(errText(e), [t.token]));
  }
}

/** The KPI board's pull: campaigns per day for one advertiser (the same rows Meta's and Google's KPIs read) */
export async function syncTikTokCampaigns(admin: SupabaseClient, account: string) {
  if (!tiktokConfigured()) return { from: "", rows: 0 };
  const range = await since(admin, "tiktok_campaign_daily", account);
  return withToken(admin, account, async (token) => {
    const at = new Date().toISOString();
    let n = 0;
    for (const c of chunkRange(range.start, range.end, 30)) {
      const rows = await report(token, { advertiserId: account, dataLevel: "AUCTION_CAMPAIGN", dimensions: ["campaign_id", "stat_time_day"], metrics: [...REPORT_METRICS, ...CAMPAIGN_ATTRS], start: c.start, end: c.end });
      const records = rows.map((r) => campaignDayRow(account, r, at)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      await upsertAll(admin, "tiktok_campaign_daily", records, "ad_account_id,campaign_id,date");
      n += records.length;
    }
    await admin.from("tiktok_advertisers").update({ last_synced_at: at, error: null, ...(range.start <= shiftDay(range.end, -(BACKFILL_DAYS - 2)) ? { backfilled_at: at } : {}) }).eq("advertiser_id", account);
    return { from: range.start, rows: n };
  }).catch(async (e) => {
    await admin.from("tiktok_advertisers").update({ error: errText(e) }).eq("advertiser_id", account);
    throw e;
  });
}

/** Ads per day for one advertiser, and each ad's text, call to action, status and thumbnail */
export async function syncTikTokAds(admin: SupabaseClient, account: string) {
  const range = await since(admin, "tiktok_ad_daily", account);
  return withToken(admin, account, async (token) => {
    const at = new Date().toISOString();
    let n = 0;
    for (const c of chunkRange(range.start, range.end, 30)) {
      const rows = await report(token, { advertiserId: account, dataLevel: "AUCTION_AD", dimensions: ["ad_id", "stat_time_day"], metrics: [...REPORT_METRICS, ...AD_ATTRS], start: c.start, end: c.end });
      const records = rows.map((r) => adDayRow(account, r, at)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      await upsertAll(admin, "tiktok_ad_daily", records, "ad_account_id,ad_id,date");
      n += records.length;
    }
    const list = await listAds(token, account);
    const videos = [...new Set(list.map((a) => a.video_id).filter(Boolean) as string[])];
    const images = [...new Set(list.flatMap((a) => a.image_ids ?? []).filter(Boolean))];
    const [covers, pics] = await Promise.all([videoCovers(token, account, videos).catch(() => new Map<string, string>()), imageUrls(token, account, images).catch(() => new Map<string, string>())]);
    await upsertAll(
      admin,
      "tiktok_ads",
      list.map((a) => ({
        ad_id: a.ad_id,
        ad_account_id: account,
        campaign_id: a.campaign_id ? String(a.campaign_id) : null,
        adgroup_id: a.adgroup_id ? String(a.adgroup_id) : null,
        ad_name: a.ad_name ?? null,
        status: a.operation_status ?? null,
        secondary_status: a.secondary_status ?? null,
        ad_text: a.ad_text ?? null,
        call_to_action: a.call_to_action ?? null,
        landing_page_url: a.landing_page_url ?? null,
        video_id: a.video_id ?? null,
        image_ids: (a.image_ids ?? []).map(String),
        thumbnail_url: (a.video_id && covers.get(a.video_id)) || (a.image_ids ?? []).map((i) => pics.get(String(i))).find(Boolean) || null,
        created_at: a.create_time ? new Date(`${a.create_time.replace(" ", "T")}Z`).toISOString() : null,
        updated_at: at,
      })),
      "ad_id",
    );
    return { from: range.start, rows: n, ads: list.length };
  });
}

/**
 * The scheduled step (every 2 hours, like Meta's ads): each connection's advertisers refreshed, then every linked
 * advertiser's ads, one at a time with pauses. The campaigns themselves are pulled with the KPI step. Nothing at all
 * while TikTok isn't set up.
 */
export async function syncAllTikTok(admin: SupabaseClient, budgetMs = 600_000) {
  if (!tiktokConfigured()) return { dormant: true, reason: "TIKTOK_APP_ID and TIKTOK_APP_SECRET aren't set" };
  if (!(await tiktokReady(admin))) return { dormant: true, reason: "The TikTok migration hasn't been applied" };
  const deadline = Date.now() + budgetMs;
  const { data: conns } = await admin.from("tiktok_connections").select("id, token_iv, token_tag, token_ciphertext").eq("status", "active");
  const errors: string[] = [];
  for (const c of (conns ?? []) as ConnRow[]) {
    const token = decrypt(c);
    if (!token) {
      await markInvalid(admin, c.id, "The token can't be decrypted (TOKEN_ENCRYPTION_KEY changed?). Reconnect TikTok.");
      continue;
    }
    try {
      await refreshAdvertisers(admin, c.id, token);
    } catch (e) {
      if (e instanceof TikTokError && e.auth) await markInvalid(admin, c.id, e.message);
      errors.push(redactTokens(errText(e), [token]));
    }
  }
  const linked = await autoLink(admin).catch(() => [] as string[]);
  const adopted = await adoptTikTokTargets(admin).catch(() => 0);
  const { data: advs } = await admin.from("tiktok_advertisers").select("advertiser_id, client_id, clients!inner(status, archived_at)").not("client_id", "is", null).is("clients.archived_at", null).in("clients.status", LIVE);
  let synced = 0;
  let deferred = 0;
  for (const a of advs ?? []) {
    if (Date.now() > deadline) {
      deferred++;
      continue;
    }
    const account = String(a.advertiser_id);
    try {
      const r = await syncTikTokAds(admin, account);
      synced++;
      // The pixels and TikTok's diagnosis, once a day (this step runs every two hours); a failure never fails the sync
      if (await diagnosticsDue(admin, account)) await syncTikTokDiagnostics(admin, account).catch((e) => console.error(`[tiktok] diagnostics ${account}:`, errText(e)));
      await admin.from("sync_state").upsert({ source: `tiktok:${account}`, last_run_at: new Date().toISOString(), last_result: { ...r, error: null } });
    } catch (e) {
      errors.push(`${account}: ${errText(e)}`);
      await admin.from("sync_state").upsert({ source: `tiktok:${account}`, last_run_at: new Date().toISOString(), last_result: { error: errText(e) } });
    }
  }
  return { connections: conns?.length ?? 0, linked, adopted, synced, deferred, errors };
}

/** Linked advertisers whose client has no TikTok KPI card yet get one (no target: the buyer sets it) */
export async function adoptTikTokTargets(admin: SupabaseClient): Promise<number> {
  if (!tiktokConfigured()) return 0;
  const [{ data: advs }, { data: targets }] = await Promise.all([
    admin.from("tiktok_advertisers").select("advertiser_id, client_id").not("client_id", "is", null),
    admin.from("kpi_targets").select("client_id, ad_account_id").eq("platform", "tiktok"),
  ]);
  const has = new Set((targets ?? []).map((t) => `${t.client_id}:${t.ad_account_id ?? ""}`));
  const clientHas = new Set((targets ?? []).map((t) => t.client_id as string));
  let n = 0;
  for (const a of advs ?? []) {
    if (has.has(`${a.client_id}:${a.advertiser_id}`) || clientHas.has(a.client_id as string)) continue;
    const r = await linkAdvertiser(admin, String(a.advertiser_id), a.client_id as string, null);
    if (r.ok) {
      n++;
      clientHas.add(a.client_id as string);
    }
  }
  return n;
}

// ─── Tracking and delivery checks (daily) ──────────────────────────────────

const DIAGNOSTICS_EVERY_MS = 20 * 3_600_000;

/** Whether an advertiser's checks are due (none yet, or the last one is 20+ hours old); false before the migration */
async function diagnosticsDue(admin: SupabaseClient, account: string) {
  const { data, error } = await admin.from("tiktok_diagnostics").select("checked_at").eq("advertiser_id", account).maybeSingle();
  if (error) return false;
  return !data?.checked_at || Date.now() - Date.parse(String(data.checked_at)) > DIAGNOSTICS_EVERY_MS;
}

/**
 * One advertiser's tracking and delivery checks: its pixels and their events over the last 7 days, the ad groups
 * TikTok has learning-limited or held back, the rejected ads, and TikTok's own diagnosis of the active ad groups. Each
 * check stands alone: one TikTok refuses (its code and message are logged by the API layer and kept in errors) leaves
 * the others, so the tab and the audit still get what was read.
 */
export async function syncTikTokDiagnostics(admin: SupabaseClient, account: string): Promise<TikTokDiagnostics> {
  return withToken(admin, account, async (token) => {
    const errors: string[] = [];
    const note = (what: string) => (e: unknown) => {
      errors.push(`${what}: ${errText(e).slice(0, 160)}`);
      return null;
    };
    const end = shiftDay(today(), -1);
    const start = shiftDay(end, -6);
    const raw = await pixelList(token, account).catch(note("pixels"));
    let pixels: PixelView[] = raw ? parsePixels({ pixels: raw }) : [];
    if (pixels.length) {
      const stats = await pixelEventStats(
        token,
        account,
        pixels.map((p) => p.id),
        start,
        end,
      ).catch(note("pixel events"));
      if (stats) pixels = withCounts(pixels, parsePixelStats(stats));
    }
    const warnings: DiagnosisWarning[] = [];
    const groups = await adGroups(token, account).catch(note("ad groups"));
    for (const g of groups ?? []) {
      const w = statusWarning("adgroup", { id: g.adgroup_id, name: g.adgroup_name ?? null, secondary_status: g.secondary_status ?? null });
      if (w) warnings.push(w);
    }
    // Rejected ads, from what the ads sync just stored
    const { data: stored } = await admin.from("tiktok_ads").select("ad_id, ad_name, secondary_status").eq("ad_account_id", account).limit(2000);
    for (const a of stored ?? []) {
      const w = statusWarning("ad", { id: String(a.ad_id), name: (a.ad_name as string | null) ?? null, secondary_status: (a.secondary_status as string | null) ?? null });
      if (w?.kind === "rejected") warnings.push(w);
    }
    // TikTok's own diagnosis of the ad groups switched on (at most 100 of them, 20 a call)
    const active = (groups ?? []).filter((g) => /^(ENABLE|ACTIVE)$/i.test(String(g.operation_status ?? ""))).map((g) => g.adgroup_id).slice(0, 100);
    if (active.length) {
      const blocks = await adDiagnosis(token, account, active).catch(note("diagnosis"));
      const names = new Map((groups ?? []).map((g) => [g.adgroup_id, g.adgroup_name ?? null]));
      for (const b of blocks ?? []) for (const w of parseDiagnosis(b)) warnings.push({ ...w, name: w.name ?? (w.id ? (names.get(w.id) ?? null) : null) });
    }
    const out: TikTokDiagnostics = { pixels: pixels.slice(0, 10), warnings: warnings.slice(0, 60), checkedAt: new Date().toISOString(), errors };
    const { error } = await admin.from("tiktok_diagnostics").upsert({ advertiser_id: account, pixels: out.pixels, warnings: out.warnings, errors, checked_at: out.checkedAt, updated_at: out.checkedAt }, { onConflict: "advertiser_id" });
    if (error) throw new Error(`Saving TikTok diagnostics: ${error.message}`);
    return out;
  });
}

/** The stored checks of a client's advertisers, together (null before the first one, or before the migration) */
export async function clientDiagnostics(db: SupabaseClient, accounts: string[]): Promise<TikTokDiagnostics | null> {
  if (!accounts.length) return null;
  const { data, error } = await db.from("tiktok_diagnostics").select("pixels, warnings, errors, checked_at").in("advertiser_id", accounts);
  if (error || !data?.length) return null;
  return {
    pixels: data.flatMap((d) => (d.pixels ?? []) as PixelView[]),
    warnings: data.flatMap((d) => (d.warnings ?? []) as DiagnosisWarning[]),
    errors: data.flatMap((d) => (d.errors ?? []) as string[]),
    checkedAt:
      data
        .map((d) => d.checked_at as string | null)
        .filter((x): x is string => Boolean(x))
        .sort()
        .at(-1) ?? null,
  };
}

// ─── What a client's page and the AI read ──────────────────────────────────

export type TikTokTopAd = { id: string; name: string; campaign: string | null; status: string | null; text: string | null; cta: string | null; thumbnail: string | null; spend: number; conversions: number; cpa: number | null; ctr: number | null; hookRate: number | null; views6s: number };
export type TikTokCampaign = { id: string; name: string; spend: number; conversions: number; cpa: number | null; purchases: number; roas: number | null; ctr: number | null; hookRate: number | null };
export type ClientTikTok = { accounts: { id: string; name: string | null; currency: string | null }[]; now: TikTokSummary; before: TikTokSummary; campaigns: TikTokCampaign[]; topAds: TikTokTopAd[]; dataThrough: string | null; /** The pixels and TikTok's delivery warnings (checked daily), null before the first check */ diagnostics: TikTokDiagnostics | null };

/** A client's TikTok over the last 30 days against the 30 before: totals, campaigns and top ads with their thumbnails */
export async function clientTikTok(db: SupabaseClient, clientId: string): Promise<ClientTikTok | null> {
  if (!tiktokConfigured()) return null;
  const { data: advs, error } = await db.from("tiktok_advertisers").select("advertiser_id, name, currency").eq("client_id", clientId);
  if (error || !advs?.length) return null;
  const ids = advs.map((a) => String(a.advertiser_id));
  const end = shiftDay(today(), -1);
  const from30 = shiftDay(end, -29);
  const from60 = shiftDay(end, -59);
  const [{ data: days }, { data: adDays }] = await Promise.all([
    db.from("tiktok_campaign_daily").select("campaign_id, campaign_name, date, spend, impressions, clicks, conversions, purchases, conversion_value, video_plays, video_2s, video_6s").in("ad_account_id", ids).gte("date", from60).lte("date", end).limit(20000),
    db.from("tiktok_ad_daily").select("ad_id, ad_name, campaign_name, spend, impressions, clicks, conversions, purchases, conversion_value, video_plays, video_2s, video_6s").in("ad_account_id", ids).gte("date", from30).lte("date", end).limit(20000),
  ]);
  const rows = days ?? [];
  const now = rows.filter((r) => r.date >= from30);
  const byCampaign = new Map<string, typeof now>();
  for (const r of now) byCampaign.set(String(r.campaign_id), [...(byCampaign.get(String(r.campaign_id)) ?? []), r]);
  const campaigns: TikTokCampaign[] = [...byCampaign.entries()]
    .map(([id, list]) => {
      const s = summarize(addUp(list));
      return { id, name: list.find((x) => x.campaign_name)?.campaign_name ?? id, spend: s.spend, conversions: s.conversions, cpa: s.cpa, purchases: s.purchases, roas: s.roas, ctr: s.ctr, hookRate: s.hookRate };
    })
    .filter((c) => c.spend > 0 || c.conversions > 0)
    .sort((a, b) => b.spend - a.spend);
  const byAd = new Map<string, NonNullable<typeof adDays>>();
  for (const r of adDays ?? []) byAd.set(String(r.ad_id), [...(byAd.get(String(r.ad_id)) ?? []), r]);
  const ranked = [...byAd.entries()]
    .map(([id, list]) => ({ id, list, s: summarize(addUp(list)) }))
    .filter((x) => x.s.spend > 0)
    .sort((a, b) => b.s.conversions - a.s.conversions || (a.s.cpa ?? 1e9) - (b.s.cpa ?? 1e9) || b.s.spend - a.s.spend)
    .slice(0, 6);
  const { data: meta } = ranked.length ? await db.from("tiktok_ads").select("ad_id, ad_name, status, ad_text, call_to_action, thumbnail_url").in("ad_id", ranked.map((x) => x.id)) : { data: [] };
  const topAds: TikTokTopAd[] = ranked.map(({ id, list, s }) => {
    const m = (meta ?? []).find((x) => x.ad_id === id);
    return { id, name: m?.ad_name ?? list[0]?.ad_name ?? id, campaign: list[0]?.campaign_name ?? null, status: m?.status ?? null, text: m?.ad_text ?? null, cta: m?.call_to_action ?? null, thumbnail: m?.thumbnail_url ?? null, spend: s.spend, conversions: s.conversions, cpa: s.cpa, ctr: s.ctr, hookRate: s.hookRate, views6s: s.views6s };
  });
  return {
    accounts: advs.map((a) => ({ id: String(a.advertiser_id), name: (a.name as string | null) ?? null, currency: (a.currency as string | null) ?? null })),
    now: summarize(addUp(now)),
    before: summarize(addUp(rows.filter((r) => r.date < from30))),
    campaigns,
    topAds,
    dataThrough: rows.map((r) => r.date as string).sort().at(-1) ?? null,
    diagnostics: await clientDiagnostics(db, ids).catch(() => null),
  };
}

/** A client's TikTok numbers as lines for the AI (chat, Kaizen AI, the day recap): empty when there's nothing */
export async function tiktokBrief(db: SupabaseClient, clientId: string): Promise<string> {
  const t = await clientTikTok(db, clientId).catch(() => null);
  if (!t || (!t.now.spend && !t.before.spend)) return "";
  const cur = t.accounts[0]?.currency ?? "USD";
  return [
    `TikTok Ads (read only: changes in TikTok aren't connected yet), data through ${t.dataThrough ?? "?"}:`,
    `- ${summaryLine("Last 30 days", t.now, cur)}`,
    `- ${summaryLine("The 30 days before", t.before, cur)}`,
    ...t.campaigns.slice(0, 8).map((c) => `- Campaign ${c.name}: $${c.spend} spent, ${c.conversions} conversions${c.cpa != null ? ` at $${c.cpa}` : ""}${c.roas ? `, ROAS ${c.roas}x` : ""}, CTR ${c.ctr ?? "n/a"}%, hook rate ${c.hookRate ?? "n/a"}%`),
    ...t.topAds.slice(0, 3).map((a, i) => `- Top ad ${i + 1}: ${a.name}: ${a.conversions} conversions${a.cpa != null ? ` at $${a.cpa}` : ""}, hook rate ${a.hookRate ?? "n/a"}%${a.text ? `, text "${a.text.slice(0, 120)}"` : ""}`),
    ...(t.diagnostics ? [diagnosticsText(t.diagnostics)] : []),
  ]
    .filter(Boolean)
    .join("\n");
}
