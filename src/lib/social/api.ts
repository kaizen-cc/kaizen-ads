import "server-only";
import { metaGraph, metaGraphAs } from "@/lib/context/meta";
import { runBounded } from "@/lib/bounded";
import { FB_METRICS, FB_POST_METRICS, IG_POST_METRIC_SETS, IG_SERIES_METRICS, IG_TOTAL_METRICS, invalidMetric, missingPermission, parseFbPosts, parseIgMedia, parseIgPostInsights, parseSeries, parseTotals, shiftDay, type FbField, type MetaCallKind, type PageRef, type PostInsights, type SocialPost } from "./core";

// Meta's Graph API for a client's Facebook Page and Instagram business account, read only (GET calls). Reads use
// Kaizen's Meta system user (the Business Manager's token the client picked when it has one). Page insights need the
// Page's own access token, fetched from the system user (GET /{page}?fields=access_token). A failure that is a missing
// permission carries the permission's name, so it shows on the tab and Sync health as exactly what to add.

export class SocialReadError extends Error {
  constructor(
    message: string,
    public kind: MetaCallKind,
    public code: number | null,
    public permission: string | null,
  ) {
    super(message);
  }
}

export type SocialCtx = { account: string | null; pageToken: string | null };

type Failure = Error & { metaCode?: number };

function wrap(kind: MetaCallKind, e: unknown): SocialReadError {
  const err = e as Failure;
  const code = err.metaCode ?? null;
  const message = e instanceof Error ? e.message : String(e);
  return new SocialReadError(message, kind, code, missingPermission(kind, { message, code }));
}

/** A read with the system user's own routed token (the client's Business Manager when it has one) */
async function viaSystem<T>(ctx: SocialCtx, kind: MetaCallKind, path: string, params: Record<string, string>): Promise<T> {
  try {
    return await metaGraph<T>(path, params, "GET", { account: ctx.account });
  } catch (e) {
    throw wrap(kind, e);
  }
}

/** A read with the Page's own token, falling back to the system user's when there isn't one */
async function viaPage<T>(ctx: SocialCtx, kind: MetaCallKind, path: string, params: Record<string, string>): Promise<T> {
  if (!ctx.pageToken) return viaSystem<T>(ctx, kind, path, params);
  try {
    return await metaGraphAs<T>(ctx.pageToken, path, params);
  } catch (e) {
    throw wrap(kind, e);
  }
}

/** Instagram: the system user's token first, then the Page's, whichever Meta lets read the account */
async function viaIg<T>(ctx: SocialCtx, kind: MetaCallKind, path: string, params: Record<string, string>): Promise<T> {
  try {
    return await viaSystem<T>(ctx, kind, path, params);
  } catch (e) {
    if (!ctx.pageToken || !(e instanceof SocialReadError) || invalidMetric(e)) throw e;
    try {
      return await metaGraphAs<T>(ctx.pageToken, path, params);
    } catch {
      throw e;
    }
  }
}

// ─── Finding Pages ─────────────────────────────────────────────────────────

type PageRow = { id: string; name?: string; instagram_business_account?: { id: string; username?: string } };

const toRef = (p: PageRow): PageRef => ({ id: p.id, name: p.name ?? p.id, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null } : null });

/** The Pages a client's ad account can promote (their own, when they run ads), each with its Instagram account */
export async function promotePages(account: string): Promise<PageRef[]> {
  const ctx: SocialCtx = { account, pageToken: null };
  const fields = "name,instagram_business_account{id,username}";
  try {
    const r = await viaSystem<{ data: PageRow[] }>(ctx, "discover", `act_${account}/promote_pages`, { fields, limit: "50" });
    return (r.data ?? []).map(toRef);
  } catch {
    const r = await viaSystem<{ data: PageRow[] }>(ctx, "discover", `act_${account}/promote_pages`, { fields: "name", limit: "50" }).catch(() => ({ data: [] as PageRow[] }));
    return (r.data ?? []).map(toRef);
  }
}

/** Every Page the system user has been given (pages_show_list), with its Instagram account */
export async function systemPages(): Promise<PageRef[]> {
  const ctx: SocialCtx = { account: null, pageToken: null };
  const out: PageRef[] = [];
  let after: string | null = null;
  for (let i = 0; i < 4; i++) {
    const r: { data: PageRow[]; paging?: { cursors?: { after?: string }; next?: string } } = await viaSystem(ctx, "discover", "me/accounts", { fields: "name,instagram_business_account{id,username}", limit: "100", ...(after ? { after } : {}) });
    out.push(...(r.data ?? []).map(toRef));
    after = r.paging?.next ? (r.paging.cursors?.after ?? null) : null;
    if (!after) break;
  }
  return out;
}

