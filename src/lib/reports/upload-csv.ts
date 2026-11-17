// An ad account's numbers from a file the buyer exported (Meta Ads Manager, or Google Ads), for when Kaizen OS can't
// read the account itself (Meta answering "(#200) Ad account owner has NOT grant ads_management or ads_read
// permission", say). Pure functions: the CSV is read here, the same way every time, and turned into the daily campaign
// rows the KPI board and the reports already count, so a file's numbers follow every rule the synced ones do (the
// client's KPI conversion, each campaign's own result, campaigns left out). Headers this file doesn't know are matched
// once by the AI (see the upload action); the mapping comes back in as `mapping`.

/** What a column can mean */
export const UPLOAD_KEYS = [
  "campaign",
  "campaignId",
  "adset",
  "ad",
  "adId",
  "day",
  "start",
  "end",
  "spend",
  "impressions",
  "reach",
  "linkClicks",
  "uniqueLinkClicks",
  "clicks",
  "ctr",
  "cpc",
  "results",
  "resultIndicator",
  "resultType",
  "costPerResult",
  "purchases",
  "purchaseValue",
  "websitePurchases",
  "websitePurchaseValue",
  "leads",
  "fbLeads",
  "websiteLeads",
  "addsToCart",
  "websiteAddsToCart",
  "landingPageViews",
  "schedules",
  "applications",
  "registrations",
  "thruplays",
  "videoPlays3s",
  "conversions",
  "conversionValue",
  "currency",
] as const;
export type UploadKey = (typeof UPLOAD_KEYS)[number];

const TEXT_KEYS = new Set<UploadKey>(["campaign", "campaignId", "adset", "ad", "adId", "day", "start", "end", "resultIndicator", "resultType", "currency"]);
/** The numbers a row can carry */
export type UploadNumbers = Partial<Record<Exclude<UploadKey, "campaign" | "campaignId" | "adset" | "ad" | "adId" | "day" | "start" | "end" | "resultIndicator" | "resultType" | "currency">, number>>;

/** One row of the file: a campaign, ad set or ad, for one day (date) or for the file's whole range (start to end) */
export type UploadRow = {
  date: string | null;
  start: string | null;
  end: string | null;
  campaign: string;
  campaignId: string | null;
  adset: string | null;
  ad: string | null;
  adId: string | null;
  /** Meta's action type for "Results" (from the result indicator or result type), when the file says */
  resultType: string | null;
  n: UploadNumbers;
};

export type UploadPlatform = "meta" | "google";
export type UploadLevel = "campaign" | "adset" | "ad";

/** A file as read: its rows and what they cover */
export type ParsedUpload = {
  platform: UploadPlatform;
  level: UploadLevel;
  /** Rows by day (a Day breakdown), or totals for the range */
  daily: boolean;
  start: string | null;
  end: string | null;
  currency: string | null;
  rows: UploadRow[];
  /** Every header, with what it was read as (null: not used) */
  headers: { header: string; key: UploadKey | null }[];
  /** No spend column could be found: the AI is asked to match the headers */
  needsMapping: boolean;
  /** Lines skipped: a totals row, an empty line */
  skipped: number;
};

/** An upload as it's kept on the report (reports.uploaded_data, every upload, never removed) */
export type UploadedFile = Omit<ParsedUpload, "needsMapping" | "skipped"> & {
  id: string;
  name: string;
  /** The file had no dates: read as the report's own dates at the time */
  datesAssumed: boolean;
  /** Some headers were matched by the AI */
  mappedByAi: boolean;
  by: string | null;
  byName: string | null;
  at: string;
};

// ─── Headers ──────────────────────────────────────────────────────────────

