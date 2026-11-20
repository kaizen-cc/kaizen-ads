import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { etToday, shiftDay } from "@/lib/channel-kpis/calc";
import { promisedPosts, socialAccountScore, type SocialAccountScore, type SocialDayRow, type SocialPostRow } from "./social-score";
import { socialAllotmentPace, type SocialAllotment } from "./social-allotment-core";
import { linkedAccounts, isLinkedRow } from "./social/links";
import { linkKey, mergeAccountDays, type DayRow, type LinkedAccount } from "./social/links-core";

// Loads each client's social account score from the synced Meta tables (src/lib/social/store.ts): the last 60 days of
// days and 45 of posts, only the linked accounts' rows. Pass a person's session (RLS limits it to their clients) or the
// server client for an all-clients read (the audits, the sprints, the agents). Never throws: a table the database
// doesn't have yet reads as nothing to score. Only the platforms the client posts on are scored (their pick in the
// Services panel, else their tier's); the cadence check holds them to their tier's posts a month (else what the old
// tier's words promised); allotment pacing comes from this cycle's social allotment (src/lib/social-allotment-core.ts).

export type { SocialAccountScore } from "./social-score";

const n = (v: unknown) => (v == null ? null : Number(v));

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/** The posts a month each client's social package promises (null where the package doesn't say) */
async function packagePromises(db: SupabaseClient, ids: string[]): Promise<Map<string, number | null>> {
  const [{ data: picks, error }, { data: tiers }] = await Promise.all([
    db.from("client_service_tiers").select("client_id, service, tier_id, note").in("client_id", ids).in("service", ["social-media", "social"]),
    db.from("service_tiers").select("id, includes"),
  ]);
  if (error) return new Map();
  const inc = new Map((tiers ?? []).map((t) => [t.id as string, (t.includes as string | null) ?? null]));
  return new Map((picks ?? []).map((p) => [p.client_id as string, promisedPosts(`${p.note ?? ""} ${p.tier_id ? (inc.get(p.tier_id as string) ?? "") : ""}`)]));
}

