import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { totals, type InsightRow, type MetaAd } from "@/lib/context/meta";

// The fatigue watcher. After each Meta sync, every ad still spending is compared with its own previous three weeks:
// click-through falling, cost per result rising, people seeing it more often, and for video, fewer people stopping
// on the first seconds. The whole account's move over the same days is taken out, so a slow week for everyone
// doesn't flag every ad. "Tiring" is the early warning; "tired" is time to replace it.

export type FatigueSignals = {
  ctrNow: number;
  ctrBefore: number;
  ctrChange: number; // −0.3 = 30% lower
  cprNow: number | null;
  cprBefore: number | null;
  cprChange: number | null; // +0.4 = 40% more expensive
  accountCprChange: number | null; // the account's own move over the same days
  freqNow: number;
  freqBefore: number;
  hookNow: number | null;
  hookBefore: number | null;
  hookChange: number | null;
  spend7: number;
  results7: number;
  result: string | null;
  daysRunning: number;
};
export type FatigueRow = {
  clientId: string;
  adId: string;
  adName: string;
  campaign: string | null;
  adset: string | null;
  severity: "tiring" | "tired";
  signals: FatigueSignals;
  series: { d: string; spend: number; ctr: number; cpr: number | null }[];
};

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const change = (now: number | null, before: number | null) => (now == null || before == null || !before ? null : Math.round((now / before - 1) * 1000) / 1000);

/** The tiring ads in one account, from its daily rows. */
export function detect(clientId: string, rows: { date: string; ad_id: string; ad_name: string; campaign_name: string | null; adset_name: string | null; metrics: InsightRow }[]): FatigueRow[] {
  if (!rows.length) return [];
  const today = Date.now();
  const nowFrom = ymd(today - 7 * DAY);
  const beforeFrom = ymd(today - 28 * DAY);
  const inNow = (d: string) => d > nowFrom;
  const inBefore = (d: string) => d > beforeFrom && d <= nowFrom;
  const kind = totals(rows.map((r) => r.metrics)).result ?? undefined;
  const account = {
    now: totals(rows.filter((r) => inNow(r.date)).map((r) => r.metrics), kind),
    before: totals(rows.filter((r) => inBefore(r.date)).map((r) => r.metrics), kind),
  };
  const accountCprChange = change(account.now.costPerResult, account.before.costPerResult);

  const byAd = new Map<string, typeof rows>();
  for (const r of rows) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  const out: FatigueRow[] = [];
  for (const [adId, list] of byAd) {
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0].date;
    const daysRunning = Math.round((today - Date.parse(`${first}T12:00:00Z`)) / DAY);
    const now = totals(sorted.filter((r) => inNow(r.date)).map((r) => r.metrics), kind);
    const before = totals(sorted.filter((r) => inBefore(r.date)).map((r) => r.metrics), kind);
    // Enough behind it to judge: still spending, with a real stretch before to compare against
    if (daysRunning < 14 || now.spend < 50 || before.spend < 75 || !before.impressions || !now.impressions) continue;

    const ctrNow = now.linkCtr || now.ctr;
    const ctrBefore = before.linkCtr || before.ctr;
    const ctrChange = ctrBefore ? Math.round((ctrNow / ctrBefore - 1) * 1000) / 1000 : 0;
    const cprChange = now.results >= 2 && before.results >= 3 ? change(now.costPerResult, before.costPerResult) : null;
    const hookChange = change(now.hookRate, before.hookRate);
    // Cost rising faster than the account's own move (a slow week for everyone isn't this ad's fault)
    const cprRel = cprChange == null ? null : cprChange - Math.max(0, accountCprChange ?? 0);
    const noResultsNow = before.results >= 3 && now.results === 0 && now.spend >= Math.max(50, (before.costPerResult ?? 0) * 1.5);
    const freqUp = before.frequency ? now.frequency / before.frequency - 1 : 0;

    const tired = noResultsNow || (cprRel != null && cprRel >= 0.5) || (ctrChange <= -0.3 && cprRel != null && cprRel >= 0.25) || (ctrChange <= -0.4 && freqUp >= 0.15);
    const tiring = tired || (cprRel != null && cprRel >= 0.25) || ctrChange <= -0.25 || (hookChange != null && hookChange <= -0.25 && now.spend >= 100);
    if (!tiring) continue;

    const series = [...new Set(sorted.map((r) => r.date))]
      .filter((d) => d > beforeFrom)
      .map((d) => {
        const t = totals(sorted.filter((r) => r.date === d).map((r) => r.metrics), kind);
        return { d, spend: t.spend, ctr: t.linkCtr || t.ctr, cpr: t.costPerResult };
      });
    const latest = sorted[sorted.length - 1];
    out.push({
      clientId,
      adId,
      adName: latest.ad_name,
      campaign: latest.campaign_name,
      adset: latest.adset_name,
      severity: tired ? "tired" : "tiring",
      signals: {
        ctrNow,
        ctrBefore,
        ctrChange,
        cprNow: now.costPerResult,
        cprBefore: before.costPerResult,
        cprChange: noResultsNow ? null : cprChange,
        accountCprChange,
        freqNow: now.frequency,
        freqBefore: before.frequency,
        hookNow: now.hookRate,
        hookBefore: before.hookRate,
        hookChange,
        spend7: now.spend,
        results7: now.results,
        result: now.result ?? before.result,
        daysRunning,
      },
      series,
    });
  }
  return out;
}