/** A header as compared: lower case, single spaces, a currency in brackets dropped ("Amount spent (USD)" → "amount spent") */
export function normHeader(h: string) {
  // The currency is an upper-case code, so "Clicks (all)" keeps its "(all)"
  return h
    .replace(/^﻿/, "")
    .replace(/\s*\([A-Z]{3}\)\s*$/, "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Ads Manager's names (and Google Ads'), as normHeader gives them
const META: Record<string, UploadKey> = {
  "campaign name": "campaign",
  campaign: "campaign",
  "campaign id": "campaignId",
  "ad set name": "adset",
  "ad set": "adset",
  "ad name": "ad",
  "ad id": "adId",
  "reporting starts": "start",
  "reporting ends": "end",
  day: "day",
  date: "day",
  "amount spent": "spend",
  spend: "spend",
  impressions: "impressions",
  reach: "reach",
  "link clicks": "linkClicks",
  "unique link clicks": "uniqueLinkClicks",
  "clicks (all)": "clicks",
  "ctr (link click-through rate)": "ctr",
  "cpc (cost per link click)": "cpc",
  results: "results",
  "result indicator": "resultIndicator",
  "result type": "resultType",
  "cost per result": "costPerResult",
  "cost per results": "costPerResult",
  purchases: "purchases",
  "purchases conversion value": "purchaseValue",
  "website purchases": "websitePurchases",
  "website purchases conversion value": "websitePurchaseValue",
  leads: "leads",
  "on-facebook leads": "fbLeads",
  "meta leads": "fbLeads",
  "instant form leads": "fbLeads",
  "website leads": "websiteLeads",
  "adds to cart": "addsToCart",
  "website adds to cart": "websiteAddsToCart",
  "landing page views": "landingPageViews",
  "website landing page views": "landingPageViews",
  schedules: "schedules",
  "website schedules": "schedules",
  "applications submitted": "applications",
  "website applications submitted": "applications",
  "registrations completed": "registrations",
  "website registrations completed": "registrations",
  thruplays: "thruplays",
  "3-second video plays": "videoPlays3s",
  currency: "currency",
};
const GOOGLE: Record<string, UploadKey> = {
  campaign: "campaign",
  "campaign id": "campaignId",
  "ad group": "adset",
  "asset group": "adset",
  ad: "ad",
  "ad id": "adId",
  day: "day",
  date: "day",
  cost: "spend",
  "impr.": "impressions",
  impressions: "impressions",
  clicks: "linkClicks",
  interactions: "clicks",
  ctr: "ctr",
  "avg. cpc": "cpc",
  conversions: "conversions",
  "conv. value": "conversionValue",
  "conversion value": "conversionValue",
  "cost / conv.": "costPerResult",
  "currency code": "currency",
  currency: "currency",
};

/** Which platform the headers are from: Google's own names (Impr., Cost, Conv. value, Ad group) */
function platformOf(headers: string[]): UploadPlatform {
  const n = headers.map(normHeader);
  const google = n.filter((h) => ["impr.", "cost", "conv. value", "ad group", "cost / conv.", "avg. cpc", "conversions", "currency code"].includes(h)).length;
  const meta = n.filter((h) => ["campaign name", "amount spent", "reporting starts", "result indicator", "link clicks", "ad set name"].includes(h)).length;
  return google > meta ? "google" : "meta";
}

/** What each header is read as: the mapping (the AI's, for odd headers) first, then the platform's own names */
export function mapHeaders(headers: string[], platform: UploadPlatform, mapping?: Record<string, string | null> | null): (UploadKey | null)[] {
  const table = platform === "google" ? GOOGLE : META;
  const taken = new Set<UploadKey>();
  return headers.map((h) => {
    const m = mapping?.[h];
    const fromAi = m && (UPLOAD_KEYS as readonly string[]).includes(m) ? (m as UploadKey) : null;
    const n = normHeader(h);
    const key = fromAi ?? table[n] ?? (/^amount spent/.test(n) ? "spend" : null);
    // The first column for a key wins (a second "Campaign name" never overwrites the first)
    if (!key || taken.has(key)) return null;
    taken.add(key);
    return key;
  });
}

// ─── Cells ────────────────────────────────────────────────────────────────

/** CSV (or tab or semicolon separated) text into rows of cells: quotes, doubled quotes, line breaks inside quotes, a BOM */
export function splitCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 6).find((l) => l.trim()) ?? "";
  const count = (c: string) => first.split(c).length - 1;
  const sep = count("\t") > count(",") && count("\t") >= count(";") ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
}

