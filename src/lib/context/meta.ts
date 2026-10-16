import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact } from "./shared";
import { isLive, LIVE } from "@/lib/live";

// Reads ad performance with the CommandCenter system user (META_SYSTEM_USER_TOKEN, ads_read).
// Every metric is pulled per ad per day through Meta's async report jobs, which handle heavy fields
// like reach that time out on a normal request. If the Meta app requires it, META_APP_SECRET adds appsecret_proof.

const VERSION = process.env.META_API_VERSION || "v24.0";
export const metaConfigured = () => Boolean(process.env.META_SYSTEM_USER_TOKEN);

const proof = (): Record<string, string> => {
  const token = process.env.META_SYSTEM_USER_TOKEN!;
  return process.env.META_APP_SECRET ? { appsecret_proof: createHmac("sha256", process.env.META_APP_SECRET).update(token).digest("hex") } : {};
};

async function graph<T>(path: string, params: Record<string, string> = {}, method: "GET" | "POST" = "GET"): Promise<T> {
  const query = new URLSearchParams({ ...params, ...proof(), access_token: process.env.META_SYSTEM_USER_TOKEN! });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://graph.facebook.com/${VERSION}/${path}${method === "GET" ? `?${query}` : ""}`, {
      method,
      ...(method === "POST" ? { body: query } : {}),
      cache: "no-store",
    });
    const body = (await res.json()) as T & { error?: { message: string; code: number } };
    // 1, 2: Meta busy for a moment; 4, 17, 32, 613: rate limits. Wait a little and try again
    const notReady = body.error?.message?.includes("not completed yet");
    if (body.error && ([1, 2, 4, 17, 32, 613].includes(body.error.code) || notReady) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (body.error) throw new Error(`Meta (${path.split("/").pop() || "ads"}): ${body.error.message}`);
    return body;
  }
  throw new Error("Meta: rate limited");
}

type Action = { action_type: string; value: string };
export type InsightRow = Record<string, unknown> & {
  date_start: string;
  date_stop: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
};

/**
 * Meta's async report: submit, wait for it to finish in the background, then read every page.
 * This is how Meta wants heavy reports (reach, many days, ad level) requested.
 */
