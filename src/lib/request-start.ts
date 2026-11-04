import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { industryLabel, industryWinners, type Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { SuggestionDraft } from "@/lib/suggestions";

// Everything the "How do you want to start?" page shows for a client, in one go, from what's already stored: the briefs
// the strategist writes every day (ads tiring, numbers off, moments, patterns), promises from calls, what's proven for
// similar clients, and the market ads Motion keeps. No AI at all here: adapting one to the client happens when it's picked.

export type StartBrief = { id: string; kind: string; signal: string; why: string; title: string; angle: string; thumb: string | null; formats: string; createdAt: string };
export type StartPromise = { id: string; kind: string; what: string; callTitle: string; callAt: string; internal: boolean; briefed: boolean };
export type StartPattern = { id: string; title: string; detail: string; group: string; kind: string; clients: number; of: number; confidence: string; uses: boolean };
export type StartData = {
  clientId: string;
  briefs: StartBrief[];
  promises: StartPromise[];
  patterns: StartPattern[];
  winners: Winner[];
  winnersLabel: string | null;
  market: MarketAd[];
  marketLabel: string | null;
  /** How long each read took (ms), for the dev log */
  timings?: Record<string, number>;
};

const FMT_WORD = { image: "image", video: "video", carousel: "carousel" } as const;
const formatsLine = (d: SuggestionDraft) => (d.formats ?? []).map((f) => `${f.new + f.variations} ${FMT_WORD[f.format]}${f.new + f.variations === 1 ? "" : "s"}`).join(" + ");

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

/** The start page's sections for one client, read in parallel with the person's own access (db is their client) */
export async function startSections(db: SupabaseClient, clientId: string): Promise<StartData> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const { data: c } = await db.from("clients").select("id, industry, industry_detail").eq("id", clientId).maybeSingle();
  timings.client = Date.now() - t0;
  const industry = c?.industry && c.industry !== "other" ? (c.industry as string) : null;
  if (!c) return { clientId, briefs: [], promises: [], patterns: [], winners: [], winnersLabel: null, market: [], marketLabel: null, timings };

  const [briefs, promises, patterns, winners, market] = await Promise.all([
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
          .limit(12);
        return (data ?? []).map((r) => {
          const d = r.draft as SuggestionDraft | null;
          const src = r.source as { thumbnail?: string | null } | null;
          return { id: r.id as string, kind: r.kind as string, signal: r.signal as string, why: r.why as string, title: d?.title ?? "", angle: d?.angle ?? "", thumb: src?.thumbnail ?? null, formats: d ? formatsLine(d) : "", createdAt: r.created_at as string };
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
          .select("id, kind, what, status, suggestion_id, client_calls(title, occurred_at, status)")
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
    timed(timings, "winners", async () => (industry ? industryWinners(db, industry, clientId, 6) : []), [] as Winner[]),
    timed(
      timings,
      "market",
      async () => {
        if (!industry) return [];
        const { loadClientMarket } = await import("@/lib/market");
        const all = await loadClientMarket(db, clientId, { limit: 60 });
        // One per brand, best matches first
        const seen = new Set<string>();
        return all.filter((a) => (seen.has(a.brand) ? false : (seen.add(a.brand), true))).slice(0, 8);
      },
      [] as MarketAd[],
    ),
  ]);
  timings.total = Date.now() - t0;
  if (process.env.NODE_ENV !== "production") console.info("[request start]", clientId, JSON.stringify(timings));
  const label = industry ? ((c.industry_detail as string | null) ?? industryLabel(industry)) : null;
  return { clientId, briefs, promises, patterns, winners, winnersLabel: industry ? industryLabel(industry) : null, market, marketLabel: label, timings };
}
