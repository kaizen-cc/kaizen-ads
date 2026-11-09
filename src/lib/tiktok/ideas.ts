import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { nyParts } from "@/lib/kpi/calc";
import { activeAds, fameWinners, hookOf, isActiveStatus, liveWinners, yardstickFor, type Judged, type TikTokAdDay, type Yardstick } from "./winners";

// Ads Lab's TikTok side: the Hall of Fame and live winners from our own clients' TikTok ads (TikTok has no public ad
// library API for US ads, so nothing from outside). Worked out on read from tiktok_ad_daily (the rules are in
// ./winners.ts), so there's nothing to keep in step: a new sync is reflected the next time the page opens.

const DAY = 86_400_000;
/** How far back an ad's days are read: its whole run, and the six months it's kept after */
const LOOKBACK_DAYS = 365;

export type TikTokIdea = {
  adId: string;
  clientId: string;
  client: string;
  clientSlug: string;
  verticalId: string | null;
  vertical: string | null;
  parentVertical: string | null;
  adName: string | null;
  campaign: string | null;
  text: string | null;
  hook: string | null;
  cta: string | null;
  link: string | null;
  thumbnail: string | null;
  format: "video" | "image";
  firstDate: string;
  lastDate: string;
  daysLive: number;
  spend: number;
  results: number;
  value: number;
  roas: boolean;
  conversion: string;
  target: number;
  targetSource: "kpi" | "benchmark";
  beatBy: number;
  /** TikTok's 6-second views over impressions, as a percent */
  sixSecRate: number | null;
  ctr: number | null;
  /** Spending and switched on in the last 3 days */
  stillRunning: boolean;
};

/** Whether there's any TikTok ad data at all (the TikTok option shows only then); false before the migration too */
export async function hasTikTokData(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from("tiktok_ad_daily").select("ad_id").limit(1);
  return !error && Boolean(data?.length);
}

type ClientRow = { id: string; name: string; slug: string; vertical_id: string | null };

