// The parts of a change asked for in chat that don't touch a platform: where each object lives in Ads Manager or
// Google Ads (so the buyer can check the change landed), swapping the link inside a Meta creative's spec, and the
// edits a buyer makes to a plan before confirming it. Shared by the server and the plan card.

export type Metrics = { spend: number; results: number; cpr: number | null; ctr: number | null; freq: number | null };

/** What the plan card shows for an object it will touch: its place, its look, its numbers. */
export type ObjRef = {
  platform: "meta" | "google" | "team";
  level: "campaign" | "adset" | "ad" | "ad_group" | "keyword" | "person";
  id: string;
  name: string;
  /** Campaign, then ad set / ad group: where it sits */
  path: string[];
  status: string | null;
  account: string;
  campaignId?: string | null;
  adGroupId?: string | null;
  m7?: Metrics | null;
  m30?: Metrics | null;
  /** What a result is for this account ("purchase", "lead"), and the target cost per result (or ROAS) */
  result?: string | null;
  target?: number | null;
  roas?: boolean;
  creative?: { thumb: string | null; video: boolean; body: string | null; headline: string | null; cta: string | null; url: string | null; preview: string | null; cards?: { thumb: string | null; headline: string | null }[] } | null;
};

const digits = (s: string) => String(s ?? "").replace(/\D/g, "");

/** The exact object in Meta Ads Manager: the campaign, ad set or ad selected in its own tab. */
export function metaDeepLink(account: string, level: "campaign" | "adset" | "ad" | "account", id?: string | null) {
  const act = digits(account);
  if (level === "account" || !id) return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}`;
  const tab = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
  return `https://adsmanager.facebook.com/adsmanager/manage/${tab}?act=${act}&selected_${level}_ids=${digits(id)}`;
}

/**
 * The object in Google Ads: the account picked by its customer ID (__e), then the right page, narrowed to the campaign
 * and ad group it belongs to.
 */
export function googleDeepLink(customer: string, level: "campaign" | "ad_group" | "ad" | "keyword" | "account", ids: { campaignId?: string | null; adGroupId?: string | null } = {}) {
  const page = level === "campaign" || level === "account" ? "campaigns" : level === "ad_group" ? "adgroups" : level === "ad" ? "ads" : "keywords";
  const q = new URLSearchParams({ __e: digits(customer) });
  if (ids.campaignId && level !== "account") q.set("campaignId", digits(ids.campaignId));
  if (ids.adGroupId && (level === "ad" || level === "keyword")) q.set("adGroupId", digits(ids.adGroupId));
  return `https://ads.google.com/aw/${page}?${q.toString()}`;
}

/** Where to look for an object once the change is made. A copied ad links to the new copy. */
export function verifyLink(ref: ObjRef, newId?: string | null) {
  if (ref.platform === "meta") {
    const level = ref.level === "campaign" || ref.level === "adset" || ref.level === "ad" ? ref.level : "account";
    return metaDeepLink(ref.account, newId ? "ad" : level, newId ?? ref.id);
  }
  if (ref.platform === "google") {
    const level = ref.level === "campaign" || ref.level === "ad_group" || ref.level === "ad" || ref.level === "keyword" ? ref.level : "account";
    return googleDeepLink(ref.account, level, { campaignId: ref.campaignId ?? (ref.level === "campaign" ? ref.id : null), adGroupId: ref.adGroupId ?? (ref.level === "ad_group" ? ref.id : null) });
  }
  return null;
}

const LINK_KEYS = new Set(["link", "website_url"]);

