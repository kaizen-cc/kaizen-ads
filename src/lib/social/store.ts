import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaConfigured } from "@/lib/context/meta";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { tracker } from "@/lib/progress";
import { runBounded } from "@/lib/bounded";
import { fbPosts, fbPostsInsights, fbProfile, fbSeries, igDayTotals, igMedia, igPostsInsights, igProfile, igSeries, pageAccessToken, pageInstagram, pageName, promotePages, SocialReadError, systemPages, type SocialCtx } from "./api";
import { cleanError, matchPage, pickSocialWindow, plainSocialError, shiftDay, socialClientState, socialCostMs, SOCIAL_BACKFILL_DAYS, withIgInsights, type PageRef, type Platform, type SocialClientState, type SocialPlainError, type SocialPost, type SocialWindow } from "./core";
import { combineFollowers, dailyTotal, platformFollowers, rateSeries, type DayPoint, type RatePoint } from "./charts";
import { bestAndWeakest, filterPosts, followerGrowth, formatStats, longestGap, postsPerWeek, socialHealth, withRates, windowOf, type DailyRow, type FollowerPoint, type HealthFinding, type PlatformPulse, type PostView, type Window } from "./insights";

// Social in Kaizen Ads: each organic social client's Facebook Page and Instagram account (found by name through the
// ad account's promotable Pages or the system user's Pages, or picked by a person), the daily sync of their account
// insights and recent posts, and what the client page and the agents read. Read only. Everything returns early,
// touching nothing, until the Social migration is applied.

const errText = (e: unknown) => cleanError(e instanceof Error ? e.message : String(e));
const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const num = (v: unknown) => (v == null ? null : Number(v));

type LinkRow = { client_id: string; page_id: string | null; page_name: string | null; ig_id: string | null; ig_username: string | null; source: "auto" | "manual"; status: "active" | "unlinked" | "failing"; last_synced_at: string | null; backfilled_at: string | null; last_error: string | null; missing_permissions: string[] | null; updated_at: string };

/** Whether the Social tables exist (the migration applied) */
export async function socialReady(admin: SupabaseClient) {
  const { error } = await admin.from("social_accounts").select("client_id").limit(1);
  return !error;
}

type Memo = { window?: SocialWindow; fullAt?: string | null; error?: string | null; igError?: string | null; fbError?: string | null; skipped?: string[]; permissions?: string[] };
const memoSource = (clientId: string) => `social:${clientId}`;
async function saveMemo(admin: SupabaseClient, clientId: string, memo: Memo) {
  await admin.from("sync_state").upsert({ source: memoSource(clientId), last_run_at: new Date().toISOString(), last_result: memo });
}

/** The ad account their ads run on, when they have one (their KPI's, else the one their setup guide found) */
async function adAccountOf(admin: SupabaseClient, clientId: string): Promise<string | null> {
  const [{ data: t }, { data: c }] = await Promise.all([
    admin.from("kpi_targets").select("ad_account_id").eq("client_id", clientId).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null).limit(1).maybeSingle(),
    admin.from("clients").select("meta_ad_account_id").eq("id", clientId).maybeSingle(),
  ]);
  const raw = t?.ad_account_id ?? c?.meta_ad_account_id ?? null;
  return raw ? String(raw).replace(/^act_/, "") : null;
}

// ─── The link ──────────────────────────────────────────────────────────────

const noPage = "No Facebook Page found for this client yet: pick their Page on the Social tab.";

/**
 * The client's Page and Instagram account: what's saved (a person's pick always stays), else found by name among the
 * Pages their ad account can promote, then among every Page the system user has. Nothing found is saved as unlinked,
 * so Sync health lists the client and the tab offers the picker.
 */