/** The Page's own access token from the system user; null when the system user can't act on that Page */
export async function pageAccessToken(account: string | null, pageId: string): Promise<string | null> {
  const r = await viaSystem<{ access_token?: string }>({ account, pageToken: null }, "page_token", pageId, { fields: "access_token" });
  return r.access_token ?? null;
}

/** One Page's Instagram account (when the picked Page has one) */
export async function pageInstagram(account: string | null, pageId: string): Promise<{ id: string; username: string | null } | null> {
  const r = await viaSystem<{ name?: string; instagram_business_account?: { id: string; username?: string } }>({ account, pageToken: null }, "discover", pageId, { fields: "name,instagram_business_account{id,username}" });
  return r.instagram_business_account ? { id: r.instagram_business_account.id, username: r.instagram_business_account.username ?? null } : null;
}

export async function pageName(account: string | null, pageId: string): Promise<string | null> {
  const r = await viaSystem<{ name?: string }>({ account, pageToken: null }, "discover", pageId, { fields: "name" });
  return r.name ?? null;
}

// ─── Instagram ─────────────────────────────────────────────────────────────

export async function igProfile(ctx: SocialCtx, igId: string): Promise<{ followers: number | null; mediaCount: number | null; username: string | null }> {
  const r = await viaIg<{ followers_count?: number; media_count?: number; username?: string }>(ctx, "ig_basic", igId, { fields: "followers_count,media_count,username" });
  return { followers: r.followers_count ?? null, mediaCount: r.media_count ?? null, username: r.username ?? null };
}

const CHUNK = 28; // Instagram answers a daily series for at most 30 days at a time

/**
 * Reach and follows gained per day for [from, to], a metric at a time in pieces of 28 days (Instagram's limit; follower
 * changes only go back 30 days). A metric Instagram no longer gives is skipped (listed in `skipped`); a missing
 * permission throws.
 */
export async function igSeries(ctx: SocialCtx, igId: string, from: string, to: string, today: string): Promise<{ reach: Map<string, number>; gained: Map<string, number>; skipped: string[] }> {
  const out = { reach: new Map<string, number>(), gained: new Map<string, number>(), skipped: [] as string[] };
  for (const metric of IG_SERIES_METRICS) {
    const target = metric === "reach" ? out.reach : out.gained;
    const lo = metric === "follower_count" && from < shiftDay(today, -28) ? shiftDay(today, -28) : from;
    let ok = false;
    for (let s = lo; s <= to; s = shiftDay(s, CHUNK)) {
      const e = shiftDay(s, CHUNK) > shiftDay(to, 1) ? shiftDay(to, 1) : shiftDay(s, CHUNK);
      try {
        const r = await viaIg(ctx, "ig_insights", `${igId}/insights`, { metric, period: "day", since: s, until: e });
        for (const [day, v] of parseSeries(r).get(metric) ?? []) target.set(day, v);
        ok = true;
      } catch (err) {
        if (err instanceof SocialReadError && err.permission) throw err;
        if (!(err instanceof SocialReadError && invalidMetric(err))) throw err;
      }
    }
    if (!ok) out.skipped.push(metric);
  }
  return out;
}

/**
 * One day's totals for views, profile views, accounts engaged and total interactions (these four are asked for as a
 * total over a window, so a daily value is a one-day window). If Instagram refuses the set (a metric it doesn't
 * know), each is asked on its own and the ones it refuses are skipped.
 */
export async function igDayTotals(ctx: SocialCtx, igId: string, day: string): Promise<{ totals: Map<string, number>; skipped: string[] }> {
  const params = { period: "day", metric_type: "total_value", since: day, until: shiftDay(day, 1) };
  try {
    const r = await viaIg(ctx, "ig_insights", `${igId}/insights`, { ...params, metric: IG_TOTAL_METRICS.join(",") });
    return { totals: parseTotals(r), skipped: [] };
  } catch (e) {
    if (!(e instanceof SocialReadError) || e.permission || !invalidMetric(e)) throw e;
  }
  const totals = new Map<string, number>();
  const skipped: string[] = [];
  for (const metric of IG_TOTAL_METRICS) {
    try {
      const r = await viaIg(ctx, "ig_insights", `${igId}/insights`, { ...params, metric });
      for (const [k, v] of parseTotals(r)) totals.set(k, v);
    } catch (e) {
      if (!(e instanceof SocialReadError) || e.permission || !invalidMetric(e)) throw e;
      skipped.push(metric);
    }
  }
  return { totals, skipped };
}

/** The last `limit` posts with their public counts */
export async function igMedia(ctx: SocialCtx, igId: string, limit = 50): Promise<SocialPost[]> {
  const r = await viaIg(ctx, "ig_media", `${igId}/media`, { fields: "id,caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink,thumbnail_url,media_url", limit: String(limit) });
  return parseIgMedia(r);
}

