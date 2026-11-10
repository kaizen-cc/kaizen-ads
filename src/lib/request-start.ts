import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { industryLabel, industryWinners, tiktokPeerWinners, type Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { SuggestionDraft } from "@/lib/suggestions";
import { SAVED_COLS, toSaved, type SavedRef } from "@/lib/saved-references";
import { CREATIVE_FORMATS, fitsAnyFormat, fitsFormat, marketFormatOf, seesAllFormats, type CreativeFormat } from "@/lib/creative-formats";
import { promiseSince } from "@/lib/promise-window";

// Everything the "How do you want to start?" page shows for a client, in one go, from what's already stored: the briefs
// the strategist writes every day (ads tiring, numbers off, moments, patterns), promises from calls, what's proven for
// similar clients, and the market ads Motion keeps. No AI at all here: adapting one to the client happens when it's picked.

export type StartBrief = { id: string; kind: string; signal: string; why: string; title: string; angle: string; thumb: string | null; adId: string | null; formats: string; createdAt: string };
export type StartPromise = { id: string; kind: string; what: string; callTitle: string; callAt: string; internal: boolean; briefed: boolean };
export type StartPattern = { id: string; title: string; detail: string; group: string; kind: string; clients: number; of: number; confidence: string; uses: boolean };
export type StartData = {
  clientId: string;
  briefs: StartBrief[];
  promises: StartPromise[];
  patterns: StartPattern[];
  winners: Winner[];
  winnersLabel: string | null;
  /** How close the winners are: 1 same product, 2 same niche (never only the broad industry: then there are none) */
  winnersTier: 1 | 2 | null;
  /** What the client sells, in a few words, for saying what "similar" means */
  detail: string | null;
  market: MarketAd[];
  /** More market ads to load past these */
  marketMore: boolean;
  marketLabel: string | null;
  /** Ideas this person saved for this client: not used yet, or put in motion by someone else */
  saved: SavedRef[];
  /** How long each read took (ms), for the dev log */
  timings?: Record<string, number>;
};

const FMT_WORD = { image: "image", video: "video", carousel: "carousel" } as const;
const formatsLine = (d: SuggestionDraft, allowed: ReadonlySet<CreativeFormat>) => (d.formats ?? []).filter((f) => allowed.has(f.format)).map((f) => `${f.new + f.variations} ${FMT_WORD[f.format]}${f.new + f.variations === 1 ? "" : "s"}`).join(" + ");

/** Times a read for the dev log, never failing the page: an empty answer instead */
async function timed<T>(timings: Record<string, number>, key: string, run: () => Promise<T>, empty: T): Promise<T> {
  const t = Date.now();
  try {
    return await run();
  } catch (e) {
    console.error(`[request start] ${key}`, e instanceof Error ? e.message : e);
    return empty;
  } finally {
    timings[key] = Date.now() - t;
  }
}

/**
 * The start page's sections for one client, read in parallel with the person's own access (db is their client). Only
 * what fits the formats the person works in (`allowed`, from their role): a designer never sees video examples.
 */
export async function startSections(db: SupabaseClient, clientId: string, allowed: ReadonlySet<CreativeFormat> = new Set(CREATIVE_FORMATS), meId: string | null = null): Promise<StartData> {
  const all = seesAllFormats(allowed);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const { data: c } = await db.from("clients").select("id, industry, industry_detail").eq("id", clientId).maybeSingle();
  timings.client = Date.now() - t0;
  const industry = c?.industry && c.industry !== "other" ? (c.industry as string) : null;
  if (!c) return { clientId, briefs: [], promises: [], patterns: [], winners: [], winnersLabel: null, winnersTier: null, detail: null, market: [], marketMore: false, marketLabel: null, saved: [], timings };

  const [briefs, promises, patterns, winners, market, saved] = await Promise.all([
    timed(
      timings,
      "briefs",
      async () => {
        const { data } = await db
          .from("creative_suggestions")
          .select("id, kind, signal, why, draft, source, created_at")
          .eq("client_id", clientId)
          .eq("status", "open")
          .neq("kind", "onboarding")
          .order("created_at", { ascending: false })
          .limit(all ? 12 : 40);
        return (data ?? [])
          .filter((r) => fitsAnyFormat(allowed, ((r.draft as SuggestionDraft | null)?.formats ?? []).map((f) => f.format)))
          .slice(0, 12)
          .map((r) => {
            const d = r.draft as SuggestionDraft | null;
            const src = r.source as { thumbnail?: string | null; adId?: string | null } | null;
            const adId = src?.adId && /^\d{5,25}$/.test(src.adId) ? src.adId : null;
            return { id: r.id as string, kind: r.kind as string, signal: r.signal as string, why: r.why as string, title: d?.title ?? "", angle: d?.angle ?? "", thumb: src?.thumbnail ?? null, adId, formats: d ? formatsLine(d, allowed) : "", createdAt: r.created_at as string };
          });
      },
      [] as StartBrief[],
    ),
    timed(
      timings,
      "promises",
      async () => {
        const { data } = await db
          .from("call_commitments")
          .select("id, kind, what, status, suggestion_id, client_calls!inner(title, occurred_at, status)")
          .gte("client_calls.occurred_at", promiseSince())
          .eq("client_id", clientId)
          .in("status", ["open", "briefed"])
          .in("kind", ["creative", "copy", "offer"])
          .order("created_at", { ascending: false })
          .limit(8);
        return (data ?? []).map((x) => {
          const call = x.client_calls as unknown as { title: string; occurred_at: string; status: string } | null;
          return { id: x.id as string, kind: x.kind as string, what: x.what as string, callTitle: call?.title ?? "A call", callAt: call?.occurred_at ?? "", internal: call?.status === "internal", briefed: x.status === "briefed" && Boolean(x.suggestion_id) };
        });
      },
      [] as StartPromise[],
    ),
    timed(
      timings,
      "patterns",
      async () => {
        const { patternsForClient } = await import("@/lib/patterns");
        const { patterns } = await patternsForClient(db, clientId);
        return patterns
          .filter((p) => p.verdict === "works")
          .slice(0, 6)
          .map((p) => ({ id: p.id, title: p.title, detail: p.detail, group: p.group, kind: p.kind, clients: p.evidence.clients, of: p.evidence.of, confidence: p.confidence, uses: p.uses }));
      },
      [] as StartPattern[],
    ),
    timed(
      timings,
      "winners",
      async () => {
        // Meta's winners from the most similar clients, then our own TikTok winners from the same kind of peers (labelled
        // TikTok, their pictures from the TikTok sync); the same rule for both: same product or niche, never broader
        const [meta, tiktok] = await Promise.all([
          industry ? industryWinners(db, industry, clientId, all ? 6 : 24).then((ws) => ws.filter((w) => fitsFormat(allowed, w.format)).slice(0, 6)) : Promise.resolve([] as Winner[]),
          tiktokPeerWinners(db, clientId, 4)
            .then((ws) => ws.filter((w) => fitsFormat(allowed, w.format)).slice(0, 3))
            .catch(() => [] as Winner[]),
        ]);
        return [...meta, ...tiktok];
      },
      [] as Winner[],
    ),
    timed(timings, "market", () => marketPage(db, clientId, 0, MARKET_PAGE, allowed), { ads: [] as MarketAd[], more: false }),
    timed(
      timings,
      "saved",
      async () => {
        // This person's own: open ones, and ones someone else put in motion (until they dismiss the notice)
        if (!meId) return [];
        const { data } = await db
          .from("client_saved_references")
          .select(SAVED_COLS)
          .eq("client_id", clientId)
          .eq("saved_by", meId)
          .is("dismissed_at", null)
          .or(`used_at.is.null,used_by.neq.${meId}`)
          .order("created_at", { ascending: false })
          .limit(40);
        return (data ?? []).map((r) => toSaved(r as Record<string, unknown>)).filter((r) => fitsFormat(allowed, r.format));
      },
      [] as SavedRef[],
    ),
  ]);
  timings.total = Date.now() - t0;
  if (process.env.NODE_ENV !== "production") console.info("[request start]", clientId, JSON.stringify(timings));
  const label = industry ? ((c.industry_detail as string | null) ?? industryLabel(industry)) : null;
  const winnersTier = winners.length ? (Math.min(...winners.map((w) => w.match?.tier ?? 2)) as 1 | 2) : null;
  return {
    clientId,
    briefs,
    promises,
    patterns,
    winners,
    winnersLabel: industry ? industryLabel(industry) : null,
    winnersTier,
    detail: (c.industry_detail as string | null) ?? null,
    market: market.ads,
    marketMore: market.more,
    marketLabel: label,
    saved,
    timings,
  };
}

/** How many market ads a page brings: two rows on a wide screen, a good swipe on a phone */
export const MARKET_PAGE = 12;

/**
 * The client's market ads a page at a time, best matches first and brands taking turns (every brand's best ad, then
 * every brand's second), so the first screen isn't one brand. Falls back to the industry when nothing is matched yet.
 */
export async function marketPage(db: SupabaseClient, clientId: string, offset: number, count: number, allowed: ReadonlySet<CreativeFormat> = new Set(CREATIVE_FORMATS)): Promise<{ ads: MarketAd[]; more: boolean }> {
  const { loadClientMarket } = await import("@/lib/market");
  // Only the formats the person works in, before paging, so a page is never short of what they can see
  const all = (await loadClientMarket(db, clientId, { limit: 240 })).filter((a) => allowed.has(marketFormatOf(a)));
  const byBrand = new Map<string, MarketAd[]>();
  for (const a of all) byBrand.set(a.brand, [...(byBrand.get(a.brand) ?? []), a]);
  const turns: MarketAd[] = [];
  for (let round = 0; turns.length < all.length; round++) for (const list of byBrand.values()) if (list[round]) turns.push(list[round]);
  return { ads: turns.slice(offset, offset + count), more: turns.length > offset + count };
}