async function resolveLink(admin: SupabaseClient, clientId: string): Promise<{ link: LinkRow | null; error: string | null }> {
  const { data: had } = await admin.from("social_accounts").select("*").eq("client_id", clientId).maybeSingle();
  const row = (had as LinkRow | null) ?? null;
  if (row?.source === "manual" && (row.page_id || row.ig_id)) return { link: row, error: null };
  if (row?.page_id) {
    // Found before: an Instagram account added to the Page since is picked up
    if (!row.ig_id) {
      const ig = await pageInstagram(await adAccountOf(admin, clientId), row.page_id).catch(() => null);
      if (ig) {
        await admin.from("social_accounts").update({ ig_id: ig.id, ig_username: ig.username, updated_at: new Date().toISOString() }).eq("client_id", clientId);
        return { link: { ...row, ig_id: ig.id, ig_username: ig.username }, error: null };
      }
    }
    return { link: row, error: null };
  }
  const { data: c } = await admin.from("clients").select("name").eq("id", clientId).maybeSingle();
  const name = (c?.name as string | null) ?? "";
  const account = await adAccountOf(admin, clientId);
  let error: string | null = null;
  let page: PageRef | null = null;
  if (account) {
    const pages = await promotePages(account).catch(() => []);
    page = matchPage(pages, name, { onlyOneFallback: true });
  }
  if (!page) {
    try {
      page = matchPage(await systemPages(), name);
    } catch (e) {
      error = e instanceof SocialReadError && e.permission ? e.message : null;
      if (e instanceof SocialReadError && e.permission) {
        await admin.from("social_accounts").upsert({ client_id: clientId, status: "unlinked", last_error: errText(e), missing_permissions: [e.permission], updated_at: new Date().toISOString() });
        return { link: null, error };
      }
    }
  }
  const now = new Date().toISOString();
  if (!page) {
    await admin.from("social_accounts").upsert({ client_id: clientId, source: "auto", status: "unlinked", last_error: noPage, missing_permissions: [], updated_at: now });
    return { link: null, error: noPage };
  }
  const patch = { client_id: clientId, page_id: page.id, page_name: page.name, ig_id: page.ig?.id ?? null, ig_username: page.ig?.username ?? null, source: "auto" as const, status: "active" as const, last_error: null, missing_permissions: [], updated_at: now };
  await admin.from("social_accounts").upsert(patch);
  return { link: { ...(row ?? ({} as LinkRow)), ...patch, last_synced_at: row?.last_synced_at ?? null, backfilled_at: row?.backfilled_at ?? null }, error: null };
}

/** The Pages a person can pick from for this client: the ad account's promotable Pages and every Page the system user has, each with its Instagram account */
export async function socialCandidates(admin: SupabaseClient, clientId: string): Promise<{ pages: PageRef[]; error: string | null }> {
  if (!metaConfigured()) return { pages: [], error: "Meta isn't connected: add META_SYSTEM_USER_TOKEN in Vercel." };
  const account = await adAccountOf(admin, clientId);
  const seen = new Map<string, PageRef>();
  let error: string | null = null;
  for (const list of [account ? await promotePages(account).catch(() => []) : [], await systemPages().catch((e) => {
    error = e instanceof SocialReadError && e.permission ? (plainSocialError(null, [e.permission])?.message ?? null) : "Meta didn't list any Pages.";
    return [] as PageRef[];
  })])
    for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  return { pages: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), error: seen.size ? null : error };
}

/**
 * A person's pick of the Page (and Instagram account) for a client: checked against Meta (the system user must reach
 * the Page), saved as a manual link that name matching never replaces, and the first read starts over for a Page that
 * changed (the old Page's numbers aren't mixed into the new one's).
 */
export async function setSocialLink(admin: SupabaseClient, clientId: string, input: { pageId: string; igId: string | null; by: string }): Promise<{ ok: true; pageName: string | null } | { ok: false; error: string }> {
  if (!(await socialReady(admin))) return { ok: false, error: "Social isn't set up in the database yet: its migration hasn't been applied." };
  if (!metaConfigured()) return { ok: false, error: "Meta isn't connected: add META_SYSTEM_USER_TOKEN in Vercel." };
  const pageId = input.pageId.trim().replace(/\D/g, "");
  if (!pageId) return { ok: false, error: "Pick a Page, or paste its numeric ID." };
  const account = await adAccountOf(admin, clientId);
  let name: string | null;
  let found: { id: string; username: string | null } | null;
  try {
    [name, found] = await Promise.all([pageName(account, pageId), pageInstagram(account, pageId)]);
  } catch (e) {
    return { ok: false, error: `Meta can't open that Page with the system user: ${errText(e).slice(0, 160)}` };
  }
  const igId = input.igId ? input.igId.trim().replace(/\D/g, "") : (found?.id ?? null);
  const { data: had } = await admin.from("social_accounts").select("page_id, ig_id").eq("client_id", clientId).maybeSingle();
  const pageChanged = Boolean(had?.page_id) && had?.page_id !== pageId;
  const igChanged = Boolean(had?.ig_id) && had?.ig_id !== igId;
  const { error } = await admin.from("social_accounts").upsert({
    client_id: clientId,
    page_id: pageId,
    page_name: name,
    ig_id: igId,
    ig_username: igId && found?.id === igId ? found.username : null,
    source: "manual",
    status: "active",
    last_error: null,
    missing_permissions: [],
    linked_by: input.by,
    updated_at: new Date().toISOString(),
    ...(pageChanged || igChanged ? { backfilled_at: null, last_synced_at: null } : {}),
  });
  if (error) return { ok: false, error: `Saving the link: ${error.message}` };
  // A replaced account's numbers stay (client data is never deleted): each row carries its account, and the tab reads
  // only the linked one's; the new account backfills on its next read
  if (pageChanged || igChanged) await admin.from("sync_state").delete().eq("source", memoSource(clientId));
  return { ok: true, pageName: name };
}

