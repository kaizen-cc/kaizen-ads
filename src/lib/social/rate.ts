// The engagement rate and what to do when Meta leaves out what it is built on. Pure, so the Social tab, the KPI board,
// the score, the reports and the agents all read one rule, and a number always says which basis it was worked out on.
//
// The chain, first one that can be worked out wins:
//   1. interactions / reach      the standard (the people who saw it); the client's own target applies here
//   2. interactions / views      when Meta gave no reach (impressions-based); runs lower than the reach rate
//   3. interactions per post / followers   when it gave neither (the industry's follower-based rate); lower again
// Interactions missing: the posts' own likes + comments + shares + saves, added up. Reach or views missing for a period:
// the posts' own reach or views, added up, with the note that they came from posts (people seen on two posts count twice).
// Rates on different bases are never compared: each basis has its own bar, and a "before" is read on the same basis as "now".

export type RateBasis = "reach" | "views" | "followers";
export type Source = "meta" | "posts";

/** The bar each fallback basis is held to (reach uses the client's target, else Kaizen's 5%). Views and followers run lower, so they have their own. */
export const FALLBACK_BARS: Record<Exclude<RateBasis, "reach">, number> = { views: 0.03, followers: 0.01 };
export const DEFAULT_REACH_BAR = 0.05;

export const BASIS_ORDER: readonly RateBasis[] = ["reach", "views", "followers"];

/** The bar a rate on this basis is held to; `target` (the client's own, or Kaizen's) only ever applies to the reach basis */
export function barFor(basis: RateBasis | null | undefined, target: number | null | undefined): number {
  if (basis === "views" || basis === "followers") return FALLBACK_BARS[basis];
  return target != null && target > 0 ? target : DEFAULT_REACH_BAR;
}

/** What the rate is over, in words: "interactions over reach" */
export function basisSentence(basis: RateBasis | null | undefined, reachFrom: Source | null | undefined = "meta"): string {
  if (basis === "views") return "Interactions over views";
  if (basis === "followers") return "Interactions per post over followers";
  return reachFrom === "posts" ? "Interactions over the posts' reach" : "Interactions over reach";
}

/** The small label that rides beside a rate that isn't the standard one ("by views"); null for the standard (reach) */
export function basisLabel(basis: RateBasis | null | undefined, reachFrom: Source | null | undefined = "meta"): string | null {
  if (basis === "views") return "by views";
  if (basis === "followers") return "by followers";
  if (basis === "reach" && reachFrom === "posts") return "by post reach";
  return null;
}

/** "3.1% by views" / "3.1%": the rate with its label when it has one */
export function rateWithBasis(text: string, basis: RateBasis | null | undefined, reachFrom?: Source | null): string {
  const l = basisLabel(basis, reachFrom);
  return l && text !== "–" && text !== "n/a" ? `${text} ${l}` : text;
}

/** What the missing numbers mean, in the client's words; used where a zero would otherwise be drawn */
export const NOT_REPORTED = { reach: "Meta didn't report reach for this period", views: "Meta didn't report views for this period", interactions: "Meta didn't report interactions for this period" } as const;

export type PostLike = { reach?: number | null; views?: number | null; interactions?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null };

/** A post's interactions: its own total, else likes + comments + shares + saves (null when it has none of them) */
export function postInteractionsOf(p: PostLike): number | null {
  if (p.interactions != null) return p.interactions;
  const parts = [p.likes, p.comments, p.shares, p.saves];
  return parts.some((x) => x != null) ? parts.reduce<number>((n, x) => n + (x ?? 0), 0) : null;
}

export type PostSums = {
  count: number;
  /** Added up over the posts that have the number; null when none does */
  reach: number | null;
  views: number | null;
  interactions: number | null;
  /** The interactions of just the posts that have a reach (or views): the matching top of the rate */
  reachedInteractions: number | null;
  viewedInteractions: number | null;
};

const addTo = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b);

export function postSums(posts: PostLike[]): PostSums {
  let reach: number | null = null;
  let views: number | null = null;
  let interactions: number | null = null;
  let reachedInteractions: number | null = null;
  let viewedInteractions: number | null = null;
  for (const p of posts) {
    const i = postInteractionsOf(p);
    interactions = addTo(interactions, i);
    if (p.reach != null && p.reach > 0) {
      reach = addTo(reach, p.reach);
      reachedInteractions = addTo(reachedInteractions, i ?? 0);
    }
    if (p.views != null && p.views > 0) {
      views = addTo(views, p.views);
      viewedInteractions = addTo(viewedInteractions, i ?? 0);
    }
  }
  return { count: posts.length, reach, views, interactions, reachedInteractions, viewedInteractions };
}

export type RateInput = {
  /** The account's totals for the period as Meta gave them (null: Meta gave none) */
  interactions: number | null;
  reach: number | null;
  views: number | null;
  /** Followers at the period's end, and the posts published in it (the follower-based rate is per post) */
  followers: number | null;
  posts: number;
  /** The posts' own numbers, added up (postSums), used where the account's are missing */
  fromPosts?: PostSums | null;
};

