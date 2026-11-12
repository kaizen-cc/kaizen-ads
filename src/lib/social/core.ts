// What Meta's Graph API says about a client's Facebook Page and Instagram account, read into plain shapes, and what a
// failure means. Kept apart from the network and the database so it can be tested and used on the page itself.
// Read only: nothing here posts, edits or schedules anything on Meta.

export type Platform = "instagram" | "facebook";
export type PostFormat = "image" | "carousel" | "reel" | "video" | "link" | "text";

export const SOCIAL_BACKFILL_DAYS = 90;
const DAY = 86_400_000;
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOrNull = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ─── Which metrics, in the order tried ─────────────────────────────────────

/**
 * Facebook Page insights (period day). Meta retired the impressions family in favor of "views" (page_media_view and
 * page_total_media_view_unique), so each number lists the current metric first and the older one after; the first
 * one the Page answers is used, and one that isn't valid any more is skipped without failing the rest.
 */
export const FB_METRICS = {
  reach: ["page_total_media_view_unique", "page_impressions_unique"],
  views: ["page_media_view", "page_impressions"],
  engagement: ["page_post_engagements"],
  gained: ["page_daily_follows_unique", "page_daily_follows"],
  lost: ["page_daily_unfollows_unique"],
  followers: ["page_follows"],
  profileViews: ["page_views_total"],
} as const;
export type FbField = keyof typeof FB_METRICS;

/** Instagram account insights. reach and follower_count read as daily series; the rest are totals asked for one day at a time */
export const IG_SERIES_METRICS = ["reach", "follower_count"] as const;
export const IG_TOTAL_METRICS = ["views", "profile_views", "accounts_engaged", "total_interactions"] as const;

/** Instagram per-post insights, from the fullest set down: a type that refuses a metric (error 100) gets the next set */
export const IG_POST_METRIC_SETS = [["reach", "saved", "shares", "views", "total_interactions"], ["reach", "saved", "shares", "total_interactions"], ["reach", "saved"], ["reach"]] as const;

/** Facebook per-post insights (lifetime), the current metric first */
export const FB_POST_METRICS = { reach: ["post_total_media_view_unique", "post_impressions_unique"], views: ["post_media_view", "post_impressions"] } as const;

// ─── Reading answers ───────────────────────────────────────────────────────

/**
 * The calendar day (Pacific, where Meta cuts its days) a value's end_time closes: a day's value is stamped with the
 * next midnight Pacific (07:00 or 08:00 UTC), so the day is the one before.
 */
export function dayOfEndTime(endTime: unknown): string | null {
  const t = typeof endTime === "string" ? Date.parse(endTime) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t - DAY).toISOString().slice(0, 10);
}

/** insights with period=day (time series): metric name to { day: value }. Values that aren't plain numbers (breakdowns) are left out. */
export function parseSeries(json: unknown): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const m of arr(obj(json).data)) {
    const name = str(obj(m).name);
    if (!name) continue;
    const by = out.get(name) ?? new Map<string, number>();
    for (const v of arr(obj(m).values)) {
      const day = dayOfEndTime(obj(v).end_time);
      const value = numOrNull(obj(v).value);
      if (day && value != null) by.set(day, (by.get(day) ?? 0) + value);
    }
    out.set(name, by);
  }
  return out;
}

/** insights with metric_type=total_value: metric name to its total over the asked window */
export function parseTotals(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of arr(obj(json).data)) {
    const name = str(obj(m).name);
    const v = numOrNull(obj(obj(m).total_value).value) ?? numOrNull(obj(arr(obj(m).values)[0]).value);
    if (name && v != null) out.set(name, v);
  }
  return out;
}

export type SocialPost = {
  id: string;
  platform: Platform;
  format: PostFormat;
  caption: string | null;
  permalink: string | null;
  thumbnail: string | null;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  views: number | null;
  interactions: number | null;
  insightsOk: boolean;
};

export function igFormat(mediaType: unknown, productType: unknown): PostFormat {
  if (productType === "REELS") return "reel";
  if (mediaType === "VIDEO") return "video";
  if (mediaType === "CAROUSEL_ALBUM") return "carousel";
  return "image";
}