export type SocialLinkView = { pageId: string | null; pageName: string | null; igId: string | null; igUsername: string | null; source: "auto" | "manual"; status: string; state: SocialClientState; error: SocialPlainError | null; missing: string[]; lastSyncedAt: string | null; backfilled: boolean };

/** The client's link as the tab shows it; undefined when Social isn't set up in the database yet */
export async function socialLink(admin: SupabaseClient, clientId: string): Promise<SocialLinkView | null | undefined> {
  const { data, error } = await admin.from("social_accounts").select("*").eq("client_id", clientId).maybeSingle();
  if (error) return undefined;
  const { data: m } = await admin.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle();
  return viewOf((data as LinkRow | null) ?? null, (m?.last_result as Memo | null) ?? null);
}

function viewOf(r: LinkRow | null, memo: Memo | null): SocialLinkView | null {
  if (!r) return null;
  const missing = r.missing_permissions ?? [];
  const s = socialClientState({ pageId: r.page_id, igId: r.ig_id, lastSyncedAt: r.last_synced_at, error: r.last_error, missing }, Date.now());
  void memo;
  return { pageId: r.page_id, pageName: r.page_name, igId: r.ig_id, igUsername: r.ig_username, source: r.source, status: r.status, state: s.state, error: s.error, missing, lastSyncedAt: r.last_synced_at, backfilled: Boolean(r.backfilled_at) };
}

// ─── Sync health's roster ──────────────────────────────────────────────────

export type SocialRosterRow = { id: string; name: string; slug: string; page: string | null; instagram: string | null; source: "auto" | "manual" | null; state: SocialClientState; error: SocialPlainError | null; lastSyncedAt: string | null; window: SocialWindow | null; fullAt: string | null };

/**
 * Every live client on social media (or already linked) with where its social stands: linked (Page, Instagram, last
 * read, which window), failing (the error or the missing permission in plain words, with the fix), or missing (no Page
 * or Instagram account linked). For Settings > Sync health. null before the Social migration is applied.
 */
export async function socialRoster(admin: SupabaseClient): Promise<SocialRosterRow[] | null> {
  const [{ data: links, error }, { data: clients }, { data: memos }] = await Promise.all([
    admin.from("social_accounts").select("*"),
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", LIVE).order("name"),
    admin.from("sync_state").select("source, last_result").like("source", "social:%"),
  ]);
  if (error) return null;
  const by = new Map((links ?? []).map((l) => [l.client_id as string, l as LinkRow]));
  const list = (clients ?? []).filter((c) => (by.get(c.id as string)?.page_id ?? by.get(c.id as string)?.ig_id) || (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes("social-media"));
  const memo = new Map((memos ?? []).map((m) => [String(m.source).slice("social:".length), (m.last_result ?? {}) as Memo]));
  return list.map((c) => {
    const l = by.get(c.id as string) ?? null;
    const m = memo.get(c.id as string);
    const st = socialClientState(l ? { pageId: l.page_id, igId: l.ig_id, lastSyncedAt: l.last_synced_at, error: l.last_error, missing: l.missing_permissions ?? [] } : null);
    return { id: c.id as string, name: c.name as string, slug: c.slug as string, page: l?.page_name ?? null, instagram: l?.ig_username ?? null, source: l?.source ?? null, state: st.state, error: st.error, lastSyncedAt: l?.last_synced_at ?? null, window: m?.window ?? null, fullAt: m?.fullAt ?? null };
  });
}

// ─── The sync ──────────────────────────────────────────────────────────────

export type SyncResult = { client: string; ok: boolean; window?: SocialWindow; days?: number; posts?: number; error?: string };

type DayFields = Partial<Record<"followers" | "follows_gained" | "follows_lost" | "reach" | "views" | "profile_views" | "accounts_engaged" | "interactions", number>>;

/** Rows grouped by which columns they carry, so a column a read didn't get is left as it was instead of being set to null */
async function saveGrouped(admin: SupabaseClient, table: string, rows: Record<string, unknown>[], conflict: string) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const sig = Object.keys(r).sort().join(",");
    groups.set(sig, [...(groups.get(sig) ?? []), r]);
  }
  for (const part of groups.values()) {
    for (let i = 0; i < part.length; i += 500) {
      const { error } = await admin.from(table).upsert(part.slice(i, i + 500), { onConflict: conflict });
      if (error) throw new Error(`Saving ${table}: ${error.message}`);
    }
  }
}

