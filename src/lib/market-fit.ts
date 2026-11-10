// Live market ads for one client's own market only: their competitors, and brands in their own sub-vertical (the
// same placement the request form's "from similar clients" uses), never another industry's ads (no shoe brand for a
// coffee client). Then ranked for what's being talked about, so "Talk it through" can bring up the two or three that
// help. Pure: tested in tests/market-fit.test.ts.

export type MarketClient = { id: string; verticalId: string | null; industry: string | null };
export type FitAd = { brand: string; verticalId: string | null; industry: string | null; competitorOf: string[]; headline?: string | null; body?: string | null; angle?: string | null; hook?: string | null; why?: string | null; tags?: string[]; format?: string | null; proven?: boolean; early?: boolean; daysActive?: number | null };

const low = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * In this client's market: a competitor they named, or a brand placed in their own sub-vertical. A client not placed
 * in a sub-vertical yet falls back to the same industry (never "other").
 */
export function fitsClientMarket(ad: FitAd, c: MarketClient): boolean {
  if (ad.competitorOf.includes(c.id)) return true;
  if (c.verticalId) return ad.verticalId === c.verticalId;
  const ind = low(c.industry);
  return Boolean(ind) && ind !== "other" && low(ad.industry) === ind;
}

const STOP = new Set(["that", "this", "with", "from", "they", "their", "them", "what", "want", "make", "made", "about", "would", "could", "should", "have", "some", "more", "like", "just", "your", "ours", "into", "only", "also", "than", "then", "when", "where", "which", "while", "brief", "client", "creative", "video", "videos", "image", "images", "static", "statics", "carousel", "please", "thanks", "going", "really"]);

/** The words that carry a conversation's meaning (four letters or more, no filler) */
export const keywords = (text: string) => [...new Set(text.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)))];

/**
 * The market ads worth bringing up in a conversation: only this client's market, then the ones that share the most of
 * its words (angle, hook, copy, tags), proven runs and competitors first among equals. At most n, one per brand.
 */
export function marketForTalk<T extends FitAd>(ads: T[], client: MarketClient, text: string, n = 6): T[] {
  const words = keywords(text);
  const scored = ads
    .filter((a) => fitsClientMarket(a, client))
    .map((a) => {
      const hay = new Set(keywords([a.headline, a.body, a.angle, a.hook, a.why, a.format, ...(a.tags ?? [])].filter(Boolean).join(" ")));
      const hits = words.filter((w) => hay.has(w)).length;
      const score = hits * 3 + (a.competitorOf.includes(client.id) ? 2 : 0) + (a.proven ? 1.5 : a.early ? 0.75 : 0) + Math.min(a.daysActive ?? 0, 120) / 120;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const { a } of scored) {
    if (seen.has(a.brand)) continue;
    seen.add(a.brand);
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * The market ads the AI brought up in its reply (by id in brackets, "[M2]"), at most three, and the reply without the
 * ids (the cards under it show which ads they are).
 */
export function pickedMarket<T>(reply: string, market: T[] | undefined): { reply: string; picked: T[] } {
  const ids = [...reply.matchAll(/\[M(\d{1,2})\]/gi)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= (market?.length ?? 0));
  const picked = [...new Set(ids)].slice(0, 3).map((n) => market![n - 1]);
  return { reply: reply.replace(/\s*\[M\d{1,2}\]/gi, "").trim(), picked };
}