/** GET {ig}/media: the posts with their public counts (like_count is absent when the owner hides likes) */
export function parseIgMedia(json: unknown): SocialPost[] {
  const out: SocialPost[] = [];
  for (const m of arr(obj(json).data)) {
    const o = obj(m);
    const id = str(o.id);
    if (!id) continue;
    const likes = numOrNull(o.like_count);
    const comments = numOrNull(o.comments_count);
    out.push({
      id,
      platform: "instagram",
      format: igFormat(o.media_type, o.media_product_type),
      caption: str(o.caption)?.slice(0, 600) ?? null,
      permalink: str(o.permalink),
      thumbnail: str(o.thumbnail_url) ?? str(o.media_url),
      postedAt: str(o.timestamp),
      likes,
      comments,
      shares: null,
      saves: null,
      reach: null,
      views: null,
      interactions: likes == null && comments == null ? null : (likes ?? 0) + (comments ?? 0),
      insightsOk: false,
    });
  }
  return out;
}

export type PostInsights = { reach: number | null; saves: number | null; shares: number | null; views: number | null; totalInteractions: number | null };

/** GET {media}/insights: reach, saved, shares, views, total_interactions, whichever were asked for and given */
export function parseIgPostInsights(json: unknown): PostInsights {
  const by = new Map<string, number>();
  for (const m of arr(obj(json).data)) {
    const name = str(obj(m).name);
    const v = numOrNull(obj(arr(obj(m).values)[0]).value) ?? numOrNull(obj(obj(m).total_value).value);
    if (name && v != null) by.set(name, v);
  }
  return { reach: by.get("reach") ?? null, saves: by.get("saved") ?? null, shares: by.get("shares") ?? null, views: by.get("views") ?? null, totalInteractions: by.get("total_interactions") ?? null };
}

/** An Instagram post with its own insights laid on: interactions are Instagram's total when it gave one, else likes, comments, saves and shares */
export function withIgInsights(p: SocialPost, i: PostInsights | null): SocialPost {
  if (!i || (i.reach == null && i.saves == null && i.shares == null && i.views == null && i.totalInteractions == null)) return p;
  const sum = (p.likes ?? 0) + (p.comments ?? 0) + (i.saves ?? 0) + (i.shares ?? 0);
  return { ...p, reach: i.reach, saves: i.saves, shares: i.shares, views: i.views, interactions: i.totalInteractions ?? sum, insightsOk: true };
}

function fbFormat(attachmentType: unknown, statusType: unknown, hasPicture: boolean): PostFormat {
  const t = String(attachmentType ?? "").toLowerCase();
  const s = String(statusType ?? "").toLowerCase();
  if (/reel/.test(t) || /reel/.test(s)) return "reel";
  if (/video/.test(t) || /video/.test(s)) return "video";
  if (/album|multi/.test(t)) return "carousel";
  if (/photo|image/.test(t) || (hasPicture && !/link|share/.test(t))) return "image";
  if (/link|share/.test(t) || s === "shared_story") return "link";
  return hasPicture ? "image" : "text";
}

/** GET {page}/published_posts with reactions, comments and shares as counts */
export function parseFbPosts(json: unknown): SocialPost[] {
  const out: SocialPost[] = [];
  for (const m of arr(obj(json).data)) {
    const o = obj(m);
    const id = str(o.id);
    if (!id) continue;
    const reactions = numOrNull(obj(obj(o.reactions).summary).total_count);
    const comments = numOrNull(obj(obj(o.comments).summary).total_count);
    const shares = numOrNull(obj(o.shares).count) ?? 0;
    const att = obj(arr(obj(o.attachments).data)[0]);
    const picture = str(o.full_picture);
    out.push({
      id,
      platform: "facebook",
      format: fbFormat(att.media_type, o.status_type, Boolean(picture)),
      caption: str(o.message)?.slice(0, 600) ?? null,
      permalink: str(o.permalink_url),
      thumbnail: picture,
      postedAt: str(o.created_time),
      likes: reactions,
      comments,
      shares,
      saves: null,
      reach: null,
      views: null,
      interactions: (reactions ?? 0) + (comments ?? 0) + shares,
      insightsOk: false,
    });
  }
  return out;
}

// ─── Finding the Page and the Instagram account ─────────────────────────────

export type PageRef = { id: string; name: string; ig: { id: string; username: string | null } | null };

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