const dayRows = (clientId: string, platform: Platform, account: string, by: Map<string, DayFields>, now: string) => [...by.entries()].filter(([, f]) => Object.keys(f).length).map(([date, f]) => ({ client_id: clientId, platform, account_id: account, date, ...f, updated_at: now }));

const postRow = (clientId: string, account: string, p: SocialPost, now: string) => ({ client_id: clientId, platform: p.platform, account_id: account, post_id: p.id, format: p.format, caption: p.caption, permalink: p.permalink, thumbnail_url: p.thumbnail, posted_at: p.postedAt, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, reach: p.reach, views: p.views, interactions: p.interactions, insights_ok: p.insightsOk, updated_at: now });

const setDay = (by: Map<string, DayFields>, date: string, f: DayFields) => by.set(date, { ...(by.get(date) ?? {}), ...f });
const fillDays = (by: Map<string, DayFields>, key: keyof DayFields, days: Map<string, number>) => {
  for (const [d, v] of days) setDay(by, d, { [key]: Math.round(v) });
};

type PlatformOut = { error: string | null; permission: string | null; skipped: string[]; days: number; posts: number };

/** Instagram: the account's count, reach and follows per day, the four totals one day at a time, and the recent posts with their insights */
async function readInstagram(admin: SupabaseClient, clientId: string, ig: string, ctx: SocialCtx, window: SocialWindow, today: string, now: string): Promise<PlatformOut> {
  const out: PlatformOut = { error: null, permission: null, skipped: [], days: 0, posts: 0 };
  try {
    const from = window === "full" ? shiftDay(today, -(SOCIAL_BACKFILL_DAYS - 1)) : shiftDay(today, -3);
    const profile = await igProfile(ctx, ig);
    const by = new Map<string, DayFields>();
    if (profile.followers != null) setDay(by, today, { followers: profile.followers });
    const s = await igSeries(ctx, ig, from, today, today);
    out.skipped.push(...s.skipped);
    fillDays(by, "reach", s.reach);
    fillDays(by, "follows_gained", s.gained);
    const dates: string[] = [];
    for (let d = from; d <= today; d = shiftDay(d, 1)) dates.push(d);
    const skipped = new Set<string>();
    const errs: unknown[] = [];
    await runBounded(dates, { limit: 4 }, async (d) => {
      try {
        const r = await igDayTotals(ctx, ig, d);
        r.skipped.forEach((x) => skipped.add(x));
        const t = r.totals;
        const f: DayFields = {};
        if (t.has("views")) f.views = t.get("views")!;
        if (t.has("profile_views")) f.profile_views = t.get("profile_views")!;
        if (t.has("accounts_engaged")) f.accounts_engaged = t.get("accounts_engaged")!;
        if (t.has("total_interactions")) f.interactions = t.get("total_interactions")!;
        if (Object.keys(f).length) setDay(by, d, f);
      } catch (e) {
        errs.push(e);
      }
    });
    // Every day failing is a real error (a missing permission); a few failing is a quiet gap
    if (errs.length && !by.size) throw errs[0];
    const named = errs.find((e): e is SocialReadError => e instanceof SocialReadError && Boolean(e.permission));
    if (named) out.permission = named.permission;
    out.skipped.push(...skipped);
    const rows = dayRows(clientId, "instagram", ig, by, now);
    await saveGrouped(admin, "social_daily", rows, "client_id,platform,account_id,date");
    out.days = rows.length;
    // Recent posts. The full read gets every one's insights; a recent read refreshes the last two weeks'
    const media = await igMedia(ctx, ig, 50);
    const cutoff = shiftDay(today, -14);
    const fresh = window === "full" ? media : media.filter((p) => (p.postedAt ?? "").slice(0, 10) >= cutoff);
    const ins = await igPostsInsights(ctx, fresh.map((p) => p.id));
    if (ins.permission) out.permission = out.permission ?? ins.permission;
    const posts = fresh.map((p) => withIgInsights(p, ins.by.get(p.id) ?? null));
    await saveGrouped(admin, "social_posts", posts.map((p) => postRow(clientId, ig, p, now)), "client_id,platform,post_id");
    out.posts = posts.length;
  } catch (e) {
    out.error = errText(e);
    if (e instanceof SocialReadError && e.permission) out.permission = e.permission;
  }
  return out;
}

