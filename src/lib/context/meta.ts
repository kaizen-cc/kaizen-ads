import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact } from "./shared";

// Reads ad performance with the CommandCenter system user (META_SYSTEM_USER_TOKEN, ads_read).
// If the Meta app requires it, META_APP_SECRET adds the appsecret_proof Meta asks for.

const VERSION = process.env.META_API_VERSION || "v24.0";
export const metaConfigured = () => Boolean(process.env.META_SYSTEM_USER_TOKEN);

async function graph<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = process.env.META_SYSTEM_USER_TOKEN!;
  const proof: Record<string, string> = process.env.META_APP_SECRET ? { appsecret_proof: createHmac("sha256", process.env.META_APP_SECRET).update(token).digest("hex") } : {};
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://graph.facebook.com/${VERSION}/${path}?${new URLSearchParams({ ...params, ...proof, access_token: token })}`, { cache: "no-store" });
    const body = (await res.json()) as T & { error?: { message: string; code: number } };
    // 1, 2: Meta busy or the query too heavy for a moment; 4, 17, 32, 613: rate limits. Wait a little and try again
    if (body.error && [1, 2, 4, 17, 32, 613].includes(body.error.code) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (body.error) throw new Error(`Meta (${path.split("/").pop() || "ads"}): ${body.error.message}`);
    return body;
  }
  throw new Error("Meta: rate limited");
}

type Action = { action_type: string; value: string };
type Row = {
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  actions?: Action[];
  cost_per_action_type?: Action[];
  purchase_roas?: Action[];
  date_start: string;
  date_stop: string;
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
};

// The result a client is buying, in order of what usually matters most
const RESULTS: [string, string[]][] = [
  ["purchase", ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]],
  ["lead", ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]],
  ["registration", ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"]],
  ["link click", ["link_click"]],
];

function result(row: Row, kind?: string) {
  const pick = (list: Action[] | undefined, types: string[]) => types.map((t) => list?.find((a) => a.action_type === t)).find(Boolean);
  for (const [name, types] of RESULTS) {
    if (kind && name !== kind) continue;
    const count = pick(row.actions, types);
    if (count && Number(count.value) > 0) {
      const cost = pick(row.cost_per_action_type, types);
      return { kind: name, count: Number(count.value), cost: cost ? Number(cost.value) : null };
    }
  }
  return null;
}

