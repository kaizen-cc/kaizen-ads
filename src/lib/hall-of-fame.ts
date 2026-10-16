import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adDetail, metaConfigured } from "@/lib/context/meta";
import { aggregate, pickType, type Day } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel, type Conversion } from "@/lib/kpi/conversions";
import { LIVE } from "@/lib/live";
import type { Benchmark } from "@/lib/verticals";

// The Hall of Fame: our ads that proved themselves. An ad qualifies when it ran 30+ days, spent $300+ with 5+ results,
// and its result over that run hit or beat the client's own KPI target (cost per result at or under it, or ROAS at or
// above it); clients without a target are held to their sub-vertical's researched "good" benchmark. It stays six months
// after it last qualified, with a saved copy of the creative, and the list updates after every Meta sync.

const DAY = 86_400_000;
const MIN_DAYS = 30;
const MIN_SPEND = 300;
const MIN_RESULTS = 5;
const KEEP_MS = 182 * DAY;

type Row = { date: string; ad_id: string; ad_name: string | null; campaign_name: string | null; metrics: Record<string, unknown> };

const num = (v: unknown) => Number(v) || 0;
const list = (v: unknown) => Object.fromEntries(((v ?? []) as { action_type: string; value: string }[]).map((a) => [a.action_type, num(a.value)]));