/** Facebook: the Page's count and daily numbers (each from the current metric, else its older name), and its recent posts */
async function readFacebook(admin: SupabaseClient, clientId: string, page: string, ctx: SocialCtx, window: SocialWindow, today: string, now: string): Promise<PlatformOut> {
  const out: PlatformOut = { error: null, permission: null, skipped: [], days: 0, posts: 0 };
  try {
    const from = window === "full" ? shiftDay(today, -(SOCIAL_BACKFILL_DAYS - 1)) : shiftDay(today, -3);
    const profile = await fbProfile(ctx, page);
    const by = new Map<string, DayFields>();
    if (profile.followers != null) setDay(by, today, { followers: profile.followers });
    const fields: [Parameters<typeof fbSeries>[2], keyof DayFields][] = [["reach", "reach"], ["views", "views"], ["engagement", "interactions"], ["gained", "follows_gained"], ["lost", "follows_lost"], ["followers", "followers"], ["profileViews", "profile_views"]];
    const results = await Promise.all(fields.map(([f]) => fbSeries(ctx, page, f, from, today).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }))));
    let permission: SocialReadError | null = null;
    results.forEach((res, i) => {
      if (!res.ok) {
        if (res.e instanceof SocialReadError && res.e.permission) permission = res.e;
        else out.skipped.push(fields[i][0]);
        return;
      }
      if (!res.r.used) out.skipped.push(fields[i][0]);
      else fillDays(by, fields[i][1], res.r.days);
    });
    // Nothing at all read with a named permission missing: that's the error, not a quiet gap
    if (permission && ![...by.values()].some((f) => Object.keys(f).some((k) => k !== "followers"))) throw permission;
    if (permission) out.permission = (permission as SocialReadError).permission;
    // Today's count from the Page itself wins over the day's insights value
    if (profile.followers != null) setDay(by, today, { followers: profile.followers });
    const rows = dayRows(clientId, "facebook", page, by, now);
    await saveGrouped(admin, "social_daily", rows, "client_id,platform,account_id,date");
    out.days = rows.length;
    const all = await fbPosts(ctx, page, 40);
    const cutoff = shiftDay(today, -14);
    const fresh = window === "full" ? all : all.filter((p) => (p.postedAt ?? "").slice(0, 10) >= cutoff);
    const ins = await fbPostsInsights(ctx, fresh.slice(0, 30).map((p) => p.id)).catch(() => new Map<string, { reach: number | null; views: number | null }>());
    const posts = fresh.map((p) => {
      const i = ins.get(p.id);
      return i ? { ...p, reach: i.reach, views: i.views, insightsOk: i.reach != null || i.views != null } : p;
    });
    await saveGrouped(admin, "social_posts", posts.map((p) => postRow(clientId, page, p, now)), "client_id,platform,post_id");
    out.posts = posts.length;
  } catch (e) {
    out.error = errText(e);
    if (e instanceof SocialReadError && e.permission) out.permission = e.permission;
  }
  return out;
}

/**
 * One client's social, read: the full read (90 days of days, every recent post's insights) the first time and about
 * once a day, the recent read otherwise (the last few days and the last two weeks of posts). Each read is noted for
 * Sync health; a missing Meta permission is stored by name so the tab and Sync health say exactly what to add.
 */
export async function syncSocial(admin: SupabaseClient, clientId: string, opts: { window?: SocialWindow | "auto" } = {}): Promise<SyncResult> {
  if (!(await socialReady(admin))) return { client: clientId, ok: false, error: "Social isn't set up in the database yet." };
  if (!metaConfigured()) return { client: clientId, ok: false, error: "Meta isn't connected (META_SYSTEM_USER_TOKEN)." };
  const { data: m } = await admin.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle();
  const memo = (m?.last_result as Memo | null) ?? null;
  const lastFullAt = memo?.fullAt ?? null;
  const { link, error: linkError } = await resolveLink(admin, clientId);
  const window: SocialWindow = opts.window && opts.window !== "auto" ? opts.window : pickSocialWindow({ lastFullAt });
  if (!link || (!link.page_id && !link.ig_id)) {
    await saveMemo(admin, clientId, { window, fullAt: lastFullAt, error: linkError ?? noPage });
    return { client: clientId, ok: false, window, error: linkError ?? noPage };
  }
  const account = await adAccountOf(admin, clientId);
  const today = etToday();
  const now = new Date().toISOString();
  let pageToken: string | null = null;
  let tokenError: string | null = null;
  if (link.page_id) {
    try {
      pageToken = await pageAccessToken(account, link.page_id);
      if (!pageToken) tokenError = "The Meta system user has no access to this Page: assign the Page to the system user in Business Settings.";
    } catch (e) {
      tokenError = e instanceof SocialReadError && e.permission ? errText(e) : `The Meta system user has no access to this Page (${errText(e).slice(0, 160)}).`;
    }
  }
  const ctx: SocialCtx = { account, pageToken };
  const [ig, fb] = await Promise.all([link.ig_id ? readInstagram(admin, clientId, link.ig_id, ctx, window, today, now) : null, link.page_id && !tokenError ? readFacebook(admin, clientId, link.page_id, ctx, window, today, now) : null]);
  const perms = [...new Set([ig?.permission, fb?.permission, tokenError && /pages_show_list/.test(tokenError) ? "pages_show_list" : null].filter((x): x is string => Boolean(x)))];
  const igError = ig?.error ? `Instagram: ${ig.error}` : null;
  const fbError = tokenError ? tokenError : fb?.error ? `Facebook: ${fb.error}` : null;
  // Some part of the read worked: the link is read; every part failing is the link failing
  const anyOk = Boolean((ig && !ig.error) || (fb && !fb.error));
  const errors = [igError, fbError].filter(Boolean) as string[];
  const skipped = [...(ig?.skipped ?? []).map((x) => `instagram ${x}`), ...(fb?.skipped ?? []).map((x) => `facebook ${x}`)];
  await admin
    .from("social_accounts")
    .update({
      updated_at: now,
      status: errors.length && !anyOk ? "failing" : "active",
      last_error: errors.length ? errors.join(" · ").slice(0, 600) : null,
      missing_permissions: perms,
      ...(anyOk ? { last_synced_at: now } : {}),
      ...(anyOk && window === "full" && !link.backfilled_at ? { backfilled_at: now } : {}),
    })
    .eq("client_id", clientId);
  await saveMemo(admin, clientId, { window, fullAt: window === "full" && anyOk ? now : lastFullAt, error: errors.length ? errors.join(" · ").slice(0, 600) : null, igError, fbError, skipped, permissions: perms });
  return { client: clientId, ok: anyOk && !errors.length, window, days: (ig?.days ?? 0) + (fb?.days ?? 0), posts: (ig?.posts ?? 0) + (fb?.posts ?? 0), ...(errors.length ? { error: errors.join(" · ") } : {}) };
}