/** A number as an export writes it: "$1,234.56", "1.234,56 €", "12.5%", "--" (none) */
export function readNumber(raw: string | null | undefined): number | null {
  let s = String(raw ?? "").trim();
  if (!s || /^(-+|—|–|n\/?a|none|null)$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()]/g, "").replace(/^-/, "").replace(/[$€£¥₹%\s ]|[A-Z]{3}$|^[A-Z]{3}/g, "");
  // European: 1.234,56 or 12,5
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};

/** A date as an export writes it: 2026-11-09, 2026/11/09, 11/09/2026, Nov 9, 2026, Mon, November 9, 2026 */
export function readDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mo < 0 ? null : ymd(+m[3], mo + 1, +m[2]);
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mo < 0 ? null : ymd(+m[3], mo + 1, +m[1]);
  }
  return null;
}

/** The date range written in a title line above the headers ("November 9, 2026 - November 15, 2026") */
function rangeInTitle(lines: string[][]): { start: string; end: string } | null {
  for (const l of lines) {
    const text = l.join(" ");
    const parts = text.split(/\s+(?:-|–|—|to)\s+/);
    if (parts.length < 2) continue;
    const a = readDate(parts[0].replace(/^.*?(?=[A-Za-z]{3,9}\.?\s+\d|\d{4}-|\d{1,2}\/)/, ""));
    const b = readDate(parts[1]);
    if (a && b && a <= b) return { start: a, end: b };
  }
  return null;
}

// ─── The file ─────────────────────────────────────────────────────────────

// "Total", "Total: Account" (Google), "Results from 12 campaigns" (Ads Manager); never a campaign named "Total Body Fitness"
const isTotal = (s: string | null | undefined) => /^(total|totals|grand total|account total)(:.*)?$|^results from \d/i.test(String(s ?? "").trim());

/**
 * Reads an export. The header row is the first of the top lines that names at least two known columns (Google writes a
 * title and a date range above it). Rows without a name where others have one, and totals rows, are skipped. Range
 * totals take their dates from Reporting starts and ends (or the title line); a Day column makes it a daily file.
 */