const num = (s?: string) => (s ? Number(s) : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function shape(row: Row, kind?: string) {
  const r = result(row, kind);
  const roas = row.purchase_roas?.[0]?.value;
  return {
    spend: round(num(row.spend)),
    impressions: num(row.impressions),
    frequency: round(num(row.frequency)),
    ctr: round(num(row.ctr)),
    cpm: round(num(row.cpm)),
    result: r?.kind ?? null,
    results: r?.count ?? 0,
    costPerResult: r?.cost != null ? round(r.cost) : null,
    roas: roas ? round(Number(roas)) : null,
  };
}

export type MetaSummary = ReturnType<typeof shape>;
export type MetaAd = MetaSummary & { name: string; campaign: string; adset: string; headline: string | null; text: string | null; thumbnail: string | null };

const FIELDS = "spend,impressions,reach,frequency,clicks,ctr,cpm,actions,cost_per_action_type,purchase_roas";

/** The last 30 days of one ad account: totals, week by week, and the top ads with their creative. */
export async function readAdAccount(adAccountId: string) {
  const act = `act_${adAccountId.replace(/^act_/, "")}`;
  // One at a time: Meta turns away heavy insights queries that arrive together
  const total = await graph<{ data: Row[] }>(`${act}/insights`, { date_preset: "last_30d", level: "account", fields: FIELDS });
  const weeks = await graph<{ data: Row[] }>(`${act}/insights`, { date_preset: "last_28d", level: "account", time_increment: "7", fields: FIELDS });
  const ads = await graph<{ data: Row[] }>(`${act}/insights`, {
    date_preset: "last_30d",
    level: "ad",
    fields: `ad_id,ad_name,adset_name,campaign_name,${FIELDS}`,
    sort: "spend_descending",
    limit: "25",
  });
  const row = total.data[0];
  const summary = row ? shape(row) : null;
  const kind = summary?.result ?? undefined; // judge every ad on the account's main result

  // The creative behind the top ads: headline, primary text, thumbnail
  const ids = ads.data.slice(0, 15).map((a) => a.ad_id).filter(Boolean) as string[];
  // Nice to have: if Meta won't return the creatives, the numbers are still saved
  let creatives: Record<string, { creative?: { title?: string; body?: string; thumbnail_url?: string; object_story_spec?: { link_data?: { name?: string; message?: string } } } }> = {};
  if (ids.length)
    try {
      creatives = await graph("", { ids: ids.join(","), fields: "creative{title,body,thumbnail_url}" });
    } catch {
      creatives = {};
    }

  return {
    dateStart: row?.date_start ?? null,
    dateStop: row?.date_stop ?? null,
    summary,
    weekly: weeks.data.map((w) => ({ from: w.date_start, to: w.date_stop, ...shape(w, kind) })),
    ads: ads.data.map((a): MetaAd => {
      const c = creatives[a.ad_id ?? ""]?.creative;
      const link = c?.object_story_spec?.link_data;
      return {
        name: a.ad_name ?? "",
        campaign: a.campaign_name ?? "",
        adset: a.adset_name ?? "",
        headline: c?.title ?? link?.name ?? null,
        text: (c?.body ?? link?.message ?? null)?.slice(0, 400) ?? null,
        thumbnail: c?.thumbnail_url ?? null,
        ...shape(a, kind),
      };
    }),
  };
}

/** Every ad account the system user can see, and link unlinked creative clients to theirs by name. */
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

  const { data: clients } = await admin.from("clients").select("id, name, meta_ad_account_id").eq("creative_package", true);
  const linked: string[] = [];
  for (const c of clients ?? []) {
    if (c.meta_ad_account_id) continue;
    const key = compact(c.name);
    const hits = accounts.filter((a) => {
      const n = compact(a.name);
      return key.length >= 4 && (n.includes(key) || key.includes(n));
    });
    if (hits.length === 1) {
      await admin.from("clients").update({ meta_ad_account_id: hits[0].account_id }).eq("id", c.id);
      c.meta_ad_account_id = hits[0].account_id;
      linked.push(`${c.name} → ${hits[0].name}`);
    }
  }
  return {
    accounts: accounts.map((a) => `${a.name} (${a.account_id})${a.account_status === 1 ? "" : " · not active"}`),
    linked,
    creativeClientsWithoutAccount: (clients ?? []).filter((c) => !c.meta_ad_account_id).map((c) => c.name),
  };
}