/**
 * The cron step: every live social client, the ones read longest ago first, three at a time (Meta's limits are per
 * token, shared by every client). A client isn't started without time left for its window; one read in the last 10
 * minutes (Sync now) is left alone unless `force`; a client still without a Page is looked for again every 6 hours.
 */
export async function syncAllSocial(admin: SupabaseClient, opts: { budgetMs?: number; force?: boolean; concurrency?: number } = {}) {
  if (!(await socialReady(admin))) return { skipped: "Social migration not applied" };
  if (!metaConfigured()) return { skipped: "Meta isn't connected" };
  const deadline = Date.now() + (opts.budgetMs ?? 600_000);
  const roster = await socialRoster(admin);
  const [{ data: memos }] = await Promise.all([admin.from("sync_state").select("source, last_run_at, last_result").like("source", "social:%")]);
  const memo = new Map((memos ?? []).map((x) => [String(x.source).slice("social:".length), x as { last_run_at: string | null; last_result: Memo | null }]));
  const recently = new Date(Date.now() - 10 * 60_000).toISOString();
  const looked = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const plan = (roster ?? [])
    .map((r) => {
      const m = memo.get(r.id);
      return { id: r.id, name: r.name, lastRun: m?.last_run_at ?? null, missing: r.state === "missing", window: pickSocialWindow({ lastFullAt: m?.last_result?.fullAt ?? null }) };
    })
    .filter((p) => opts.force || !p.lastRun || p.lastRun < (p.missing ? looked : recently))
    .sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  const t = await tracker(admin, "social", "accounts");
  t.total(plan.length);
  try {
    const r = await runBounded(plan, { limit: opts.concurrency ?? 3, deadline, cost: (p) => socialCostMs(p.window) }, async (p) => {
      t.on(p.name);
      const out = await syncSocial(admin, p.id, { window: p.window });
      t.tick(p.name, out.ok);
      return out;
    });
    for (const f of r.failed) t.tick(f.item.name, false);
    const results = r.done.map((d) => d.result);
    const failed = [...results.filter((x) => !x.ok).map((x) => ({ client: x.client, error: x.error })), ...r.failed.map((f) => ({ client: f.item.id, error: f.error }))];
    const synced = results.filter((x) => x.ok).length;
    const full = results.filter((x) => x.ok && x.window === "full").length;
    await t.finish({ summary: `${synced} accounts read (${full} full)${failed.length ? `, ${failed.length} failed or unlinked` : ""}${r.skipped.length ? `, ${r.skipped.length} left for the next run` : ""}` });
    return { due: plan.length, synced, full, failed, deferred: r.skipped.length };
  } catch (e) {
    await t.finish({ error: errText(e) });
    throw e;
  }
}

// ─── What the page and the agents read ─────────────────────────────────────