/**
 * Watch every account with Meta data: flagged ads are saved (a dismissed one stays dismissed unless it gets worse),
 * and ads no longer flagged are marked recovered.
 */
export async function runFatigue(admin: SupabaseClient, clientIds?: string[]) {
  let q = admin.from("clients").select("id").eq("creative_package", true).is("archived_at", null).not("meta_ad_account_id", "is", null);
  if (clientIds?.length) q = q.in("id", clientIds);
  const { data: clients } = await q;
  const from = ymd(Date.now() - 29 * DAY);
  let flagged = 0;
  for (const c of clients ?? []) {
    const rows: Parameters<typeof detect>[1] = [];
    // Paged: busy accounts have thousands of ad-days in four weeks
    for (let page = 0; page < 20; page++) {
      const { data } = await admin
        .from("meta_ad_daily")
        .select("date, ad_id, ad_name, campaign_name, adset_name, metrics")
        .eq("client_id", c.id)
        .gte("date", from)
        .order("date")
        .range(page * 1000, page * 1000 + 999);
      rows.push(...((data ?? []) as typeof rows));
      if ((data ?? []).length < 1000) break;
    }
    const found = detect(c.id, rows);
    const [{ data: existing }, { data: snap }] = await Promise.all([
      admin.from("ad_fatigue").select("ad_id, state, severity").eq("client_id", c.id),
      admin.from("meta_snapshots").select("ads").eq("client_id", c.id).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const creative = new Map(((snap?.ads ?? []) as MetaAd[]).map((a) => [a.id, a]));
    const now = new Date().toISOString();
    const had = new Map((existing ?? []).map((e) => [e.ad_id, e]));
    if (found.length)
      await admin.from("ad_fatigue").upsert(
        found.map((f) => {
          const prev = had.get(f.adId);
          // A dismissed ad comes back only if it went from tiring to tired; recovered ones reopen
          const state = !prev || prev.state === "recovered" ? "open" : prev.state === "dismissed" && prev.severity === "tiring" && f.severity === "tired" ? "open" : prev.state;
          const ad = creative.get(f.adId);
          return {
            client_id: f.clientId,
            ad_id: f.adId,
            ad_name: f.adName,
            campaign: f.campaign,
            adset: f.adset,
            headline: ad?.headline ?? null,
            thumbnail: ad?.image ?? ad?.thumbnail ?? null,
            severity: f.severity,
            signals: f.signals,
            series: f.series,
            state,
            last_seen_at: now,
            updated_at: now,
            ...(!prev || prev.state === "recovered" ? { first_flagged_at: now } : {}),
          };
        }),
        { onConflict: "client_id,ad_id" },
      );
    const still = new Set(found.map((f) => f.adId));
    const gone = (existing ?? []).filter((e) => !still.has(e.ad_id) && e.state !== "recovered").map((e) => e.ad_id);
    if (gone.length) await admin.from("ad_fatigue").update({ state: "recovered", updated_at: now }).eq("client_id", c.id).in("ad_id", gone);
    flagged += found.length;
  }
  return { clients: clients?.length ?? 0, flagged };
}

/** The tiring ads in plain lines, for the AI (so a brief doesn't build on an ad that's wearing out). */
export function describeFatigue(rows: { ad_name: string; headline: string | null; severity: string; signals: FatigueSignals }[]) {
  if (!rows.length) return "";
  const p = (x: number | null) => (x == null ? null : `${Math.round(Math.abs(x) * 100)}%`);
  return rows
    .map((r) => {
      const s = r.signals;
      const bits = [
        s.ctrChange <= -0.1 && `CTR down ${p(s.ctrChange)}`,
        s.cprChange != null && s.cprChange >= 0.1 && `cost per ${s.result ?? "result"} up ${p(s.cprChange)}`,
        s.results7 === 0 && "no results this week",
        s.hookChange != null && s.hookChange <= -0.1 && `hook rate down ${p(s.hookChange)}`,
        `running ${s.daysRunning} days`,
      ].filter(Boolean);
      return `- ${r.severity === "tired" ? "TIRED" : "Tiring"}: "${r.headline ?? r.ad_name}" (${r.ad_name}): ${bits.join(", ")}`;
    })
    .join("\n");
}

export type WatchRow = {
  clientId: string;
  client: string;
  clientSlug: string;
  adId: string;
  adName: string;
  headline: string | null;
  thumbnail: string | null;
  severity: "tiring" | "tired";
  state: "open" | "refreshing";
  signals: FatigueSignals;
  series: { d: string; spend: number; ctr: number; cpr: number | null }[];
  firstFlaggedAt: string;
  requestNumbers: number[];
};

/** The watch list: open and being-refreshed ads, worst first. buyer: only the clients that buyer runs. */
export async function loadWatchList(db: SupabaseClient, opts: { clientId?: string; buyerId?: string; limit?: number } = {}): Promise<WatchRow[]> {
  let ids: string[] | null = opts.clientId ? [opts.clientId] : null;
  if (opts.buyerId) {
    const [{ data: owned }, { data: assigned }] = await Promise.all([
      db.from("kpi_targets").select("client_id").eq("owner_id", opts.buyerId).eq("active", true),
      db.from("client_assignments").select("client_id").eq("profile_id", opts.buyerId).eq("role", "meta_buyer"),
    ]);
    ids = [...new Set([...(owned ?? []), ...(assigned ?? [])].map((r) => r.client_id as string))];
    if (!ids.length) return [];
  }
  let q = db
    .from("ad_fatigue")
    .select("client_id, ad_id, ad_name, headline, thumbnail, severity, state, signals, series, first_flagged_at, request_numbers, clients(name, slug)")
    .in("state", ["open", "refreshing"]);
  if (ids) q = q.in("client_id", ids);
  const { data } = await q.limit(200);
  return (data ?? [])
    .map((r) => {
      const c = r.clients as unknown as { name: string; slug: string } | null;
      return {
        clientId: r.client_id,
        client: c?.name ?? "",
        clientSlug: c?.slug ?? "",
        adId: r.ad_id,
        adName: r.ad_name,
        headline: r.headline,
        thumbnail: r.thumbnail,
        severity: r.severity as WatchRow["severity"],
        state: r.state as WatchRow["state"],
        signals: r.signals as FatigueSignals,
        series: (r.series ?? []) as WatchRow["series"],
        firstFlaggedAt: r.first_flagged_at,
        requestNumbers: (r.request_numbers ?? []) as number[],
      };
    })
    .sort((a, b) => Number(a.state === "refreshing") - Number(b.state === "refreshing") || Number(b.severity === "tired") - Number(a.severity === "tired") || b.signals.spend7 - a.signals.spend7)
    .slice(0, opts.limit ?? 50);
}
