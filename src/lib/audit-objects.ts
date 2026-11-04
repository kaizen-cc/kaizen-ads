import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditObject } from "@/lib/chat-change-core";

// The campaigns, ad sets and ads (Google: campaigns and ad groups) an audit's actions name, found in the account's own
// data by name. The model is asked for exact names only; the IDs come from what Meta or Google gave us, so every
// "Open in Ads Manager" link points at something real. A name that matches nothing is left out rather than guessed.

export type ObjectRef = { type: string; name: string };
type Entry = Omit<AuditObject, "name"> & { name: string; key: string; weight: number };
export type ObjectIndex = Entry[];

const TYPES = new Set(["campaign", "adset", "ad", "ad_group", "keyword"]);

/** A name as the model or the platform might write it: no [id], no "Campaign › " path, no quotes, one case. */
export function nameKey(s: string) {
  const last = String(s ?? "")
    .replace(/\[\d+\]/g, "")
    .split(/\s+(?:›|>|»)\s+/)
    .pop()!;
  return last
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const typeOf = (t: string): AuditObject["type"] | null => {
  const x = t.toLowerCase().replace(/[\s-]+/g, "_");
  const v = x === "ad_set" ? "adset" : x === "adgroup" ? "ad_group" : x;
  return TYPES.has(v) ? (v as AuditObject["type"]) : null;
};

type MetaRow = { ad_id: string; ad_name: string | null; adset_id: string | null; adset_name: string | null; campaign_id: string | null; campaign_name: string | null; metrics?: Record<string, unknown> | null };

/** A Meta account's campaigns, ad sets and ads from its daily rows (weighted by spend) and its live setup. */
export function metaIndex(account: string, rows: MetaRow[], setup?: { campaigns: { id: string; name: string }[]; adsets: { id: string; name: string; campaignId: string }[] } | null): ObjectIndex {
  const act = String(account).replace(/\D/g, "");
  const m = new Map<string, Entry>();
  const add = (type: AuditObject["type"], id: string | null, name: string | null, spend: number, campaignId: string | null = null) => {
    if (!id || !name) return;
    const k = `${type}:${id}`;
    const e = m.get(k);
    if (e) e.weight += spend;
    else m.set(k, { platform: "meta", type, id: String(id), name, key: nameKey(name), account: act, campaignId, weight: spend + 0.001 });
  };
  for (const r of rows) {
    const spend = Number(r.metrics?.spend) || 0;
    add("campaign", r.campaign_id, r.campaign_name, spend);
    add("adset", r.adset_id, r.adset_name, spend, r.campaign_id);
    add("ad", r.ad_id, r.ad_name, spend, r.campaign_id);
  }
  for (const c of setup?.campaigns ?? []) add("campaign", c.id, c.name, 0);
  for (const a of setup?.adsets ?? []) add("adset", a.id, a.name, 0, a.campaignId);
  return [...m.values()];
}

/** A Google account's campaigns (from its daily rows and setup) and ad groups (from the live account, when read). */
export function googleIndex(account: string, rows: { campaign_id: string; campaign_name?: string | null; spend?: number | string | null }[], setup?: { campaigns: { id: string; name: string }[] } | null, adGroups: { id: string; name: string; campaignId: string }[] = []): ObjectIndex {
  const customer = String(account).replace(/\D/g, "");
  const m = new Map<string, Entry>();
  const add = (type: AuditObject["type"], id: string | null | undefined, name: string | null | undefined, spend: number, campaignId: string | null = null) => {
    if (!id || !name) return;
    const k = `${type}:${id}`;
    const e = m.get(k);
    if (e) e.weight += spend;
    else m.set(k, { platform: "google", type, id: String(id), name, key: nameKey(name), account: customer, campaignId: campaignId ?? (type === "campaign" ? String(id) : null), adGroupId: type === "ad_group" ? String(id) : null, weight: spend + 0.001 });
  };
  for (const r of rows) add("campaign", r.campaign_id, r.campaign_name, Number(r.spend) || 0);
  for (const c of setup?.campaigns ?? []) add("campaign", c.id, c.name, 0);
  for (const g of adGroups) add("ad_group", g.id, g.name, 0, g.campaignId);
  return [...m.values()];
}

/**
 * The objects an action names, found by exact name (case and spacing aside) in the account's data: the same type
 * first, any type when the model called it the wrong thing. When one name is several objects (an ad copied into
 * several ad sets), the one that spent the most. An [id] the model copied from the numbers counts only if it's real.
 */
export function resolveObjects(index: ObjectIndex, refs: ObjectRef[] | null | undefined, max = 6): AuditObject[] {
  const out: AuditObject[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    if (!ref?.name?.trim()) continue;
    const type = typeOf(ref.type ?? "");
    const quoted = String(ref.name).match(/\[(\d{5,})\]/)?.[1];
    const key = nameKey(ref.name);
    const byId = quoted ? index.find((e) => e.id === quoted) : undefined;
    const named = index.filter((e) => e.key === key);
    const pool = byId ? [byId] : named.filter((e) => !type || e.type === type).length ? named.filter((e) => !type || e.type === type) : named;
    const best = pool.sort((a, b) => b.weight - a.weight)[0];
    if (!best || seen.has(`${best.type}:${best.id}`)) continue;
    seen.add(`${best.type}:${best.id}`);
    out.push({ platform: best.platform, type: best.type, id: best.id, name: best.name, account: best.account, campaignId: best.campaignId ?? null, adGroupId: best.adGroupId ?? null });
    if (out.length >= max) break;
  }
  return out;
}

/** Every ad account of a client, indexed (for the business audit, which spans them): Meta's last 30 days and Google's campaigns. */
export async function clientObjectIndex(admin: SupabaseClient, clientId: string): Promise<{ meta: ObjectIndex; google: ObjectIndex }> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const accounts = new Map<string, MetaRow[]>();
  for (let page = 0; page < 10; page++) {
    const { data } = await admin
      .from("meta_ad_daily")
      .select("ad_account_id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, metrics")
      .eq("client_id", clientId)
      .gte("date", since)
      .range(page * 1000, page * 1000 + 999);
    for (const r of (data ?? []) as (MetaRow & { ad_account_id: string })[]) {
      accounts.set(r.ad_account_id, [...(accounts.get(r.ad_account_id) ?? []), r]);
    }
    if (!data || data.length < 1000) break;
  }
  const metaIdx = [...accounts].flatMap(([account, rows]) => metaIndex(account, rows));
  const { data: targets } = await admin.from("kpi_targets").select("ad_account_id").eq("client_id", clientId).eq("platform", "google").not("ad_account_id", "is", null);
  const { accountRows } = await import("@/lib/kpi/sync");
  const googleIdx: ObjectIndex = [];
  for (const account of new Set((targets ?? []).map((t) => String(t.ad_account_id)))) {
    const rows = await accountRows(admin, account, "google").catch(() => []);
    googleIdx.push(...googleIndex(account, rows.filter((r) => r.date >= since)));
  }
  return { meta: metaIdx, google: googleIdx };
}