/** A sub-vertical's "result" in words → how to count it in Meta's numbers. */
function benchmarkConversion(words: string | null): Conversion | null {
  const w = (words ?? "").toLowerCase();
  if (/purchase|order|sale|checkout/.test(w)) return conversionFor("purchases");
  if (/book|reserv|appoint|schedul/.test(w)) return conversionFor("schedules");
  if (/applic/.test(w)) return conversionFor("applications");
  if (/lead|form|quote|inquir|sign/.test(w)) return { key: "lead", label: "Leads", types: ["offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "lead"], platforms: ["meta"] };
  return null;
}

/** Saves the ad's image (or the video's poster) to our storage, since Meta's links expire. */
async function keepImage(admin: SupabaseClient, adId: string, url: string | null) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!res.ok || !type.startsWith("image/")) return null;
    const path = `${adId}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
    const { error } = await admin.storage.from("hall-of-fame").upload(path, Buffer.from(await res.arrayBuffer()), { contentType: type, upsert: true });
    if (error) return null;
    return admin.storage.from("hall-of-fame").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Re-reads every live client's last 180 days of ads against their target and updates the Hall of Fame: new winners
 * added (with their creative saved), returning ones refreshed, and anything six months past its last qualifying
 * moment left to fall off.
 */
export async function updateHallOfFame(admin: SupabaseClient, deadline = Date.now() + 240_000) {
  const since = new Date(Date.now() - 180 * DAY).toISOString().slice(0, 10);
  const [{ data: clients }, { data: targets }, { data: subs }] = await Promise.all([
    admin.from("clients").select("id, name, vertical_id, meta_ad_account_id").is("archived_at", null).in("status", LIVE).not("meta_ad_account_id", "is", null),
    admin.from("kpi_targets").select("client_id, platform, conversion, custom_action, campaign_match, target").eq("active", true).eq("platform", "meta").not("target", "is", null),
    admin.from("verticals").select("id, conversion, benchmarks").not("parent_id", "is", null),
  ]);
  let checked = 0;
  let added = 0;
  let kept = 0;
  for (const c of clients ?? []) {
    if (Date.now() > deadline) break;
    // The yardstick: their own KPI target, else their sub-vertical's benchmark
    const t = (targets ?? []).find((x) => x.client_id === c.id);
    let conv: Conversion | null = null;
    let target: number | null = null;
    let source: "kpi" | "benchmark" = "kpi";
    let custom: string | null = null;
    let match: string | null = null;
    if (t) {
      conv = conversionFor(t.conversion);
      target = Number(t.target);
      custom = t.custom_action;
      match = t.campaign_match;
      if (conv.key === "conversions" || conv.key === "engagement" || conv.key === "link_clicks" || conv.key === "landing_page_views") conv = null; // not a business result
    }
    if (!conv) {
      const sub = (subs ?? []).find((s) => s.id === c.vertical_id);
      const bc = benchmarkConversion(sub?.conversion ?? null);
      const bm = ((sub?.benchmarks ?? []) as Benchmark[]).find((b) => (bc?.roas ? b.metric === "roas" : b.metric === "cost_per_result") && b.good != null);
      if (!bc || !bm) continue;
      conv = bc;
      target = Number(bm.good);
      source = "benchmark";
    }
    if (!conv || !target) continue;

    const rows: Row[] = [];
    for (let page = 0; page < 30; page++) {
      const { data } = await admin
        .from("meta_ad_daily")
        .select("date, ad_id, ad_name, campaign_name, metrics")
        .eq("client_id", c.id)
        .gte("date", since)
        .order("date")
        .range(page * 1000, page * 1000 + 999);
      rows.push(...((data ?? []) as Row[]));
      if (!data || data.length < 1000) break;
    }
    const byAd = new Map<string, Row[]>();
    for (const r of rows) {
      if (match && !(r.campaign_name ?? "").toLowerCase().includes(match.toLowerCase())) continue;
      byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
    }
    for (const [adId, adRows] of byAd) {
      const days: Day[] = adRows.map((r) => ({
        date: r.date,
        spend: num(r.metrics.spend),
        actions: list(r.metrics.actions),
        values: list(r.metrics.action_values),
        linkClicks: num(r.metrics.inline_link_clicks),
      }));
      const spent = days.filter((d) => d.spend > 0);
      if (spent.length < 2) continue;
      const first = spent[0].date;
      const last = spent[spent.length - 1].date;
      const live = Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1;
      if (live < MIN_DAYS) continue;
      checked++;
      const type = pickType(days, conv, custom);
      const agg = aggregate(days, conv, type);
      if (agg.value == null || agg.spend < MIN_SPEND) continue;
      if (!conv.roas && agg.results < MIN_RESULTS) continue;
      const roas = Boolean(conv.roas);
      const beat = roas ? (agg.value - target) / target : (target - agg.value) / target;
      if (beat < 0) continue;

      const now = new Date().toISOString();
      const { data: prev } = await admin.from("hall_of_fame").select("ad_id, creative").eq("ad_id", adId).maybeSingle();
      let creative = (prev?.creative ?? {}) as Record<string, unknown>;
      if (!prev && metaConfigured()) {
        // First time in: keep the creative as it runs
        const d = await adDetail(adId).catch(() => null);
        const still = d?.image ?? d?.video?.poster ?? null;
        creative = {
          headline: d?.headline ?? null,
          text: d?.text ?? null,
          cta: d?.cta ?? null,
          link: d?.link ?? null,
          page: d?.page?.name ?? null,
          image: await keepImage(admin, adId, still),
          video: d?.video?.source ?? null,
          preview: d?.preview ?? null,
        };
      }
      await admin.from("hall_of_fame").upsert(
        {
          ad_id: adId,
          client_id: c.id,
          vertical_id: c.vertical_id,
          ad_name: adRows[adRows.length - 1].ad_name,
          campaign_name: adRows[adRows.length - 1].campaign_name,
          first_date: first,
          last_date: last,
          days_live: live,
          spend: agg.spend,
          results: agg.results,
          value: agg.value,
          roas,
          conversion: conv.key === "lead" ? "Leads" : conversionLabel(conv.key, custom),
          target,
          target_source: source,
          beat_by: Math.round(beat * 1000) / 1000,
          creative,
          last_qualified_at: now,
          expires_at: new Date(Date.now() + KEEP_MS).toISOString(),
          updated_at: now,
          ...(prev ? {} : { qualified_at: now }),
        },
        { onConflict: "ad_id" },
      );
      if (prev) kept++;
      else added++;
    }
  }
  return { checked, added, kept };
}

export type FameAd = {
  adId: string;
  clientId: string;
  client: string;
  clientSlug: string;
  verticalId: string | null;
  vertical: string | null;
  parentVertical: string | null;
  adName: string | null;
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
  creative: { headline?: string | null; text?: string | null; cta?: string | null; link?: string | null; page?: string | null; image?: string | null; video?: string | null; preview?: string | null };
  qualifiedAt: string;
  stillRunning: boolean;
};

/** The Hall of Fame as it stands: everything within its six months, best first. */
export async function loadHallOfFame(db: SupabaseClient, opts: { verticalId?: string | null } = {}): Promise<FameAd[]> {
  let q = db
    .from("hall_of_fame")
    .select("*, clients(name, slug), verticals(name, verticals!verticals_parent_id_fkey(name))")
    .gt("expires_at", new Date().toISOString())
    .order("beat_by", { ascending: false })
    .limit(500);
  if (opts.verticalId) q = q.eq("vertical_id", opts.verticalId);
  const { data } = await q;
  const recent = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
  return (data ?? []).map((r) => {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    const v = r.verticals as unknown as { name: string; verticals: { name: string } | null } | null;
    return {
      adId: r.ad_id,
      clientId: r.client_id,
      client: c?.name ?? "",
      clientSlug: c?.slug ?? "",
      verticalId: r.vertical_id,
      vertical: v?.name ?? null,
      parentVertical: v?.verticals?.name ?? null,
      adName: r.ad_name,
      firstDate: r.first_date,
      lastDate: r.last_date,
      daysLive: r.days_live,
      spend: Number(r.spend),
      results: Number(r.results),
      value: Number(r.value),
      roas: r.roas,
      conversion: r.conversion,
      target: Number(r.target),
      targetSource: r.target_source,
      beatBy: Number(r.beat_by),
      creative: (r.creative ?? {}) as FameAd["creative"],
      qualifiedAt: r.qualified_at,
      stillRunning: r.last_date >= recent,
    };
  });
}