/**
 * The Page that is the client's, by name: an exact match first, then one name containing the other (at least 4
 * letters, so a short name doesn't match half the list). When more than one fits equally it's a guess, so none is
 * returned and a person picks. `onlyOneFallback`: a list of one Page (their ad account's only promotable Page) is theirs.
 */
export function matchPage<T extends { id: string; name: string }>(pages: T[], clientName: string, opts: { onlyOneFallback?: boolean } = {}): T | null {
  const c = norm(clientName);
  if (!c) return null;
  const exact = pages.filter((p) => norm(p.name) === c);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const loose = pages.filter((p) => {
    const n = norm(p.name);
    return n.length >= 4 && c.length >= 4 && (n.includes(c) || c.includes(n));
  });
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    // The closest in length is the best guess only when it's clearly closer
    const ranked = [...loose].sort((a, b) => Math.abs(norm(a.name).length - c.length) - Math.abs(norm(b.name).length - c.length));
    const d = (p: T) => Math.abs(norm(p.name).length - c.length);
    return d(ranked[0]) < d(ranked[1]) ? ranked[0] : null;
  }
  return opts.onlyOneFallback && pages.length === 1 ? pages[0] : null;
}

// ─── Failures, in plain words ──────────────────────────────────────────────

export type MetaCallKind = "discover" | "page_token" | "fb_basic" | "fb_insights" | "fb_posts" | "ig_basic" | "ig_insights" | "ig_media";

/** The permission on the Meta system user's token each kind of read needs */
export const PERMISSION_FOR: Record<MetaCallKind, string> = {
  discover: "pages_show_list",
  page_token: "pages_show_list",
  fb_basic: "pages_read_engagement",
  fb_insights: "read_insights",
  fb_posts: "pages_read_engagement",
  ig_basic: "instagram_basic",
  ig_insights: "instagram_manage_insights",
  ig_media: "instagram_basic",
};

const KNOWN = ["instagram_manage_insights", "instagram_basic", "pages_read_engagement", "read_insights", "pages_show_list", "pages_read_user_content", "business_management"];

/**
 * The permission a failed Graph read is missing, or null when the failure isn't a permission (a bad id, Meta being
 * busy). Meta usually names it in the message; else it's the one that read needs (PERMISSION_FOR). Codes 10 and 200
 * to 299 are Meta's permission errors.
 */