export type SocialPlatformView = PlatformPulse & { series: FollowerPoint[] };
export type ClientSocial = {
  today: string;
  /** The last day with any account number */
  through: string | null;
  platforms: SocialPlatformView[];
  /** Followers of every linked platform added up, per day (empty until a count is known) */
  followers: FollowerPoint[];
  followersNow: number | null;
  followersChange: number | null;
  followersPrevChange: number | null;
  reach: DayPoint[];
  interactions: DayPoint[];
  rate: RatePoint[];
  now: Window;
  before: Window;
  postsPerWeek: number;
  posts: PostView[];
  health: HealthFinding[];
  /** Part of the last read that failed or isn't given by Meta any more, in plain words */
  warning: string | null;
};

const PLATFORMS: Platform[] = ["instagram", "facebook"];

/** Both platforms' windows added up (a platform that reads nothing for a field leaves it out) */
function combineWindows(ws: Window[]): Window {
  const add = (k: keyof Window) => {
    const xs = ws.map((w) => w[k]).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };
  const reach = add("reach");
  const interactions = add("interactions");
  return { reach, views: add("views"), interactions, profileViews: add("profileViews"), engaged: add("engaged"), gained: add("gained"), lost: add("lost"), rate: reach && interactions != null ? interactions / reach : null };
}

/**
 * A client's social pulse: each platform's followers (with 30 days of growth against the 30 before), reach,
 * engagement and posting rhythm, 90 days of followers, reach and engagement, the recent posts with their rates, and
 * the account's health. Reads through `db`. null when nothing was synced.
 */