/** One post's own insights, from the fullest metric set down; null where Meta doesn't give any (old posts, stories) */
async function igPostInsights(ctx: SocialCtx, mediaId: string): Promise<{ insights: PostInsights | null; permission: string | null }> {
  let permission: string | null = null;
  for (const set of IG_POST_METRIC_SETS) {
    try {
      const r = await viaIg(ctx, "ig_insights", `${mediaId}/insights`, { metric: set.join(",") });
      return { insights: parseIgPostInsights(r), permission: null };
    } catch (e) {
      if (e instanceof SocialReadError && e.permission && e.code === 10 && /instagram_manage_insights|permission/i.test(e.message) && !/media/i.test(e.message)) permission = e.permission;
      if (e instanceof SocialReadError && invalidMetric(e)) continue;
      return { insights: null, permission };
    }
  }
  return { insights: null, permission };
}

/** Insights for many posts, a few at a time. `permission` is set only when no post at all could be read and Meta named a permission */
export async function igPostsInsights(ctx: SocialCtx, ids: string[]): Promise<{ by: Map<string, PostInsights>; permission: string | null }> {
  const by = new Map<string, PostInsights>();
  let permission: string | null = null;
  await runBounded(ids, { limit: 5 }, async (id) => {
    const r = await igPostInsights(ctx, id);
    if (r.insights) by.set(id, r.insights);
    else if (r.permission) permission = r.permission;
  });
  return { by, permission: by.size ? null : permission };
}

// ─── Facebook ──────────────────────────────────────────────────────────────

export async function fbProfile(ctx: SocialCtx, pageId: string): Promise<{ followers: number | null; name: string | null }> {
  const r = await viaPage<{ name?: string; followers_count?: number; fan_count?: number }>(ctx, "fb_basic", pageId, { fields: "name,followers_count,fan_count" });
  return { followers: r.followers_count ?? r.fan_count ?? null, name: r.name ?? null };
}

/**
 * One Page number per day for [from, to] (at most 90 days in one ask): the current metric first, the older name after.
 * `used` says which answered. A metric Meta retired is skipped; none answering gives an empty map (listed in `skipped`
 * by the caller), unless Meta named a missing permission, which throws.
 */
export async function fbSeries(ctx: SocialCtx, pageId: string, field: FbField, from: string, to: string): Promise<{ days: Map<string, number>; used: string | null }> {
  let permission: SocialReadError | null = null;
  for (const metric of FB_METRICS[field]) {
    try {
      const r = await viaPage(ctx, "fb_insights", `${pageId}/insights`, { metric, period: "day", since: from, until: shiftDay(to, 1) });
      return { days: parseSeries(r).get(metric) ?? new Map(), used: metric };
    } catch (e) {
      if (!(e instanceof SocialReadError)) throw e;
      if (e.permission) permission = e;
      else if (!invalidMetric(e)) throw e;
    }
  }
  if (permission) throw permission;
  return { days: new Map(), used: null };
}

/** The Page's recent published posts with reactions, comments and shares */
export async function fbPosts(ctx: SocialCtx, pageId: string, limit = 40): Promise<SocialPost[]> {
  const r = await viaPage(ctx, "fb_posts", `${pageId}/published_posts`, { fields: "message,created_time,full_picture,permalink_url,status_type,attachments{media_type},shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", limit: String(limit) });
  return parseFbPosts(r);
}

/** Lifetime reach and views for posts, one batched ask per metric (ids=), the current metric first; posts Meta doesn't answer for stay without */
export async function fbPostsInsights(ctx: SocialCtx, ids: string[]): Promise<Map<string, { reach: number | null; views: number | null }>> {
  const out = new Map<string, { reach: number | null; views: number | null }>();
  for (let i = 0; i < ids.length; i += 25) {
    const part = ids.slice(i, i + 25);
    for (const field of ["reach", "views"] as const) {
      for (const metric of FB_POST_METRICS[field]) {
        try {
          const r = await viaPage<Record<string, { insights?: { data?: { name?: string; values?: { value?: unknown }[] }[] } }>>(ctx, "fb_insights", "", { ids: part.join(","), fields: `insights.metric(${metric}).period(lifetime)` });
          let any = false;
          for (const id of part) {
            const v = r[id]?.insights?.data?.find((d) => d.name === metric)?.values?.[0]?.value;
            if (typeof v === "number") {
              out.set(id, { reach: out.get(id)?.reach ?? null, views: out.get(id)?.views ?? null, [field]: v });
              any = true;
            }
          }
          if (any) break;
        } catch {
          // the older metric name next, or none for these posts
        }
      }
    }
  }
  return out;
}
