import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadClientMarket, loadMarket, swipeFile, type MarketAd } from "@/lib/market";
import { motionConnected, MotionNotConnected, openSession } from "@/lib/motion";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { marketForTalk } from "@/lib/market-fit";
import { num, str, type AiTool } from "./types";

// Motion for the Kaizen AI chat and the "References from Motion" pickers: the market ads Motion's sync keeps
// (src/lib/market.ts), searched for a client or an industry, the client's swipe file, and Motion's own read-only
// tools over its MCP (creative reports, boards) when Motion is connected.

/** note: why the strategist brought it up in this conversation; media: what plays in its preview */
export type Reference = { id: string; brand: string; format: string | null; headline: string | null; hook: string | null; angle: string | null; why: string | null; days: number | null; proven: boolean; thumb: string | null; video: boolean; url: string; note?: string | null; media?: { type: "image" | "video"; url: string; thumb: string | null } | null };

export const toReference = (a: MarketAd): Reference => ({
  id: a.id,
  brand: a.brand,
  format: a.format,
  headline: a.headline,
  hook: a.hook,
  angle: a.angle,
  why: a.why,
  days: a.daysActive,
  proven: a.proven,
  thumb: a.media[0]?.thumb ?? (a.media[0]?.type === "image" ? a.media[0].url : null),
  video: a.media[0]?.type === "video" || /video/i.test(a.format ?? ""),
  url: a.motionUrl ?? a.libraryUrl ?? a.landingUrl ?? a.media[0]?.url ?? "",
  media: a.media[0] ?? null,
});

/** Words in a search, each matched against the ad's brand, copy, angle, hook and tags */
export function matchesSearch(a: Pick<MarketAd, "brand" | "headline" | "body" | "angle" | "hook" | "why" | "tags" | "format">, query: string | null) {
  if (!query) return true;
  const hay = [a.brand, a.headline, a.body, a.angle, a.hook, a.why, a.format, ...(a.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .every((w) => hay.includes(w));
}

/** Market ads for a client (comparable brands first) or an industry, filtered by words and format, proven first */
export async function searchMarketAds(db: SupabaseClient, opts: { clientId?: string | null; industry?: string | null; query?: string | null; format?: "image" | "video" | null; limit?: number }): Promise<Reference[]> {
  const pool = opts.clientId ? await loadClientMarket(db, opts.clientId, { limit: 400 }) : await loadMarket(db, { industry: opts.industry ?? null, limit: 400 });
  const want = (a: MarketAd) => !opts.format || (opts.format === "video" ? toReference(a).video : !toReference(a).video);
  const hits = pool.filter((a) => a.media.length && (a.country == null || a.country === "US") && want(a) && matchesSearch(a, opts.query ?? null));
  const score = (a: MarketAd) => (opts.clientId && a.competitorOf.includes(opts.clientId) ? 3 : 0) + (a.proven ? 2 : a.early ? 1 : 0) + (a.matchScore ?? 0) / 10 + Math.min(a.daysActive ?? 0, 120) / 120;
  return hits
    .sort((a, b) => score(b) - score(a))
    .slice(0, opts.limit ?? 24)
    .map(toReference)
    .filter((r) => r.url);
}

/**
 * Live market ads for a conversation about one client's brief: their own market only (competitors and their
 * sub-vertical, src/lib/market-fit.ts), the ones closest to what's being said first, US brands with a picture.
 */
export async function marketForClientTalk(db: SupabaseClient, clientId: string, text: string, n = 6): Promise<Reference[]> {
  const { data: c } = await db.from("clients").select("id, vertical_id, industry").eq("id", clientId).maybeSingle();
  if (!c) return [];
  const pool = (await loadClientMarket(db, clientId, { limit: 400 })).filter((a) => a.media.length && (a.country == null || a.country === "US"));
  return marketForTalk(pool, { id: c.id as string, verticalId: (c.vertical_id as string | null) ?? null, industry: (c.industry as string | null) ?? null }, text, n * 2)
    .map(toReference)
    .filter((r) => r.url)
    .slice(0, n);
}

const canSee = async (clientId: string) => Boolean((await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle()).data);

export const tools: AiTool[] = [
  {
    name: "search_market_ads",
    description: "Searches the market ads Motion keeps (US brands' live Meta ads, with how long each has run, its angle, hook and why it works). For a client, their comparable brands and competitors come first. Use to find references for a brief, a script or a shot list.",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        industry: { type: "string", description: "When there's no client: the industry to look in" },
        query: { type: "string", description: "Words to match (product, angle, hook, format)" },
        format: { type: "string", enum: ["image", "video"] },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
    run: async (_user, input) => {
      const clientId = str(input.client_id);
      if (clientId && !(await canSee(clientId))) return { ok: false, error: "Client not found." };
      const format = input.format === "image" || input.format === "video" ? input.format : null;
      const refs = await searchMarketAds(createAdminClient(), { clientId, industry: str(input.industry), query: str(input.query), format, limit: Math.min(40, num(input.limit) ?? 12) });
      return { ok: true, summary: `${refs.length} market ads`, data: refs };
    },
  },
  {
    name: "client_swipe_file",
    description: "A client's swipe file: the proven and early-winning US ads from their competitors and sub-vertical, the ones the strategist uses as references.",
    input_schema: { type: "object", properties: { client_id: { type: "string" }, max: { type: "integer", minimum: 1, maximum: 20 } }, required: ["client_id"], additionalProperties: false },
    run: async (_user, input) => {
      const clientId = str(input.client_id);
      if (!clientId || !(await canSee(clientId))) return { ok: false, error: "Client not found." };
      const ads = await swipeFile(createAdminClient(), clientId, Math.min(20, num(input.max) ?? 8));
      return { ok: true, summary: `${ads.length} ads`, data: ads.map(toReference) };
    },
  },
  {
    name: "motion_report",
    description: "Asks Motion directly through its own read-only tools (creative reports, boards, top ads by spend). Without `tool`, lists what Motion offers. Needs Motion connected in Settings.",
    input_schema: {
      type: "object",
      properties: { tool: { type: "string", description: "The Motion tool's name, from the list" }, arguments: { type: "object" } },
      additionalProperties: false,
    },
    run: async (_user, input) => {
      const admin = createAdminClient();
      if (!(await motionConnected(admin))) return { ok: false, error: new MotionNotConnected().message };
      try {
        const session = await openSession(admin);
        const name = str(input.tool);
        if (!name) {
          const list = await session.list();
          return { ok: true, summary: `${list.length} Motion tools`, data: list.map((t) => ({ name: t.name, description: t.description, arguments: Object.keys(t.inputSchema?.properties ?? {}) })) };
        }
        const args = input.arguments && typeof input.arguments === "object" ? (input.arguments as Record<string, unknown>) : {};
        const out = await session.call(name, args);
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return { ok: true, summary: `Motion ${name}`, data: text.length > 30_000 ? `${text.slice(0, 30_000)}…` : out };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Motion didn't answer." };
      }
    },
  },
];