export async function asyncReport(act: string, params: Record<string, string>, timeoutMs = 240_000): Promise<InsightRow[]> {
  const { report_run_id: id } = await graph<{ report_run_id: string }>(`${act}/insights`, params, "POST");
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await graph<{ async_status: string; async_percent_completion: number }>(id, { fields: "async_status,async_percent_completion" });
    // Meta can say "completed" a moment before the results are readable
    if (job.async_status === "Job Completed" && job.async_percent_completion === 100) break;
    if (job.async_status === "Job Failed" || job.async_status === "Job Skipped") throw new Error(`Meta report ${job.async_status.toLowerCase()}`);
    if (Date.now() > until) throw new Error("Meta report took too long");
    await new Promise((r) => setTimeout(r, 2500));
  }
  const rows: InsightRow[] = [];
  let after = "";
  do {
    const page = await graph<{ data: InsightRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${id}/insights`, { limit: "500", ...(after ? { after } : {}) });
    rows.push(...page.data);
    after = page.paging?.next ? (page.paging.cursors?.after ?? "") : "";
  } while (after);
  return rows;
}

// Everything a KPI dashboard and the AI could want, per ad per day
const DAILY_FIELDS = [
  "account_id",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "objective",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "outbound_clicks",
  "ctr",
  "inline_link_click_ctr",
  "cpc",
  "cpm",
  "actions",
  "action_values",
  "cost_per_action_type",
  "purchase_roas",
  "website_purchase_roas",
  "video_play_actions",
  "video_thruplay_watched_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p100_watched_actions",
  "video_avg_time_watched_actions",
  "quality_ranking",
  "engagement_rate_ranking",
  "conversion_rate_ranking",
].join(",");

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ─── Totals from daily rows ─────────────────────────────────────────────────

const n = (v: unknown) => (v == null || v === "" ? 0 : Number(v));
const sumActions = (rows: InsightRow[], key: string) => {
  const out = new Map<string, number>();
  for (const r of rows) for (const a of (r[key] as Action[] | undefined) ?? []) out.set(a.action_type, (out.get(a.action_type) ?? 0) + Number(a.value));
  return out;
};
const firstOf = (m: Map<string, number>, types: string[]) => types.map((t) => m.get(t)).find((v) => v != null && v > 0) ?? 0;

// The result a client is buying, in order of what usually matters most
const RESULTS: [string, string[]][] = [
  ["purchase", ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]],
  ["lead", ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]],
  ["registration", ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"]],
  ["link click", ["link_click"]],
];
const PURCHASE = RESULTS[0][1];
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function totals(rows: InsightRow[], resultKind?: string) {
  const spend = rows.reduce((s, r) => s + n(r.spend), 0);
  const impressions = rows.reduce((s, r) => s + n(r.impressions), 0);
  const clicks = rows.reduce((s, r) => s + n(r.clicks), 0);
  const linkClicks = rows.reduce((s, r) => s + n(r.inline_link_clicks), 0);
  const actions = sumActions(rows, "actions");
  const values = sumActions(rows, "action_values");
  const outbound = sumActions(rows, "outbound_clicks");
  const thruplays = sumActions(rows, "video_thruplay_watched_actions");
  const p100 = sumActions(rows, "video_p100_watched_actions");

  const kind = resultKind ?? RESULTS.find(([, types]) => firstOf(actions, types) > 0)?.[0] ?? null;
  const results = kind ? firstOf(actions, RESULTS.find(([k]) => k === kind)![1]) : 0;
  const purchaseValue = firstOf(values, PURCHASE);
  const views3s = actions.get("video_view") ?? 0;
  return {
    spend: round(spend),
    impressions,
    // Summed daily reach overcounts people; real window reach comes from meta_reach. Frequency here is daily-weighted.
    frequency: round(rows.reduce((s, r) => s + n(r.impressions), 0) / Math.max(1, rows.reduce((s, r) => s + n(r.reach), 0)) || 0),
    clicks,
    linkClicks,
    outboundClicks: [...outbound.values()].reduce((a, b) => a + b, 0),
    ctr: impressions ? round((clicks / impressions) * 100) : 0,
    linkCtr: impressions ? round((linkClicks / impressions) * 100) : 0,
    cpc: linkClicks ? round(spend / linkClicks) : null,
    cpm: impressions ? round((spend / impressions) * 1000) : 0,
    result: kind,
    results,
    costPerResult: results ? round(spend / results) : null,
    purchases: firstOf(actions, PURCHASE),
    purchaseValue: round(purchaseValue),
    roas: spend && purchaseValue ? round(purchaseValue / spend) : null,
    leads: firstOf(actions, RESULTS[1][1]),
    addToCart: firstOf(actions, ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]),
    landingPageViews: firstOf(actions, ["landing_page_view", "omni_landing_page_view"]),
    videoViews3s: views3s,
    hookRate: impressions && views3s ? round((views3s / impressions) * 100) : null, // 3-second views per impression
    holdRate: views3s ? round(([...thruplays.values()].reduce((a, b) => a + b, 0) / views3s) * 100) : null, // ThruPlays per 3-second view
    completionRate: views3s ? round(([...p100.values()].reduce((a, b) => a + b, 0) / views3s) * 100) : null,
  };
}

export type MetaSummary = ReturnType<typeof totals> & { reach?: number | null };
export type MetaAd = MetaSummary & {
  id: string;
  name: string;
  campaign: string;
  adset: string;
  headline: string | null;
  text: string | null;
  thumbnail: string | null;
  image?: string | null; // the full image, for image ads
  live?: boolean; // delivering now (effective status ACTIVE)
  rankings: { quality: string | null; engagement: string | null; conversion: string | null };
};

// ─── Sync one ad account ────────────────────────────────────────────────────

/** Daily rows since the last sync (90 days the first time, then the last 3 days, which Meta keeps revising). */
async function syncDaily(admin: SupabaseClient, clientId: string, adAccountId: string) {
  const act = `act_${adAccountId}`;
  const { data: last } = await admin.from("meta_ad_daily").select("date").eq("client_id", clientId).order("date", { ascending: false }).limit(1).maybeSingle();
  const today = new Date();
  const since = last ? new Date(new Date(last.date).getTime() - 3 * 86_400_000) : new Date(today.getTime() - 90 * 86_400_000);
  const rows = await asyncReport(act, {
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since: ymd(since), until: ymd(today) }),
    fields: DAILY_FIELDS,
  });
  const records = rows
    .filter((r) => r.ad_id)
    .map((r) => ({
      client_id: clientId,
      ad_account_id: adAccountId,
      date: r.date_start,
      ad_id: r.ad_id!,
      ad_name: r.ad_name ?? null,
      adset_id: r.adset_id ?? null,
      adset_name: r.adset_name ?? null,
      campaign_id: r.campaign_id ?? null,
      campaign_name: r.campaign_name ?? null,
      metrics: r,
      updated_at: new Date().toISOString(),
    }));
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await admin.from("meta_ad_daily").upsert(records.slice(i, i + 500), { onConflict: "ad_id,date" });
    if (error) throw new Error(`Saving Meta days: ${error.message}`);
  }
  return { days: new Set(records.map((r) => r.date)).size, rows: records.length, from: ymd(since) };
}

/** Unique people over the last 7 and 30 days, for the account and each campaign. */
async function syncReach(admin: SupabaseClient, clientId: string, adAccountId: string) {
  const act = `act_${adAccountId}`;
  const out: Record<string, unknown>[] = [];
  for (const days of [7, 30]) {
    for (const level of ["account", "campaign"] as const) {
      const rows = await asyncReport(act, {
        level,
        date_preset: days === 7 ? "last_7d" : "last_30d",
        fields: level === "account" ? "account_id,account_name,reach,frequency,impressions" : "campaign_id,campaign_name,reach,frequency,impressions",
      });
      for (const r of rows)
        out.push({
          client_id: clientId,
          ad_account_id: adAccountId,
          level,
          object_id: level === "account" ? `act_${adAccountId}` : String(r.campaign_id),
          object_name: (level === "account" ? r.account_name : r.campaign_name) ?? null,
          window_days: days,
          date_start: r.date_start,
          date_stop: r.date_stop,
          reach: n(r.reach),
          frequency: n(r.frequency),
          impressions: n(r.impressions),
          updated_at: new Date().toISOString(),
        });
    }
  }
  if (out.length) {
    const { error } = await admin.from("meta_reach").upsert(out, { onConflict: "object_id,window_days" });
    if (error) throw new Error(`Saving reach: ${error.message}`);
  }
  return out.length;
}

/** What the AI reads: last 30 days totals with real reach, week by week, and the top ads with their creative. */
async function snapshot(admin: SupabaseClient, clientId: string, adAccountId: string) {
  const from = ymd(new Date(Date.now() - 30 * 86_400_000));
  const [{ data: days }, { data: reach }] = await Promise.all([
    admin.from("meta_ad_daily").select("date, ad_id, ad_name, adset_name, campaign_name, metrics").eq("client_id", clientId).gte("date", from),
    admin.from("meta_reach").select("window_days, reach, frequency").eq("client_id", clientId).eq("level", "account"),
  ]);
  const rows = (days ?? []).map((d) => d.metrics as InsightRow);
  if (!rows.length) return null;
  const r30 = reach?.find((x) => x.window_days === 30);
  const summary: MetaSummary = { ...totals(rows), reach: r30?.reach ?? null, frequency: r30?.frequency != null ? round(Number(r30.frequency)) : totals(rows).frequency };
  const kind = summary.result ?? undefined;

  // Week by week (4 weeks back from today)
  const weekly = [3, 2, 1, 0].map((w) => {
    const start = ymd(new Date(Date.now() - (w + 1) * 7 * 86_400_000));
    const end = ymd(new Date(Date.now() - w * 7 * 86_400_000));
    return { from: start, to: end, ...totals(rows.filter((r) => r.date_start > start && r.date_start <= end), kind) };
  });

  // Top ads by spend, with the creative behind them
  const byAd = new Map<string, InsightRow[]>();
  for (const d of days ?? []) byAd.set(d.ad_id, [...(byAd.get(d.ad_id) ?? []), d.metrics as InsightRow]);
  const top = [...byAd]
    .map(([id, list]) => ({ id, list, t: totals(list, kind) }))
    .sort((a, b) => b.t.spend - a.t.spend)
    .slice(0, 20);
  // Copy lives in different places by ad type: plain fields, link/video ads, dynamic (asset feed) ads, boosted posts
  type Creative = {
    title?: string;
    body?: string;
    thumbnail_url?: string;
    object_story_spec?: { link_data?: { name?: string; message?: string }; video_data?: { title?: string; message?: string } };
    asset_feed_spec?: { titles?: { text: string }[]; bodies?: { text: string }[] };
    effective_object_story_id?: string;
  };
  // One request per ad, so one ad Meta won't describe can't blank the others. A big thumbnail (the default is 64px),
  // the full image for image ads, and whether the ad is delivering now.
  const creatives: Record<string, { creative?: Creative & { image_url?: string }; effective_status?: string }> = {};
  const fields =
    "effective_status,creative.thumbnail_width(600).thumbnail_height(600){title,body,thumbnail_url,image_url,object_story_spec,asset_feed_spec,effective_object_story_id}";
  const looked = await Promise.allSettled(top.slice(0, 15).map((a) => graph<{ creative?: Creative & { image_url?: string }; effective_status?: string }>(a.id, { fields })));
  looked.forEach((r, i) => {
    if (r.status === "fulfilled") creatives[top[i].id] = r.value;
  });
  const failed = looked.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) console.error(`[meta] ${failed.length} of ${looked.length} ad creatives couldn't be read:`, failed[0].reason instanceof Error ? failed[0].reason.message : failed[0].reason);
  // Boosted posts keep their text on the post itself
  const posts = Object.values(creatives)
    .map((c) => c.creative)
    .filter((c): c is Creative => Boolean(c && !c.body && !c.object_story_spec?.link_data?.message && !c.object_story_spec?.video_data?.message && !c.asset_feed_spec?.bodies?.length && c.effective_object_story_id))
    .map((c) => c.effective_object_story_id!);
  let postText: Record<string, { message?: string }> = {};
  try {
    if (posts.length) postText = await graph("", { ids: posts.join(","), fields: "message" });
  } catch {
    postText = {}; // needs page access; the numbers still save without it
  }
  const copyOf = (c?: Creative) => ({
    headline: c?.title ?? c?.object_story_spec?.link_data?.name ?? c?.object_story_spec?.video_data?.title ?? c?.asset_feed_spec?.titles?.[0]?.text ?? null,
    text:
      c?.body ??
      c?.object_story_spec?.link_data?.message ??
      c?.object_story_spec?.video_data?.message ??
      c?.asset_feed_spec?.bodies?.[0]?.text ??
      (c?.effective_object_story_id ? postText[c.effective_object_story_id]?.message : undefined) ??
      null,
  });
  const ranking = (list: InsightRow[], key: string) =>
    (list
      .slice()
      .sort((a, b) => b.date_start.localeCompare(a.date_start))
      .map((r) => r[key] as string | undefined)
      .find((v) => v && v !== "UNKNOWN") as string | undefined) ?? null;
  const ads: MetaAd[] = top.map(({ id, list, t }) => {
    const c = creatives[id]?.creative;
    const latest = list[list.length - 1];
    return {
      ...t,
      id,
      name: String(latest.ad_name ?? ""),
      campaign: String(latest.campaign_name ?? ""),
      adset: String(latest.adset_name ?? ""),
      headline: copyOf(c).headline,
      text: copyOf(c).text?.slice(0, 2000) ?? null,
      thumbnail: c?.thumbnail_url ?? null,
      image: c?.image_url ?? null,
      live: creatives[id] ? creatives[id].effective_status === "ACTIVE" : undefined,
      rankings: { quality: ranking(list, "quality_ranking"), engagement: ranking(list, "engagement_rate_ranking"), conversion: ranking(list, "conversion_rate_ranking") },
    };
  });

  const { error } = await admin.from("meta_snapshots").insert({
    client_id: clientId,
    ad_account_id: adAccountId,
    date_start: from,
    date_stop: ymd(new Date()),
    summary,
    weekly,
    ads,
  });
  if (error) throw new Error(`Saving snapshot: ${error.message}`);
  return true;
}

/**
 * Every ad account the system user can see, and link clients without one to theirs by name (all current clients,
 * not only creative ones). The list is saved so the KPI page can show accounts Meta shares that no client has yet.
 */
export async function linkAdAccounts(admin: SupabaseClient) {
  const accounts: { id: string; account_id: string; name: string; account_status: number }[] = [];
  let after = "";
  do {
    const page = await graph<{ data: typeof accounts; paging?: { cursors?: { after?: string }; next?: string } }>("me/adaccounts", {
      fields: "account_id,name,account_status",
      limit: "200",
      ...(after ? { after } : {}),
    });
    accounts.push(...page.data);
    after = page.paging?.next ? (page.paging.cursors?.after ?? "") : "";
  } while (after);

  const { data: all } = await admin.from("clients").select("id, name, meta_ad_account_id, creative_package, status, archived_at");
  // Every client's account is taken, archived ones too (it isn't free to link to someone else)
  const taken = new Set((all ?? []).map((c) => c.meta_ad_account_id).filter(Boolean));
  const clients = (all ?? []).filter((c) => isLive(c));
  const linked: string[] = [];
  for (const c of clients) {
    if (c.meta_ad_account_id) continue;
    const key = compact(c.name);
    const hits = accounts.filter((a) => {
      if (taken.has(a.account_id) || a.account_status !== 1) return false;
      const nm = compact(a.name);
      return key.length >= 4 && (nm.includes(key) || key.includes(nm));
    });
    // Only a single clear match; anything ambiguous waits for someone to pick on the KPI page
    if (hits.length === 1) {
      await admin.from("clients").update({ meta_ad_account_id: hits[0].account_id }).eq("id", c.id);
      c.meta_ad_account_id = hits[0].account_id;
      taken.add(hits[0].account_id);
      linked.push(`${c.name} → ${hits[0].name}`);
    }
  }
  const unlinked = accounts.filter((a) => !taken.has(a.account_id) && a.account_status === 1).map((a) => ({ id: a.account_id, name: a.name }));
  await admin.from("sync_state").upsert({ source: "meta:accounts", last_run_at: new Date().toISOString(), last_result: { total: accounts.length, unlinked } });
  return {
    accounts: accounts.map((a) => `${a.name} (${a.account_id})${a.account_status === 1 ? "" : " · not active"}`),
    linked,
    unlinked,
    creativeClientsWithoutAccount: (clients ?? []).filter((c) => c.creative_package && !c.meta_ad_account_id).map((c) => c.name),
  };
}

/** One client, on demand (the client page's Sync now): daily metrics, reach, and the AI snapshot. */
export async function syncClientMeta(admin: SupabaseClient, clientId: string, adAccountId: string) {
  const account = adAccountId.replace(/^act_/, "");
  const daily = await syncDaily(admin, clientId, account);
  await syncReach(admin, clientId, account);
  await snapshot(admin, clientId, account);
  return daily;
}

/**
 * Every 2 hours: link accounts, then for every client with an ad account (creative or not, so the winners library
 * sees every account we run): daily metrics, reach, and the snapshot. Clients we make creative for go first, then
 * whoever was synced longest ago, so a run that hits its time limit picks up where the last one stopped.
 */
export async function collectMeta(admin: SupabaseClient, budgetMs = 700_000) {
  const deadline = Date.now() + budgetMs;
  const access = await linkAdAccounts(admin);
  const [{ data: all }, { data: snaps }] = await Promise.all([
    admin.from("clients").select("id, name, meta_ad_account_id, creative_package").is("archived_at", null).in("status", LIVE).not("meta_ad_account_id", "is", null),
    admin.from("meta_snapshots").select("client_id, fetched_at").order("fetched_at", { ascending: false }).limit(2000),
  ]);
  const last = new Map<string, string>();
  for (const s of snaps ?? []) if (!last.has(s.client_id)) last.set(s.client_id, s.fetched_at);
  const clients = (all ?? []).sort(
    (a, b) => Number(b.creative_package) - Number(a.creative_package) || (last.get(a.id) ?? "").localeCompare(last.get(b.id) ?? ""),
  );
  const synced: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const c of clients ?? []) {
    if (Date.now() > deadline) {
      synced.push({ client: c.name, deferred: true }); // next run
      continue;
    }
    const account = c.meta_ad_account_id!.replace(/^act_/, "");
    try {
      const daily = await syncDaily(admin, c.id, account);
      const reach = await syncReach(admin, c.id, account);
      const snap = await snapshot(admin, c.id, account);
      synced.push({ client: c.name, ...daily, reachWindows: reach, snapshot: Boolean(snap) });
    } catch (e) {
      // Usually: the ad account isn't assigned to the system user yet
      errors.push(`${c.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    items: [],
    notes: { saved: synced.filter((s) => s.snapshot).length, synced, linked: access.linked, withoutAccount: access.creativeClientsWithoutAccount, errors },
  };
}

// ─── For the AI ─────────────────────────────────────────────────────────────

const money = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString("en-US", { maximumFractionDigits: x < 100 ? 2 : 0 })}`);

/** The snapshot in readable lines: every number that matters for creative decisions. */
export function describeMeta(s: { date_start: string; date_stop: string; summary: MetaSummary; weekly: (MetaSummary & { from: string })[]; ads: MetaAd[] }) {
  const line = (m: MetaSummary) =>
    [
      `spend ${money(m.spend)}`,
      `${m.results} ${m.result ?? "results"}${m.costPerResult != null ? ` at ${money(m.costPerResult)} each` : ""}`,
      m.roas != null && `ROAS ${m.roas} (${money(m.purchaseValue)} revenue)`,
      m.reach != null && `reach ${m.reach.toLocaleString("en-US")}`,
      `frequency ${m.frequency}`,
      `CTR ${m.ctr}% (link ${m.linkCtr ?? "—"}%)`,
      m.cpc != null && `CPC ${money(m.cpc)}`,
      `CPM ${money(m.cpm)}`,
      m.landingPageViews ? `${m.landingPageViews} landing page views` : null,
      m.addToCart ? `${m.addToCart} adds to cart` : null,
      m.hookRate != null && `hook rate ${m.hookRate}%`,
      m.holdRate != null && `hold rate ${m.holdRate}%`,
    ]
      .filter(Boolean)
      .join(", ");
  const rank = (a: MetaAd) =>
    a.rankings && (a.rankings.quality || a.rankings.engagement || a.rankings.conversion)
      ? `\n  Meta rankings: quality ${a.rankings.quality ?? "—"}, engagement ${a.rankings.engagement ?? "—"}, conversion ${a.rankings.conversion ?? "—"}`
      : "";
  return [
    `Last 30 days (${s.date_start} to ${s.date_stop}): ${line(s.summary)}.`,
    "Week by week: " + s.weekly.map((w) => `${w.from}: ${money(w.spend)}, ${w.results} ${w.result ?? ""}${w.costPerResult != null ? ` @ ${money(w.costPerResult)}` : ""}${w.roas != null ? `, ROAS ${w.roas}` : ""}, CTR ${w.ctr}%`).join("; "),
    "Top ads by spend:",
    ...s.ads.slice(0, 12).map(
      (a) => `- "${a.name}" (${a.campaign}): ${line(a)}${rank(a)}${a.headline ? `\n  headline: ${a.headline}` : ""}${a.text ? `\n  text: ${a.text.replace(/\s+/g, " ").slice(0, 220)}` : ""}`,
    ),
  ].join("\n");
}

// ─── Setup help ─────────────────────────────────────────────────────────────

/** Try progressively bigger requests on one ad account and report Meta's exact answer to each. */
export async function debugMeta(adAccountId: string) {
  const token = process.env.META_SYSTEM_USER_TOKEN!;
  const act = `act_${adAccountId.replace(/^act_/, "")}`;
  const probe = async (label: string, version: string, path: string, params: Record<string, string>) => {
    const res = await fetch(`https://graph.facebook.com/${version}/${path}?${new URLSearchParams({ ...params, ...proof(), access_token: token })}`, { cache: "no-store" });
    const body = (await res.json()) as { error?: { message: string; code: number; error_subcode?: number; type?: string }; data?: unknown[] };
    return body.error
      ? { label, version, ok: false, code: body.error.code, subcode: body.error.error_subcode ?? null, type: body.error.type, message: body.error.message }
      : { label, version, ok: true, rows: Array.isArray(body.data) ? body.data.length : undefined };
  };
  const out = [];
  for (const v of [VERSION, "v23.0", "v25.0"]) out.push(await probe("account details", v, act, { fields: "name,account_status,currency,timezone_name" }));
  out.push(await probe("spend, last 7 days", VERSION, `${act}/insights`, { date_preset: "last_7d", fields: "spend" }));
  out.push(await probe("reach, last 30 days", VERSION, `${act}/insights`, { date_preset: "last_30d", fields: "reach" }));
  out.push(await probe("+ actions", VERSION, `${act}/insights`, { date_preset: "last_30d", fields: "spend,actions,cost_per_action_type" }));
  out.push(await probe("by ad", VERSION, `${act}/insights`, { date_preset: "last_30d", level: "ad", fields: "ad_name,spend", limit: "5" }));
  out.push(await probe("token permissions", VERSION, "me/permissions", {}));
  // One ad's creative, the way the sync reads it
  const ads = await fetch(`https://graph.facebook.com/${VERSION}/${act}/ads?${new URLSearchParams({ fields: "id", limit: "1", ...proof(), access_token: token })}`, { cache: "no-store" }).then((r) => r.json() as Promise<{ data?: { id: string }[] }>);
  const adId = ads.data?.[0]?.id;
  if (adId) out.push(await probe("one ad's creative", VERSION, adId, { fields: "effective_status,creative.thumbnail_width(600).thumbnail_height(600){title,body,thumbnail_url,image_url,object_story_spec,asset_feed_spec,effective_object_story_id}" }));
  return { version: VERSION, appSecretProof: Boolean(process.env.META_APP_SECRET), probes: out };
}

// ─── One ad, in full, on demand (the winners library and client pages open it) ───

export type AdDetail = {
  text: string | null;
  headline: string | null;
  image: string | null;
  video: { source: string | null; poster: string | null } | null;
  preview: string | null; // Meta's own rendering of the ad (an iframe URL), when the video itself can't be played here
  cta: string | null; // the button, as Meta shows it ("Learn More", "Shop Now")
  link: string | null; // where the ad sends people
  page: { name: string | null; picture: string | null } | null; // the Facebook Page it runs from
};

// Meta's button types, as the button reads in the feed
const CTA_LABEL: Record<string, string> = {
  LEARN_MORE: "Learn more", SHOP_NOW: "Shop now", SIGN_UP: "Sign up", BOOK_TRAVEL: "Book now", BOOK_NOW: "Book now", CONTACT_US: "Contact us",
  DOWNLOAD: "Download", GET_OFFER: "Get offer", GET_QUOTE: "Get quote", SUBSCRIBE: "Subscribe", APPLY_NOW: "Apply now", ORDER_NOW: "Order now",
  CALL_NOW: "Call now", MESSAGE_PAGE: "Send message", WHATSAPP_MESSAGE: "Send WhatsApp message", GET_DIRECTIONS: "Get directions", WATCH_MORE: "Watch more",
  SEE_MENU: "See menu", BUY_TICKETS: "Buy tickets", REQUEST_TIME: "Request time", GET_STARTED: "Get started", INSTALL_MOBILE_APP: "Install now",
  LISTEN_NOW: "Listen now", DONATE_NOW: "Donate now", BUY_NOW: "Buy now", SEND_UPDATES: "Get updates", INQUIRE_NOW: "Inquire now", NO_BUTTON: "",
};
const ctaLabel = (t?: string) => (t ? (CTA_LABEL[t] ?? t.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())) || null : null);

/** The ad as it runs: full copy, the full image, the video file when the page lets us read it, and Meta's preview. */
export async function adDetail(adId: string): Promise<AdDetail> {
  type C = {
    title?: string;
    body?: string;
    image_url?: string;
    thumbnail_url?: string;
    video_id?: string;
    call_to_action_type?: string;
    object_story_spec?: {
      page_id?: string;
      link_data?: { name?: string; message?: string; picture?: string; link?: string; call_to_action?: { type?: string; value?: { link?: string } } };
      video_data?: { title?: string; message?: string; video_id?: string; image_url?: string; call_to_action?: { type?: string; value?: { link?: string } } };
    };
    asset_feed_spec?: { titles?: { text: string }[]; bodies?: { text: string }[]; videos?: { video_id: string; thumbnail_url?: string }[]; link_urls?: { website_url?: string }[]; call_to_action_types?: string[] };
    effective_object_story_id?: string;
  };
  const ad = await graph<{ creative?: C }>(adId, {
    fields: "creative.thumbnail_width(1080).thumbnail_height(1080){title,body,image_url,thumbnail_url,video_id,call_to_action_type,object_story_spec,asset_feed_spec,effective_object_story_id}",
  });
  const c = ad.creative ?? {};
  let text = c.body ?? c.object_story_spec?.link_data?.message ?? c.object_story_spec?.video_data?.message ?? c.asset_feed_spec?.bodies?.[0]?.text ?? null;
  if (!text && c.effective_object_story_id) text = (await graph<{ message?: string }>(c.effective_object_story_id, { fields: "message" }).catch(() => null))?.message ?? null;
  const videoId = c.video_id ?? c.object_story_spec?.video_data?.video_id ?? c.asset_feed_spec?.videos?.[0]?.video_id ?? null;
  const poster = c.object_story_spec?.video_data?.image_url ?? c.asset_feed_spec?.videos?.[0]?.thumbnail_url ?? c.thumbnail_url ?? null;
  const spec = c.object_story_spec;
  const pageId = spec?.page_id ?? c.effective_object_story_id?.split("_")[0] ?? null;
  const [video, preview, page] = await Promise.all([
    videoId ? graph<{ source?: string; picture?: string }>(videoId, { fields: "source,picture" }).catch(() => null) : Promise.resolve(null),
    graph<{ data?: { body?: string }[] }>(`${adId}/previews`, { ad_format: "MOBILE_FEED_STANDARD" })
      .then((r) => r.data?.[0]?.body?.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null)
      .catch(() => null),
    pageId ? graph<{ name?: string; picture?: { data?: { url?: string } } }>(pageId, { fields: "name,picture.type(large)" }).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    text,
    headline: c.title ?? c.object_story_spec?.link_data?.name ?? c.object_story_spec?.video_data?.title ?? c.asset_feed_spec?.titles?.[0]?.text ?? null,
    image: videoId ? null : (c.image_url ?? c.object_story_spec?.link_data?.picture ?? c.thumbnail_url ?? null),
    video: videoId ? { source: video?.source ?? null, poster: poster ?? video?.picture ?? null } : null,
    preview,
    cta: ctaLabel(spec?.link_data?.call_to_action?.type ?? spec?.video_data?.call_to_action?.type ?? c.call_to_action_type ?? c.asset_feed_spec?.call_to_action_types?.[0]),
    link: spec?.link_data?.call_to_action?.value?.link ?? spec?.link_data?.link ?? spec?.video_data?.call_to_action?.value?.link ?? c.asset_feed_spec?.link_urls?.[0]?.website_url ?? null,
    page: page ? { name: page.name ?? null, picture: page.picture?.data?.url ?? null } : null,
  };
}