export function parseAdsCsv(text: string, mapping?: Record<string, string | null> | null): ParsedUpload {
  const lines = splitCsv(text);
  let at = 0;
  let platform: UploadPlatform = "meta";
  let keys: (UploadKey | null)[] = [];
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const p = platformOf(lines[i]);
    const k = mapHeaders(lines[i], p, mapping);
    if (k.filter(Boolean).length >= 2 || (mapping && k.some(Boolean))) {
      at = i;
      platform = p;
      keys = k;
      break;
    }
  }
  const headers = (lines[at] ?? []).map((h, i) => ({ header: h, key: keys[i] ?? null }));
  const col = (k: UploadKey) => keys.indexOf(k);
  const title = rangeInTitle(lines.slice(0, at));
  const body = keys.length ? lines.slice(at + 1) : [];
  const has = (k: UploadKey) => col(k) >= 0;
  const level: UploadLevel = has("ad") || has("adId") ? "ad" : has("adset") ? "adset" : "campaign";
  const daily = has("day");
  const out: UploadRow[] = [];
  let skipped = 0;
  let currency: string | null = null;
  const named = body.some((r) => ["campaign", "adset", "ad"].some((k) => has(k as UploadKey) && (r[col(k as UploadKey)] ?? "").trim() && !isTotal(r[col(k as UploadKey)])));
  for (const r of body) {
    const cell = (k: UploadKey) => (has(k) ? (r[col(k)] ?? "").trim() : "");
    const names = [cell("campaign"), cell("adset"), cell("ad")];
    // A totals row (Ads Manager's summary line, Google's "Total: Account") or one with no name where the rest have one
    if (r.some((x, i) => i < 3 && isTotal(x)) || names.some(isTotal) || (named && !names.some(Boolean))) {
      skipped++;
      continue;
    }
    const n: UploadNumbers = {};
    keys.forEach((k, i) => {
      if (!k || TEXT_KEYS.has(k)) return;
      const v = readNumber(r[i]);
      if (v != null) (n as Record<string, number>)[k] = v;
    });
    if (!Object.keys(n).length) {
      skipped++;
      continue;
    }
    // Clicks from the rates when only the rates were exported
    if (n.linkClicks == null && n.ctr != null && n.impressions != null) n.linkClicks = Math.round((n.ctr * n.impressions) / 100);
    if (n.linkClicks == null && n.cpc && n.spend != null) n.linkClicks = Math.round(n.spend / n.cpc);
    if (n.results == null && n.costPerResult && n.spend != null) n.results = Math.round((n.spend / n.costPerResult) * 10) / 10;
    if (!currency) {
      const fromCol = cell("currency");
      const fromHeader = headers.find((h) => h.key === "spend")?.header.match(/\(([A-Z]{3})\)/)?.[1];
      currency = (fromCol && /^[A-Z]{3}$/.test(fromCol) ? fromCol : fromHeader) ?? null;
    }
    const date = daily ? readDate(cell("day")) : null;
    const start = date ?? readDate(cell("start")) ?? title?.start ?? null;
    const end = date ?? readDate(cell("end")) ?? title?.end ?? null;
    out.push({
      date,
      start,
      end,
      campaign: names[0] || names[1] || names[2] || (platform === "google" ? "Google Ads" : "All campaigns"),
      campaignId: cell("campaignId") || null,
      adset: names[1] || null,
      ad: names[2] || null,
      adId: cell("adId") || null,
      resultType: resultTypeOf(cell("resultIndicator"), cell("resultType")),
      n,
    });
  }
  const starts = out.map((x) => x.start).filter(Boolean) as string[];
  const ends = out.map((x) => x.end).filter(Boolean) as string[];
  return {
    platform,
    level,
    daily: daily && out.some((x) => x.date),
    start: starts.length ? starts.sort()[0] : null,
    end: ends.length ? ends.sort().at(-1)! : null,
    currency,
    rows: out.slice(0, 20_000),
    headers,
    needsMapping: !keys.includes("spend"),
    skipped,
  };
}

// What "Results" counted, as Meta's action type. The result indicator says it exactly ("actions:offsite_conversion.
// fb_pixel_purchase"); a result type is Ads Manager's name for it ("Website purchases", "Leads (form)").
const RESULT_NAMES: [RegExp, string][] = [
  [/website purchase|^purchases?$/i, "offsite_conversion.fb_pixel_purchase"],
  [/form|on-facebook lead|instant/i, "onsite_conversion.lead_grouped"],
  [/website lead|^leads?$/i, "offsite_conversion.fb_pixel_lead"],
  [/schedul/i, "schedule_total"],
  [/application/i, "submit_application_total"],
  [/registration/i, "complete_registration"],
  [/add(s)? to cart/i, "omni_add_to_cart"],
  [/conversation|messag/i, "onsite_conversion.messaging_conversation_started_7d"],
  [/landing page/i, "landing_page_view"],
  [/link click/i, "link_click"],
  [/thruplay/i, "thruplay"],
  [/post engagement|engagement/i, "post_engagement"],
  [/reach/i, "reach"],
  [/impression/i, "impressions"],
  [/video/i, "video_view"],
];
export function resultTypeOf(indicator: string, name: string): string | null {
  const ind = indicator.trim();
  if (ind) {
    const t = ind.replace(/^[a-z_]+:/, "").trim();
    if (/^[a-z0-9_.]+$/i.test(t)) return t === "video_thruplay_watched_actions" ? "thruplay" : t;
  }
  const n = name.trim();
  if (!n) return null;
  return RESULT_NAMES.find(([re]) => re.test(n))?.[1] ?? null;
}

