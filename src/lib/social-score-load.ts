import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { etToday, shiftDay } from "@/lib/channel-kpis/calc";
import { promisedPosts, socialAccountScore, type SocialAccountScore, type SocialDayRow, type SocialPostRow } from "./social-score";

// Loads each client's social account score from the synced Meta tables (src/lib/social/store.ts): the last 60 days of
// days and 45 of posts, only the linked accounts' rows. Pass a person's session (RLS limits it to their clients) or the
// server client for an all-clients read (the audits, the sprints, the agents). Never throws: a table the database
// doesn't have yet reads as nothing to score.

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
  const [links, days, posts, targets, promised] = await Promise.all([
    db.from("social_accounts").select("client_id, page_id, ig_id").in("client_id", clientIds).then((r) => (r.error ? [] : (r.data ?? []))),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_daily").select("client_id, platform, account_id, date, followers, follows_gained, follows_lost, reach, views, interactions, profile_views").in("client_id", clientIds).gte("date", since).lte("date", today).order("client_id").order("platform").order("date").range(a, b),
    ),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_posts").select("client_id, platform, account_id, post_id, format, caption, permalink, posted_at, reach, views, interactions, likes, comments, saves, shares").in("client_id", clientIds).gte("posted_at", `${shiftDay(today, -45)}T00:00:00Z`).order("client_id").order("post_id").range(a, b),
    ),
    db.from("channel_targets").select("client_id, target").eq("line", "social").in("client_id", clientIds).then((r) => new Map((r.error ? [] : (r.data ?? [])).map((t) => [t.client_id as string, t.target == null ? null : Number(t.target)]))),
    packagePromises(db, clientIds).catch(() => new Map<string, number | null>()),
  ]);
  const linkBy = new Map(links.map((l) => [l.client_id as string, l]));
  // Only the linked accounts' rows (a Page or Instagram account picked before keeps its history, unread); TikTok rows
  // carry their own account and count once they exist
  const current = (r: Record<string, unknown>) => {
    const l = linkBy.get(r.client_id as string);
    if (r.platform === "facebook") return r.account_id === l?.page_id;
    if (r.platform === "instagram") return r.account_id === l?.ig_id;
    return true;
  };
  const dayBy = new Map<string, SocialDayRow[]>();
  for (const d of days) {
    if (!current(d)) continue;
    const k = d.client_id as string;
    const row: SocialDayRow = { platform: d.platform as string, date: d.date as string, followers: n(d.followers), gained: n(d.follows_gained), lost: n(d.follows_lost), reach: n(d.reach), views: n(d.views), interactions: n(d.interactions), profileViews: n(d.profile_views) };
    dayBy.set(k, [...(dayBy.get(k) ?? []), row]);
  }
  const postBy = new Map<string, SocialPostRow[]>();
  for (const p of posts) {
    if (!current(p)) continue;
    const k = p.client_id as string;
    const row: SocialPostRow = { platform: p.platform as string, postedAt: (p.posted_at as string | null) ?? null, format: (p.format as string | null) ?? null, reach: n(p.reach), views: n(p.views), likes: n(p.likes), comments: n(p.comments), interactions: n(p.interactions), saves: n(p.saves), shares: n(p.shares), caption: (p.caption as string | null) ?? null, permalink: (p.permalink as string | null) ?? null };
    postBy.set(k, [...(postBy.get(k) ?? []), row]);
  }
  for (const id of clientIds) {
    const s = socialAccountScore({ days: dayBy.get(id) ?? [], posts: postBy.get(id) ?? [], today, engagementTarget: targets.get(id) ?? null, promisedPerMonth: promised.get(id) ?? null });
    if (s) out.set(id, s);
  }
  return out;
}

export async function loadSocialScore(db: SupabaseClient, clientId: string): Promise<SocialAccountScore | null> {
  return (await loadSocialScores(db, [clientId]).catch(() => new Map<string, SocialAccountScore>())).get(clientId) ?? null;
}