export async function loadSocialScores(db: SupabaseClient, clientIds: string[], today = etToday()): Promise<Map<string, SocialAccountScore>> {
  const out = new Map<string, SocialAccountScore>();
  if (!clientIds.length) return out;
  const since = shiftDay(today, -60);
  const [linked, days, posts, targets, promised] = await Promise.all([
    linkedAccounts(db, clientIds).catch(() => new Map<string, LinkedAccount[]>()),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_daily").select("client_id, platform, account_id, date, followers, follows_gained, follows_lost, reach, views, interactions, profile_views").in("client_id", clientIds).gte("date", since).lte("date", today).order("client_id").order("platform").order("date").range(a, b),
    ),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_posts").select("client_id, platform, account_id, post_id, format, caption, permalink, posted_at, reach, views, interactions, likes, comments, saves, shares").in("client_id", clientIds).gte("posted_at", `${shiftDay(today, -45)}T00:00:00Z`).order("client_id").order("post_id").range(a, b),
    ),
    db.from("channel_targets").select("client_id, target").eq("line", "social").in("client_id", clientIds).then((r) => new Map((r.error ? [] : (r.data ?? [])).map((t) => [t.client_id as string, t.target == null ? null : Number(t.target)]))),
    packagePromises(db, clientIds).catch(() => new Map<string, number | null>()),
  ]);
  // Each client's social allotment this cycle: the platforms they post on, the tier's posts, and the pacing
  const allotments = await import("./social-allotment").then((m) => m.socialAllotments(db, clientIds)).catch(() => ({}) as Record<string, SocialAllotment>);
  // Only the linked accounts' rows (an account taken off keeps its history, unread); TikTok rows carry their own
  // account and count once they exist. Several locations' accounts are one platform for the client: their days are
  // added up per platform and day, their posts each their own
  const keys = new Map([...linked].map(([k, list]) => [k, new Set(list.map((a) => linkKey(a.platform, a.accountId)))]));
  const current = (r: Record<string, unknown>) => isLinkedRow(keys.get(r.client_id as string), r);
  const toDay = (d: Record<string, unknown>): SocialDayRow => ({ platform: d.platform as string, date: d.date as string, followers: n(d.followers), gained: n(d.follows_gained), lost: n(d.follows_lost), reach: n(d.reach), views: n(d.views), interactions: n(d.interactions), profileViews: n(d.profile_views) });
  const toPost = (p: Record<string, unknown>): SocialPostRow => ({ platform: p.platform as string, postedAt: (p.posted_at as string | null) ?? null, format: (p.format as string | null) ?? null, reach: n(p.reach), views: n(p.views), likes: n(p.likes), comments: n(p.comments), interactions: n(p.interactions), saves: n(p.saves), shares: n(p.shares), caption: (p.caption as string | null) ?? null, permalink: (p.permalink as string | null) ?? null });
  const rawDays = new Map<string, Record<string, unknown>[]>();
  for (const d of days) if (current(d)) rawDays.set(d.client_id as string, [...(rawDays.get(d.client_id as string) ?? []), d]);
  const rawPosts = new Map<string, Record<string, unknown>[]>();
  for (const p of posts) if (current(p)) rawPosts.set(p.client_id as string, [...(rawPosts.get(p.client_id as string) ?? []), p]);
  const dayBy = new Map([...rawDays].map(([k, rows]) => [k, mergeAccountDays(rows as DayRow[], ["followers", "follows_gained", "follows_lost", "reach", "views", "interactions", "profile_views"]).map(toDay)]));
  const postBy = new Map([...rawPosts].map(([k, rows]) => [k, rows.map(toPost)]));
  for (const id of clientIds) {
    const a = allotments[id] ?? null;
    const tierPosts = a && a.source !== "strategy" && a.posts.max != null && a.posts.max > 0 ? a.posts.max : null;
    const s = socialAccountScore({
      days: dayBy.get(id) ?? [],
      posts: postBy.get(id) ?? [],
      today,
      engagementTarget: targets.get(id) ?? null,
      promisedPerMonth: tierPosts ?? promised.get(id) ?? null,
      allotment: socialAllotmentPace(a),
      platforms: a?.platforms ?? null,
    });
    if (!s) continue;
    // More than one account on a platform (a Page per location): each scored on its own as well, for the breakdown
    const list = linked.get(id) ?? [];
    if (list.filter((x) => x.platform === "facebook").length > 1 || list.filter((x) => x.platform === "instagram").length > 1) {
      s.accounts = list
        .map((acc) => {
          const mine = (r: Record<string, unknown>) => r.platform === acc.platform && r.account_id === acc.accountId;
          const one = socialAccountScore({ days: (rawDays.get(id) ?? []).filter(mine).map(toDay), posts: (rawPosts.get(id) ?? []).filter(mine).map(toPost), today, engagementTarget: targets.get(id) ?? null, promisedPerMonth: tierPosts ?? promised.get(id) ?? null });
          const pl = one?.platforms[0] ?? null;
          return { platform: acc.platform, accountId: acc.accountId, name: acc.name, location: acc.location, score: one?.score ?? null, band: one?.band ?? null, followers: pl?.numbers.followers ?? null, reach: pl?.numbers.reach ?? null, rate: pl?.numbers.rate ?? null, posts: pl?.numbers.posts ?? 0 };
        })
        .sort((x, y) => x.platform.localeCompare(y.platform) || (y.reach ?? 0) - (x.reach ?? 0));
    }
    out.set(id, s);
  }
  return out;
}

export async function loadSocialScore(db: SupabaseClient, clientId: string): Promise<SocialAccountScore | null> {
  return (await loadSocialScores(db, [clientId]).catch(() => new Map<string, SocialAccountScore>())).get(clientId) ?? null;
}