/** What the result's action type reads as ("Website purchases"), for the campaign's line */
export function resultLabel(type: string | null): string | null {
  if (!type) return null;
  const known: Record<string, string> = {
    "offsite_conversion.fb_pixel_purchase": "Website purchases",
    omni_purchase: "Purchases",
    purchase: "Purchases",
    "onsite_conversion.lead_grouped": "Instant form leads",
    leadgen_grouped: "Instant form leads",
    "offsite_conversion.fb_pixel_lead": "Website leads",
    lead: "Leads",
    schedule_total: "Website schedules",
    submit_application_total: "Website applications submitted",
    complete_registration: "Website registrations completed",
    omni_add_to_cart: "Adds to cart",
    "onsite_conversion.messaging_conversation_started_7d": "Messaging conversations started",
    landing_page_view: "Landing page views",
    link_click: "Link clicks",
    thruplay: "ThruPlays",
    post_engagement: "Post engagement",
    reach: "Reach",
    impressions: "Impressions",
    video_view: "3-second video plays",
  };
  return known[type] ?? null;
}

// ─── Into the rows the reports count ──────────────────────────────────────

/** A daily campaign row as the KPI board stores it (accountRows), with the ad it came from when the file is ad level */
export type FileRow = {
  date: string;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  unique_link_clicks: number;
  actions: Record<string, number>;
  action_values: Record<string, number>;
  updated_at: string;
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
};

/** Every number of a row, as Meta's action types (or Google's conversions), so the KPI's conversion picks what it counts */
function actionsOf(r: UploadRow, platform: UploadPlatform) {
  const n = r.n;
  const actions: Record<string, number> = {};
  const values: Record<string, number> = {};
  const put = (type: string, v: number | undefined) => {
    if (v != null && Number.isFinite(v)) actions[type] = (actions[type] ?? 0) + v;
  };
  if (platform === "google") {
    put("conversions", n.conversions ?? n.results);
    if (n.conversionValue != null) values.conversions = n.conversionValue;
    return { actions, values };
  }
  put("omni_purchase", n.purchases);
  put("offsite_conversion.fb_pixel_purchase", n.websitePurchases);
  if (n.purchaseValue != null) values.omni_purchase = n.purchaseValue;
  if (n.websitePurchaseValue != null) values["offsite_conversion.fb_pixel_purchase"] = n.websitePurchaseValue;
  put("lead", n.leads);
  put("onsite_conversion.lead_grouped", n.fbLeads);
  put("offsite_conversion.fb_pixel_lead", n.websiteLeads);
  put("omni_add_to_cart", n.addsToCart);
  put("offsite_conversion.fb_pixel_add_to_cart", n.websiteAddsToCart);
  put("landing_page_view", n.landingPageViews);
  put("schedule_total", n.schedules);
  put("submit_application_total", n.applications);
  put("complete_registration", n.registrations);
  put("thruplay", n.thruplays);
  put("video_view", n.videoPlays3s);
  put("link_click", n.linkClicks);
  // "Results": under the action type the file says it counted, unless a column of its own already gave that number;
  // with no type, as a result of its own (counted only when the KPI is each campaign's own goal)
  if (n.results != null) {
    const t = r.resultType ?? "csv_result";
    if (actions[t] == null) put(t, n.results);
  }
  return { actions, values };
}

/** The days a file covers, and whether it can stand in for a period: a daily file spanning it, or totals for exactly it */
export function covers(f: Pick<UploadedFile, "daily" | "start" | "end">, p: { start: string; end: string }) {
  if (!f.start || !f.end) return false;
  return f.daily ? f.start <= p.start && f.end >= p.end : f.start === p.start && f.end === p.end;
}

/** The upload a period is built from: the newest one for the platform that covers it */
export function pickUpload(uploads: UploadedFile[] | null | undefined, platform: string, p: { start: string; end: string }): UploadedFile | null {
  const list = (Array.isArray(uploads) ? uploads : []).filter((f) => f && f.platform === platform && covers(f, p));
  return list.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
}