export async function clientSocial(db: SupabaseClient, clientId: string): Promise<ClientSocial | null> {
  const today = etToday();
  const from90 = shiftDay(today, -(SOCIAL_BACKFILL_DAYS - 1));
  const [{ data: allDays, error }, { data: allPosts }, { data: link }, { data: memo }] = await Promise.all([
    db.from("social_daily").select("*").eq("client_id", clientId).gte("date", shiftDay(today, -(SOCIAL_BACKFILL_DAYS + 30))).order("date"),
    db.from("social_posts").select("*").eq("client_id", clientId).order("posted_at", { ascending: false, nullsFirst: false }).limit(240),
    db.from("social_accounts").select("page_name, ig_username, page_id, ig_id").eq("client_id", clientId).maybeSingle(),
    db.from("sync_state").select("last_result").eq("source", memoSource(clientId)).maybeSingle(),
  ]);
  // Only the linked accounts' rows (a Page or Instagram account picked before keeps its history, unread)
  const current = (r: { platform: string; account_id?: string | null }) => r.account_id === (r.platform === "facebook" ? link?.page_id : link?.ig_id);
  const days = (allDays ?? []).filter(current);
  const posts = (allPosts ?? []).filter(current).slice(0, 120);
  if (error || (!days?.length && !posts?.length)) return null;
  const rows: DailyRow[] = (days ?? []).map((d) => ({ platform: d.platform as Platform, date: d.date as string, followers: num(d.followers), gained: num(d.follows_gained), lost: num(d.follows_lost), reach: num(d.reach), views: num(d.views), profileViews: num(d.profile_views), engaged: num(d.accounts_engaged), interactions: num(d.interactions) }));
  const socialPosts: SocialPost[] = (posts ?? []).map((p) => ({ id: p.post_id as string, platform: p.platform as Platform, format: ((p.format as string | null) ?? "image") as SocialPost["format"], caption: (p.caption as string | null) ?? null, permalink: (p.permalink as string | null) ?? null, thumbnail: (p.thumbnail_url as string | null) ?? null, postedAt: (p.posted_at as string | null) ?? null, likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), saves: num(p.saves), reach: num(p.reach), views: num(p.views), interactions: num(p.interactions), insightsOk: Boolean(p.insights_ok) }));
  const from30 = shiftDay(today, -29);
  const from60 = shiftDay(today, -59);
  const linked: Platform[] = PLATFORMS.filter((p) => (p === "instagram" ? Boolean(link?.ig_id) : Boolean(link?.page_id)) || rows.some((r) => r.platform === p) || socialPosts.some((x) => x.platform === p));
  const latestFollowers = (p: Platform) => [...rows].reverse().find((r) => r.platform === p && r.followers != null)?.followers ?? null;
  const counts: Partial<Record<Platform, number | null>> = { instagram: latestFollowers("instagram"), facebook: latestFollowers("facebook") };
  const rated = withRates(socialPosts, counts);
  const platforms: SocialPlatformView[] = linked.map((p) => {
    const mine = rows.filter((r) => r.platform === p);
    const series = platformFollowers(rows, p, today, counts[p] ?? null);
    const growth = followerGrowth(series, today);
    const ps = rated.filter((x) => x.platform === p);
    const last30 = filterPosts(ps, { platform: p, days: 30 }, today);
    return {
      platform: p,
      name: p === "instagram" ? ((link?.ig_username as string | null) ?? null) : ((link?.page_name as string | null) ?? null),
      followers: counts[p] ?? null,
      growth,
      now: windowOf(mine, from30, today),
      before: windowOf(mine, from60, shiftDay(from30, -1)),
      posts30: last30.length,
      postsPerWeek: postsPerWeek(ps, from30, today),
      lastPostAt: ps.map((x) => x.postedAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
      longestGap: longestGap(ps, from30, today),
      formats: formatStats(last30),
      insightsRead: mine.some((r) => r.reach != null),
      series,
    };
  });
  const combined = combineFollowers(platforms.map((p) => p.series));
  const growth = followerGrowth(combined, today);
  const m = (memo?.last_result as Memo | null) ?? null;
  const warnParts = [m?.skipped?.length ? `Meta doesn't give ${[...new Set(m.skipped)].join(", ")} for this account` : null, m?.igError, m?.fbError].filter(Boolean);
  return {
    today,
    through: rows.filter((r) => r.reach != null || r.followers != null).map((r) => r.date).sort().at(-1) ?? null,
    platforms,
    followers: combined,
    followersNow: platforms.every((p) => p.followers != null) && platforms.length ? platforms.reduce((s, p) => s + (p.followers ?? 0), 0) : (growth?.now ?? null),
    followersChange: growth?.change ?? null,
    followersPrevChange: growth?.prevChange ?? null,
    reach: dailyTotal(rows, "reach", from90, today),
    interactions: dailyTotal(rows, "interactions", from90, today),
    rate: rateSeries(rows, from90, today),
    now: combineWindows(platforms.map((p) => p.now)),
    before: combineWindows(platforms.map((p) => p.before)),
    postsPerWeek: platforms.length ? Math.max(...platforms.map((p) => p.postsPerWeek)) : 0,
    posts: rated,
    health: socialHealth({ today, platforms }),
    warning: warnParts.length ? warnParts.join(" · ").slice(0, 400) : null,
  };
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString("en-US"));
const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The social context every agent reads (empty when the client has no social numbers) */
export async function socialBrief(db: SupabaseClient, clientId: string): Promise<string> {
  const d = await clientSocial(db, clientId).catch(() => null);
  if (!d) return "";
  const lines = [`Organic social (Facebook and Instagram, read only; data through ${d.through ?? "n/a"}):`];
  for (const p of d.platforms) {
    const g = p.growth;
    const name = p.platform === "instagram" ? `Instagram${p.name ? ` @${p.name}` : ""}` : `Facebook${p.name ? ` ${p.name}` : ""}`;
    lines.push(`- ${name}: ${p.followers != null ? `${k(p.followers)} followers` : "followers not read yet"}${g ? `, ${g.change >= 0 ? "+" : ""}${k(g.change)} in 30 days${g.prevChange != null ? ` (${g.prevChange >= 0 ? "+" : ""}${k(g.prevChange)} the 30 before)` : ""}` : ""}; reach ${p.now.reach != null ? k(p.now.reach) : "n/a"}${p.before.reach ? ` (${p.now.reach != null ? `${p.now.reach >= p.before.reach ? "+" : ""}${Math.round(((p.now.reach - p.before.reach) / p.before.reach) * 100)}%` : "n/a"} vs the 30 before)` : ""}; engagement rate ${p.now.rate != null ? p1(p.now.rate) : "n/a"}; ${p.postsPerWeek} posts a week${p.lastPostAt ? `, last ${p.lastPostAt.slice(0, 10)}` : ""}`);
  }
  const { best, weakest } = bestAndWeakest(filterPosts(d.posts, { platform: "all", days: 90 }, d.today), 2);
  const line = (x: PostView) => `${x.postedAt?.slice(0, 10) ?? "undated"} ${x.platform} ${x.format}${x.caption ? ` "${x.caption.replace(/\s+/g, " ").slice(0, 70)}"` : ""}: ${x.rate != null ? p1(x.rate) : "n/a"} engagement, ${x.interactions ?? 0} interactions${x.reach != null ? `, reach ${k(x.reach)}` : ""}`;
  if (best.length) lines.push(`- Best posts (90 days): ${best.map(line).join(" | ")}`);
  if (weakest.length) lines.push(`- Weakest posts (90 days): ${weakest.map(line).join(" | ")}`);
  const alerts = d.health.filter((h) => h.tone !== "good").slice(0, 5);
  const strengths = d.health.filter((h) => h.tone === "good").slice(0, 3);
  if (alerts.length) lines.push(`- Health alerts: ${alerts.map((h) => `${h.tone === "bad" ? "[red]" : "[amber]"} ${h.title}${h.action ? ` (${h.action})` : ""}`).join("; ")}`);
  if (strengths.length) lines.push(`- Strengths: ${strengths.map((h) => h.title).join("; ")}`);
  return lines.join("\n");
}