/** What a rate on one basis is worked out from: interactions over a denominator (kept so platforms add up exactly and a "before" can be read on the same basis) */
export type RatePart = { top: number; den: number };
export type RateParts = Partial<Record<RateBasis, RatePart>>;

export type RateRead = {
  rate: number | null;
  basis: RateBasis | null;
  /** Every basis that could be worked out, not only the one used */
  parts: RateParts;
  /** The numbers as used: the account's own, else the posts' added up (and where each came from) */
  interactions: number | null;
  interactionsFrom: Source | null;
  reach: number | null;
  reachFrom: Source | null;
  views: number | null;
  viewsFrom: Source | null;
};

const positive = (x: number | null | undefined): x is number => x != null && x > 0;

/** The account's reach, views and interactions with the posts' sums filling what Meta left out */
export function fillFromPosts(i: RateInput): Pick<RateRead, "interactions" | "interactionsFrom" | "reach" | "reachFrom" | "views" | "viewsFrom"> {
  const p = i.fromPosts ?? null;
  const reach = positive(i.reach) ? i.reach : positive(p?.reach) ? p!.reach : (i.reach ?? null);
  const views = positive(i.views) ? i.views : positive(p?.views) ? p!.views : (i.views ?? null);
  const interactions = i.interactions != null ? i.interactions : (p?.interactions ?? null);
  return {
    interactions,
    interactionsFrom: interactions == null ? null : i.interactions != null ? "meta" : "posts",
    reach,
    reachFrom: reach == null ? null : positive(i.reach) || !positive(p?.reach) ? "meta" : "posts",
    views,
    viewsFrom: views == null ? null : positive(i.views) || !positive(p?.views) ? "meta" : "posts",
  };
}

/** The first basis in the chain that is in `parts` ("only" pins it to one); null when none is */
export function pickBasis(parts: RateParts, only?: RateBasis | null): RateBasis | null {
  return (only ? [only] : BASIS_ORDER).find((b) => parts[b] != null && parts[b]!.den > 0) ?? null;
}

/**
 * The engagement rate down the chain. `only` pins it to one basis (a "before" is read on the basis "now" used, so the two
 * are like with like); the rate is then null when that basis can't be worked out.
 */
export function engagementChain(i: RateInput, opts: { only?: RateBasis | null } = {}): RateRead {
  const f = fillFromPosts(i);
  const p = i.fromPosts ?? null;
  const parts: RateParts = {};
  if (f.interactions != null) {
    if (positive(f.reach)) parts.reach = { top: f.reachFrom === "posts" ? (p?.reachedInteractions ?? f.interactions) : f.interactions, den: f.reach };
    if (positive(f.views)) parts.views = { top: f.viewsFrom === "posts" ? (p?.viewedInteractions ?? f.interactions) : f.interactions, den: f.views };
    // Followers: each post's interactions over the followers, averaged over the posts (no post counts as one)
    if (positive(i.followers)) parts.followers = { top: f.interactions, den: Math.max(1, i.posts) * i.followers };
  }
  const basis = pickBasis(parts, opts.only);
  return { rate: basis ? parts[basis]!.top / parts[basis]!.den : null, basis, parts, ...f };
}

/** Several platforms as one account: the first basis every platform with interactions has, else the first any has (the rest drop out of the rate) */
export function combineParts(list: RateParts[], opts: { only?: RateBasis | null } = {}): { rate: number | null; basis: RateBasis | null; parts: RateParts } {
  const live = list.filter((x) => BASIS_ORDER.some((b) => x[b] != null));
  const parts: RateParts = {};
  for (const b of BASIS_ORDER) {
    const have = live.filter((x) => x[b] != null);
    if (!have.length) continue;
    parts[b] = { top: have.reduce((n, x) => n + x[b]!.top, 0), den: have.reduce((n, x) => n + x[b]!.den, 0) };
  }
  const order = opts.only ? [opts.only] : BASIS_ORDER;
  const basis = order.find((b) => live.length > 0 && live.every((x) => x[b] != null && x[b]!.den > 0)) ?? pickBasis(parts, opts.only);
  return { rate: basis && parts[basis] && parts[basis]!.den > 0 ? parts[basis]!.top / parts[basis]!.den : null, basis: basis && parts[basis] ? basis : null, parts };
}

/** What to say about a rate and the numbers under it: why a number is missing or filled in. Empty when all is as usual. */
export function rateNotes(r: { basis: RateBasis | null; reach: number | null; reachFrom?: Source | null; interactions?: number | null }): string[] {
  const out: string[] = [];
  if (r.reach == null || r.reach === 0) out.push(NOT_REPORTED.reach);
  else if (r.reachFrom === "posts") out.push("Reach is added up from the posts: Meta didn't report it for the account this period");
  if (r.basis === "views") out.push("Engagement is over views: Meta didn't report reach for this period");
  if (r.basis === "followers") out.push("Engagement is per post over followers: Meta reported neither reach nor views for this period");
  if (r.interactions == null) out.push(NOT_REPORTED.interactions);
  return out;
}