/** The destination URLs inside a Meta creative's spec (link ads, video CTAs, carousel cards, dynamic creative). */
export function findLinks(spec: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (key && LINK_KEYS.has(key) && /^https?:\/\//i.test(v)) out.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(spec);
  return [...new Set(out)];
}

/**
 * The same spec with its destination links swapped: every link, or only those equal to `from` (a carousel can send
 * cards to different pages). Captions and display links stay as they are. Returns how many it changed.
 */
export function replaceLinks<T>(spec: T, to: string, from?: string | null): { spec: T; changed: number } {
  let changed = 0;
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && LINK_KEYS.has(key) && /^https?:\/\//i.test(v) && (!from || norm(v) === norm(from))) {
        changed++;
        return to;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { spec: walk(spec) as T, changed };
}

/** An edit the buyer made to one change before confirming: a different amount, name or link. */
export type OpEdit = { to?: number; name?: string; url?: string };

/** Applies the buyer's edit to the fields a change allows editing; anything else is ignored. */
export function editOp<T extends { kind: string }>(op: T, edit: OpEdit | undefined): T {
  if (!edit) return op;
  const o = { ...op } as Record<string, unknown>;
  if (edit.to != null && Number.isFinite(edit.to) && edit.to > 0 && ["meta_budget", "campaign_budget", "target_cpa", "target_roas"].includes(op.kind)) o.to = Math.round(edit.to * 100) / 100;
  if (edit.name != null && edit.name.trim() && op.kind === "meta_rename") o.to = edit.name.trim().slice(0, 400);
  if (edit.url != null && /^https?:\/\/\S+$/i.test(edit.url.trim()) && (op.kind === "meta_link" || op.kind === "google_ad_url")) o.to = edit.url.trim();
  return o as T;
}

const money = (n: unknown) => (n == null ? "not set" : `$${Number(n).toFixed(2)}`);
const onOff = (s: unknown) => (s === "ACTIVE" || s === "ENABLED" ? "on" : String(s ?? "").toLowerCase().replace(/_/g, " "));
const lvl = (l: unknown) => (l === "adset" ? "Ad set" : l === "ad" ? "Ad" : "Campaign");

/** A change as what it touches, from and to, for any kind (the chat's kinds included). */
export function lineOf(op: { kind: string }): [string, string | null, string] {
  const o = op as Record<string, unknown>;
  const to = o.to === "PAUSED" ? "paused" : "on";
  switch (op.kind) {
    case "meta_rename":
      return [`${lvl(o.level)} name`, String(o.from), String(o.to)];
    case "meta_copy_ad":
      return [`Copy ad "${o.name}"`, String(o.parent ?? ""), `${o.targetAdset} (${o.status === "PAUSED" ? "paused" : "on"})`];
    case "meta_link":
      return [`Link on ad "${o.name}"${o.tags ? " · UTMs" : ""}`, o.from ? String(o.from) : null, o.to ? String(o.to) : String(o.tags ?? "")];
    case "google_ad_status":
      return [`Ad "${o.name}" · ${o.campaign}`, onOff(o.from), to];
    case "google_keyword_status":
      return [`Keyword "${o.name}" · ${o.campaign}`, onOff(o.from), to];
    case "google_ad_url":
      return [`Final URL · ad "${o.name}"`, o.from ? String(o.from) : null, String(o.to)];
    case "assign_buyer":
      return [`${o.slot === "meta_buyer" ? "Meta" : "Google"} buyer`, o.from ? String(o.from) : "nobody", String(o.to)];
    case "meta_status":
      return [`${lvl(o.level)} "${o.name}"`, onOff(o.from), to];
    case "meta_budget":
      return [`Daily budget · ${o.level === "adset" ? "ad set" : "campaign"} "${o.name}"`, money(o.from), money(o.to)];
    case "campaign_status":
      return [`Campaign "${o.campaign}"`, onOff(o.from), to];
    case "ad_group_status":
      return [`Ad group "${o.adGroup}" · ${o.campaign}`, onOff(o.from), to];
    case "campaign_budget":
      return [`Daily budget · "${o.campaign}"`, money(o.from), money(o.to)];
    case "target_cpa":
      return [`Target CPA · "${o.campaign}"`, money(o.from), money(o.to)];
    case "target_roas":
      return [`Target ROAS · "${o.campaign}"`, o.from == null ? "not set" : `${Math.round(Number(o.from) * 100)}%`, `${Math.round(Number(o.to) * 100)}%`];
    case "negative_keywords":
      return [`Negative keywords · "${o.campaign}"`, null, ((o.keywords ?? []) as { text: string; match: string }[]).map((k) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text)).join(", ")];
    default:
      return [op.kind, null, ""];
  }
}

/** Whether an edited change differs from what was checked (so it's checked again before it's sent). */
export const edited = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

/** "$12.40" or "3.2x" for a cost per result or a ROAS. */
export function kpiText(v: number | null | undefined, roas = false) {
  if (v == null) return "–";
  return roas ? `${v.toFixed(1)}x` : `$${v.toFixed(2)}`;
}