/** Every day of an advertiser's ads since a date, a page at a time */
async function adDays(db: SupabaseClient, accounts: string[], since: string) {
  const rows: (TikTokAdDay & { ad_account_id: string })[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db
      .from("tiktok_ad_daily")
      .select("ad_account_id, ad_id, date, ad_name, campaign_name, spend, impressions, clicks, conversions, conversion_value, purchases, video_2s, video_6s")
      .in("ad_account_id", accounts)
      .gte("date", since)
      .order("date")
      .order("ad_id")
      .range(page * 1000, page * 1000 + 999);
    if (error) break;
    rows.push(...((data ?? []) as (TikTokAdDay & { ad_account_id: string })[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/**
 * The TikTok Hall of Fame ("fame") or live winners ("live") across every live client with a linked TikTok account,
 * each judged against its own TikTok KPI target (or its sub-vertical's benchmark). Best first.
 */
export async function loadTikTokIdeas(db: SupabaseClient, mode: "fame" | "live", opts: { clientIds?: string[] } = {}): Promise<TikTokIdea[]> {
  const today = nyParts(new Date()).date;
  let advQ = db.from("tiktok_advertisers").select("advertiser_id, client_id, clients!inner(id, name, slug, vertical_id, status, archived_at)").not("client_id", "is", null).is("clients.archived_at", null).in("clients.status", LIVE);
  if (opts.clientIds) advQ = advQ.in("client_id", opts.clientIds);
  const { data: advs, error } = await advQ;
  if (error || !advs?.length) return [];
  const clients = new Map<string, { c: ClientRow; accounts: string[] }>();
  for (const a of advs) {
    const c = a.clients as unknown as ClientRow;
    const e = clients.get(c.id) ?? { c, accounts: [] };
    e.accounts.push(String(a.advertiser_id));
    clients.set(c.id, e);
  }
  const ids = [...clients.keys()];
  const [{ data: targets }, { data: subs }] = await Promise.all([
    db.from("kpi_targets").select("client_id, ad_account_id, conversion, campaign_match, target").eq("active", true).eq("platform", "tiktok").in("client_id", ids).not("target", "is", null),
    db.from("verticals").select("id, name, parent_id, conversion, benchmarks").not("parent_id", "is", null),
  ]);
  const since = new Date(Date.parse(today) - (mode === "live" ? 20 : LOOKBACK_DAYS) * DAY).toISOString().slice(0, 10);

  const found: { j: Judged; y: Yardstick; c: ClientRow; account: string }[] = [];
  for (const { c, accounts } of clients.values()) {
    const sub = (subs ?? []).find((s) => s.id === c.vertical_id) as { conversion: string | null; benchmarks: { metric: string; good?: number | null }[] | null } | undefined;
    const mine = (targets ?? []).filter((t) => t.client_id === c.id);
    const days = await adDays(db, accounts, since);
    // Each account against its own card when it has one, else the client's first
    for (const account of accounts) {
      const t = mine.find((x) => x.ad_account_id === account) ?? mine.find((x) => !x.ad_account_id) ?? mine[0] ?? null;
      const y = yardstickFor(t, sub);
      if (!y) continue;
      const own = days.filter((d) => d.ad_account_id === account);
      if (!own.length) continue;
      if (mode === "fame") {
        for (const j of fameWinners(own, y, today)) found.push({ j, y, c, account });
      } else {
        const ids = [...new Set(own.filter((d) => d.date >= new Date(Date.parse(today) - 2 * DAY).toISOString().slice(0, 10)).map((d) => String(d.ad_id)))];
        const { data: st } = ids.length ? await db.from("tiktok_ads").select("ad_id, status").in("ad_id", ids) : { data: [] };
        const active = activeAds((st ?? []) as { ad_id: string; status: string | null }[], own, today);
        for (const j of liveWinners(own, y, active, today)) found.push({ j, y, c, account });
      }
    }
  }
  if (!found.length) return [];

  // The ads as they stand (text, call to action, link, thumbnail) and whether each is still running
  const adIds = [...new Set(found.map((f) => f.j.adId))];
  const ads: { ad_id: string; ad_name: string | null; status: string | null; ad_text: string | null; call_to_action: string | null; landing_page_url: string | null; thumbnail_url: string | null; video_id: string | null }[] = [];
  for (let i = 0; i < adIds.length; i += 200) {
    const { data } = await db.from("tiktok_ads").select("ad_id, ad_name, status, ad_text, call_to_action, landing_page_url, thumbnail_url, video_id").in("ad_id", adIds.slice(i, i + 200));
    ads.push(...((data ?? []) as typeof ads));
  }
  const parentIds = (subs ?? []).map((s) => s.parent_id as string | null);
  const parentName = new Map((subs ?? []).map((s) => [s.id as string, s.name as string]));
  const { parentNames } = await import("@/lib/verticals");
  const parents = await parentNames(db, parentIds);
  const recent = new Date(Date.parse(today) - 3 * DAY).toISOString().slice(0, 10);
  return found
    .map(({ j, y, c }) => {
      const a = ads.find((x) => x.ad_id === j.adId);
      const sub = (subs ?? []).find((s) => s.id === c.vertical_id);
      const text = a?.ad_text ?? null;
      return {
        adId: j.adId,
        clientId: c.id,
        client: c.name,
        clientSlug: c.slug,
        verticalId: c.vertical_id,
        vertical: (c.vertical_id && parentName.get(c.vertical_id)) || null,
        parentVertical: (sub?.parent_id && parents.get(sub.parent_id as string)) || null,
        adName: a?.ad_name ?? j.adName,
        campaign: j.campaign,
        text,
        hook: hookOf(text),
        cta: a?.call_to_action ?? null,
        link: a?.landing_page_url ?? null,
        thumbnail: a?.thumbnail_url ?? null,
        format: a && !a.video_id ? ("image" as const) : ("video" as const),
        firstDate: j.firstDate,
        lastDate: j.lastDate,
        daysLive: j.daysLive,
        spend: j.spend,
        results: j.results,
        value: j.value,
        roas: y.kind === "roas",
        conversion: y.label,
        target: y.target,
        targetSource: y.source,
        beatBy: j.beatBy,
        sixSecRate: j.sixSecRate,
        ctr: j.ctr,
        stillRunning: mode === "live" || (j.lastDate >= recent && (a?.status == null || isActiveStatus(a.status))),
      } satisfies TikTokIdea;
    })
    .sort((a, b) => b.beatBy - a.beatBy)
    .slice(0, 500);
}