/** The 12pm/6pm step: link accounts, then save a fresh snapshot for each creative client with one. */
export async function collectMeta(admin: SupabaseClient) {
  const access = await linkAdAccounts(admin);
  const { data: clients } = await admin.from("clients").select("id, name, meta_ad_account_id").eq("creative_package", true).not("meta_ad_account_id", "is", null);
  const saved: string[] = [];
  const errors: string[] = [];
  for (const c of clients ?? []) {
    try {
      const r = await readAdAccount(c.meta_ad_account_id!);
      if (!r.summary) continue; // nothing ran in the last 30 days
      const { error } = await admin.from("meta_snapshots").insert({
        client_id: c.id,
        ad_account_id: c.meta_ad_account_id,
        date_start: r.dateStart,
        date_stop: r.dateStop,
        summary: r.summary,
        weekly: r.weekly,
        ads: r.ads,
      });
      if (error) throw new Error(error.message);
      saved.push(c.name);
    } catch (e) {
      // Usually: the ad account isn't assigned to the system user yet
      errors.push(`${c.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { items: [], notes: { saved: saved.length, clients: saved, linked: access.linked, withoutAccount: access.creativeClientsWithoutAccount, errors } };
}

const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);

/** For the AI: the snapshot in a few readable lines. */
export function describeMeta(s: { date_start: string; date_stop: string; summary: MetaSummary; weekly: (MetaSummary & { from: string })[]; ads: MetaAd[] }) {
  const line = (m: MetaSummary) =>
    `spend ${money(m.spend)}, ${m.results} ${m.result ?? "results"}${m.costPerResult != null ? ` at ${money(m.costPerResult)} each` : ""}${m.roas != null ? `, ROAS ${m.roas}` : ""}, CTR ${m.ctr}%, CPM ${money(m.cpm)}, frequency ${m.frequency}`;
  return [
    `Last 30 days (${s.date_start} to ${s.date_stop}): ${line(s.summary)}.`,
    "Week by week: " + s.weekly.map((w) => `${w.from}: ${money(w.spend)}, ${w.results} ${w.result ?? ""}${w.costPerResult != null ? ` @ ${money(w.costPerResult)}` : ""}, freq ${w.frequency}`).join("; "),
    "Top ads by spend:",
    ...s.ads.slice(0, 12).map(
      (a) =>
        `- "${a.name}" (${a.campaign}): ${line(a)}${a.headline ? `\n  headline: ${a.headline}` : ""}${a.text ? `\n  text: ${a.text.replace(/\s+/g, " ").slice(0, 220)}` : ""}`,
    ),
  ].join("\n");
}

/** Setup help: try progressively bigger requests on one ad account and report Meta's exact answer to each. */
export async function debugMeta(adAccountId: string) {
  const token = process.env.META_SYSTEM_USER_TOKEN!;
  const proof: Record<string, string> = process.env.META_APP_SECRET ? { appsecret_proof: createHmac("sha256", process.env.META_APP_SECRET).update(token).digest("hex") } : {};
  const act = `act_${adAccountId.replace(/^act_/, "")}`;
  const probe = async (label: string, version: string, path: string, params: Record<string, string>) => {
    const res = await fetch(`https://graph.facebook.com/${version}/${path}?${new URLSearchParams({ ...params, ...proof, access_token: token })}`, { cache: "no-store" });
    const body = (await res.json()) as { error?: { message: string; code: number; error_subcode?: number; type?: string; fbtrace_id?: string }; data?: unknown[] };
    return body.error
      ? { label, version, ok: false, code: body.error.code, subcode: body.error.error_subcode ?? null, type: body.error.type, message: body.error.message }
      : { label, version, ok: true, rows: Array.isArray(body.data) ? body.data.length : undefined };
  };
  const out = [];
  for (const v of [VERSION, "v23.0", "v25.0"]) out.push(await probe("account details", v, act, { fields: "name,account_status,currency,timezone_name" }));
  out.push(await probe("spend, last 7 days", VERSION, `${act}/insights`, { date_preset: "last_7d", fields: "spend" }));
  out.push(await probe("spend, last 30 days", VERSION, `${act}/insights`, { date_preset: "last_30d", fields: "spend,impressions,ctr,cpm,frequency" }));
  out.push(await probe("+ actions", VERSION, `${act}/insights`, { date_preset: "last_30d", fields: "spend,actions,cost_per_action_type" }));
  out.push(await probe("+ ROAS", VERSION, `${act}/insights`, { date_preset: "last_30d", fields: "spend,purchase_roas" }));
  out.push(await probe("by ad", VERSION, `${act}/insights`, { date_preset: "last_30d", level: "ad", fields: "ad_name,spend", limit: "5" }));
  out.push(await probe("ads list", VERSION, `${act}/ads`, { fields: "name,effective_status", limit: "5" }));
  out.push(await probe("token permissions", VERSION, "me/permissions", {}));
  return { version: VERSION, appSecretProof: Boolean(process.env.META_APP_SECRET), probes: out };
}