export function missingPermission(kind: MetaCallKind, err: { message?: string; code?: number | null }): string | null {
  const msg = String(err.message ?? "");
  const named = KNOWN.find((k) => msg.includes(k));
  if (named) return named;
  // The token can't see this object at all is an access problem, not a missing permission
  if (/does not exist|cannot be loaded|unsupported get request/i.test(msg)) return null;
  const code = err.code ?? null;
  const permissionish = code === 10 || (code != null && code >= 200 && code <= 299) || /(#(10|200|283|299))|permission|not authorized|requires/i.test(msg);
  return permissionish ? PERMISSION_FOR[kind] : null;
}

/** Why a metric isn't available any more (Meta answered 100 for the metric), so it's skipped instead of failing the read */
export const invalidMetric = (err: { message?: string; code?: number | null }) => err.code === 100 || /not a valid insights metric|metric.*(deprecated|no longer)|should be specified|invalid metric/i.test(String(err.message ?? ""));

export type SocialPlainError = { message: string; fix: string; severity: "bad" | "warn"; permissions: string[] };

const PERM_LABEL: Record<string, string> = {
  instagram_manage_insights: "Instagram insights (reach, views, follower changes, saves, shares)",
  instagram_basic: "the Instagram account's profile and posts",
  pages_read_engagement: "the Page's followers, posts and engagement",
  read_insights: "the Page's insights (reach, views, engagement)",
  pages_show_list: "the list of Pages the system user can reach",
  business_management: "the business's Pages",
  pages_read_user_content: "the Page's posts and comments",
};

/** The fix for a missing permission: exactly what to add to the Meta system user */
export const permissionFix = (perms: string[]) =>
  `Add ${perms.join(", ")} to the Meta system user's token (Business Settings > Users > System users > Generate new token, tick ${perms.length > 1 ? "them" : "it"}, then replace META_SYSTEM_USER_TOKEN in Vercel). Also check the system user has the Page and Instagram account assigned.`;

/**
 * What a social read's failure means, in plain words, with the fix. `stored` is last_error text, `missing` the
 * permissions named on the link. Never repeats a token (stored errors are already redacted).
 */
export function plainSocialError(stored: string | null | undefined, missing: string[] = []): SocialPlainError | null {
  const text = String(stored ?? "").trim();
  if (missing.length) {
    const what = missing.map((p) => PERM_LABEL[p] ?? p).join("; ");
    return { message: `The Meta system user is missing ${missing.join(", ")}: needed to read ${what}`, fix: permissionFix(missing), severity: "bad", permissions: missing };
  }
  if (!text) return null;
  if (/no page/i.test(text) && /link|pick|find/i.test(text)) return { message: "No Facebook Page is linked yet", fix: "Pick their Page (and Instagram account) on the Social tab; the system user must have the Page assigned in Business Settings.", severity: "bad", permissions: [] };
  if (/no access to this page|system user has no access|access token for this page/i.test(text)) return { message: "The Meta system user can't open this Page", fix: "In Business Settings, assign the Page to the CommandCenter system user (Pages > Add people) with Full control or Insights access, then sync again.", severity: "bad", permissions: [] };
  if (/\b190\b|access token|session has expired|token.*(expired|invalid)/i.test(text)) return { message: "Meta refused the system user's token", fix: "Generate a new system user token with the same permissions and replace META_SYSTEM_USER_TOKEN in Vercel.", severity: "bad", permissions: [] };
  if (/rate limit|\(#4\)|\(#17\)|\(#32\)|\(#613\)|too many calls/i.test(text)) return { message: "Meta is rate limiting the reads", fix: "Nothing to do: it tries again on the next run.", severity: "warn", permissions: [] };
  if (/Meta isn't connected|META_SYSTEM_USER_TOKEN/i.test(text)) return { message: "Meta isn't connected", fix: "Add META_SYSTEM_USER_TOKEN in Vercel.", severity: "bad", permissions: [] };
  if (/^Saving social_/i.test(text)) return { message: "The numbers were read but couldn't be saved", fix: "It tries again on the next run. If it keeps failing, the Social migration may be missing.", severity: "bad", permissions: [] };
  return { message: text.slice(0, 200), fix: "Sync it again; if it keeps failing, check the Page and Instagram account are assigned to the Meta system user.", severity: "bad", permissions: [] };
}

export type SocialClientState = "connected" | "behind" | "pending" | "failing" | "missing";

/** A day and a bit with no successful read is behind (the same line Sync health uses everywhere) */
export const SOCIAL_BEHIND_MS = 26 * 3_600_000;

/**
 * Where one client's social stands, from its link: missing (no Page or Instagram account linked: someone picks one),
 * failing (the last read failed or a permission is missing), pending (never read), behind or connected.
 */
export function socialClientState(link: { pageId: string | null; igId: string | null; lastSyncedAt: string | null; error: string | null; missing?: string[] } | null, now = Date.now()): { state: SocialClientState; error: SocialPlainError | null } {
  if (!link || (!link.pageId && !link.igId)) return { state: "missing", error: link ? plainSocialError(link.error, link.missing ?? []) : null };
  const error = plainSocialError(link.error, link.missing ?? []);
  if (error?.severity === "bad") return { state: "failing", error };
  if (!link.lastSyncedAt) return { state: "pending", error };
  return { state: now - Date.parse(link.lastSyncedAt) > SOCIAL_BEHIND_MS ? "behind" : "connected", error };
}

export type SocialWindow = "recent" | "full";

/** The full read (90 days of days, every recent post's insights) at most this often; recent the rest */
export const SOCIAL_FULL_EVERY_MS = 20 * 3_600_000;

export function pickSocialWindow(input: { lastFullAt: string | null; now?: number; everyMs?: number }): SocialWindow {
  if (!input.lastFullAt) return "full";
  const at = Date.parse(input.lastFullAt);
  if (!Number.isFinite(at)) return "full";
  return (input.now ?? Date.now()) - at >= (input.everyMs ?? SOCIAL_FULL_EVERY_MS) ? "full" : "recent";
}

/** About how long a client's read takes, for the run's budget */
export const socialCostMs = (w: SocialWindow) => (w === "full" ? 150_000 : 40_000);

/** Strip anything that looks like a token from an error before it's kept */
export const cleanError = (s: string) => s.replace(/(access_token=|EA[A-Za-z0-9]{20,})[^\s&"']*/g, "[token]").slice(0, 400);