/**
 * A file's rows as the daily campaign rows the reports count. A campaign keeps its id from the file, else the id the
 * synced rows know it by (so the KPI's left-out campaigns and hand-picked results still apply), else one made from its
 * name. Range totals sit on the range's first day. `goals`: each campaign's result, as the file says it counted it.
 */
export function fileRows(f: Pick<UploadedFile, "rows" | "platform" | "daily" | "start" | "end" | "at">, known: { campaign_id?: string | number | null; campaign_name?: string | null }[] = []) {
  const ids = new Map<string, string>();
  for (const k of known) if (k.campaign_name && k.campaign_id != null && !ids.has(k.campaign_name)) ids.set(k.campaign_name, String(k.campaign_id));
  const goals = new Map<string, string[]>();
  const labels = new Map<string, string>();
  const rows: FileRow[] = [];
  for (const r of f.rows) {
    const date = f.daily ? r.date : (r.start ?? f.start);
    if (!date) continue;
    const id = r.campaignId || ids.get(r.campaign) || `file:${r.campaign}`;
    const { actions, values } = actionsOf(r, f.platform);
    if (r.resultType && r.n.results != null && !goals.has(id)) {
      goals.set(id, [r.resultType]);
      const label = resultLabel(r.resultType);
      if (label) labels.set(id, label);
    } else if (!r.resultType && r.n.results != null && !goals.has(id) && f.platform === "meta") goals.set(id, ["csv_result"]);
    const link = r.n.linkClicks ?? 0;
    rows.push({
      date,
      campaign_id: id,
      campaign_name: r.campaign,
      spend: r.n.spend ?? 0,
      impressions: r.n.impressions ?? 0,
      clicks: r.n.clicks ?? link,
      link_clicks: link,
      unique_link_clicks: r.n.uniqueLinkClicks ?? link,
      actions,
      action_values: values,
      updated_at: f.at,
      ...(r.ad || r.adId ? { ad_id: r.adId || `file:${r.campaign}:${r.ad}`, ad_name: r.ad || r.adId || "" } : {}),
      ...(r.adset ? { adset_name: r.adset } : {}),
    });
  }
  return { rows, goals, labels };
}

/** The synced rows with the file's days taken out, and the file's rows in their place */
export function mergeRows<T extends { date: string }>(synced: T[], file: Pick<UploadedFile, "start" | "end">, rows: T[]): T[] {
  if (!file.start || !file.end) return synced;
  return [...synced.filter((r) => r.date < file.start! || r.date > file.end!), ...rows].sort((a, b) => a.date.localeCompare(b.date));
}

// ─── In words ─────────────────────────────────────────────────────────────

const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Nov 9–15", "Oct 28–Nov 3", "Nov 9" */
export function rangeShort(start: string | null, end: string | null) {
  if (!start || !end) return "no dates";
  if (start === end) return short(start);
  return start.slice(0, 7) === end.slice(0, 7) ? `${short(start)}–${Number(end.slice(8))}` : `${short(start)}–${short(end)}`;
}

/** What was read, in one line: "12 campaigns · Nov 9–15 · $2,431 spent" */
export function uploadSummary(f: Pick<ParsedUpload, "rows" | "level" | "start" | "end" | "currency" | "daily">) {
  const what = f.level === "ad" ? "ad" : f.level === "adset" ? "ad set" : "campaign";
  const names = new Set(f.rows.map((r) => (f.level === "ad" ? (r.adId ?? `${r.campaign}/${r.ad}`) : f.level === "adset" ? `${r.campaign}/${r.adset}` : r.campaign)));
  const spend = f.rows.reduce((s, r) => s + (r.n.spend ?? 0), 0);
  const sym = !f.currency || f.currency === "USD" ? "$" : "";
  const money = `${sym}${Math.round(spend).toLocaleString("en-US")}${sym ? "" : ` ${f.currency}`}`;
  return `${names.size} ${what}${names.size === 1 ? "" : "s"} · ${rangeShort(f.start, f.end)}${f.daily ? " by day" : ""} · ${money} spent`;
}
