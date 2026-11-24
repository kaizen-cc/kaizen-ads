// The client page's Ads tab, the pure part (no database, no keys): every ad running in the client's ad accounts, not
// only the ones wearing out. Each ad's status, its numbers over a window (spend, results and cost per result against
// the client's KPI target, CTR, CPM, frequency with our bands, days running) and the fatigue flag as one signal on it.
// Filters and sorting run on the loaded list (in the browser), so changing a filter never waits on the server.

export type AdPlatform = "meta" | "google" | "tiktok";
export type AdStatus = "active" | "learning" | "limited" | "paused" | "rejected" | "ended";
export type AdFormat = "image" | "video" | "carousel" | "text" | "other";

export const STATUS_LABEL: Record<AdStatus, string> = { active: "Active", learning: "Learning", limited: "Learning limited", paused: "Paused", rejected: "Rejected", ended: "Ended" };
export const RANGES = [7, 14, 30] as const;
export type Range = (typeof RANGES)[number];
export const asRange = (v: unknown): Range => (RANGES.includes(Number(v) as Range) ? (Number(v) as Range) : 7);

/**
 * An ad's status from Meta: its own effective status, then its ad set's learning phase. A delivering ad in an ad set
 * still learning is "learning"; one whose ad set failed to exit learning is "limited".
 */
export function metaStatus(i: { effective_status?: string | null; learning?: string | null }): AdStatus {
  const s = String(i.effective_status ?? "").toUpperCase();
  if (s === "DISAPPROVED" || s === "WITH_ISSUES") return "rejected";
  if (s === "ARCHIVED" || s === "DELETED") return "ended";
  if (s && s !== "ACTIVE" && s !== "IN_PROCESS" && s !== "PENDING_REVIEW" && s !== "PREAPPROVED") return "paused";
  const l = String(i.learning ?? "").toUpperCase();
  if (l === "LEARNING") return "learning";
  if (l === "FAIL") return "limited";
  return "active";
}

/** Google's ad status (ad_group_ad.status and the campaign's) */
export function googleStatus(i: { ad?: string | null; campaign?: string | null; approval?: string | null }): AdStatus {
  if (/DISAPPROVED/i.test(i.approval ?? "")) return "rejected";
  if (/REMOVED/i.test(i.ad ?? "") || /REMOVED/i.test(i.campaign ?? "")) return "ended";
  if (/PAUSED/i.test(i.ad ?? "") || /PAUSED/i.test(i.campaign ?? "")) return "paused";
  return "active";
}

export const isLive = (s: AdStatus) => s === "active" || s === "learning" || s === "limited";

// ─── Frequency, by our bands ────────────────────────────────────────────────

export type FreqBand = { band: "tof" | "mof" | "bof"; label: string; tone: "ok" | "warn" | "bad" };

/**
 * The media-buying bands: under 1.25 is top-of-funnel reach (keep TOF under 1.5), 1.25–2 mid-funnel, over 2 bottom
 * of funnel, where a prospecting ad set has a problem.
 */
export function freqBand(f: number | null | undefined): FreqBand | null {
  if (f == null || !Number.isFinite(f) || f <= 0) return null;
  if (f < 1.25) return { band: "tof", label: "TOF range", tone: "ok" };
  if (f <= 2) return { band: "mof", label: f > 1.5 ? "MOF range, past TOF's 1.5" : "MOF range", tone: f > 1.5 ? "warn" : "ok" };
  return { band: "bof", label: "Over 2: BOF range, a problem for prospecting", tone: "bad" };
}

// ─── One ad, its numbers over the window ───────────────────────────────────

export type AdRow = {
  id: string;
  platform: AdPlatform;
  name: string;
  campaignId: string | null;
  campaign: string | null;
  adsetId: string | null;
  adset: string | null;
  status: AdStatus;
  format: AdFormat;
  thumbnail: string | null;
  headline: string | null;
  spend: number;
  results: number;
  /** Cost per result, or ROAS on a ROAS KPI */
  cpr: number | null;
  ctr: number | null;
  cpm: number | null;
  frequency: number | null;
  impressions: number;
  clicks: number;
  daysRunning: number | null;
  /** Spent in the window (or still live): the default list */
  ranInWindow: boolean;
  /** The fatigue flag, when it's tiring or tired */
  fatigue: { severity: "tiring" | "tired"; why: string } | null;
};

export type DayTotals = { spend: number; results: number; value: number; impressions: number; clicks: number; reach: number };

/** Sum days into one ad's window numbers. Frequency from reach summed by day is a ceiling; good enough for the band. */
export function windowNumbers(days: readonly DayTotals[], roas: boolean): Pick<AdRow, "spend" | "results" | "cpr" | "ctr" | "cpm" | "frequency" | "impressions" | "clicks"> {
  const t = days.reduce((a, d) => ({ spend: a.spend + d.spend, results: a.results + d.results, value: a.value + d.value, impressions: a.impressions + d.impressions, clicks: a.clicks + d.clicks, reach: a.reach + d.reach }), { spend: 0, results: 0, value: 0, impressions: 0, clicks: 0, reach: 0 });
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    spend: r2(t.spend),
    results: Math.round(t.results * 10) / 10,
    cpr: roas ? (t.spend ? r2(t.value / t.spend) : null) : t.results ? r2(t.spend / t.results) : null,
    ctr: t.impressions ? r2((t.clicks / t.impressions) * 100) : null,
    cpm: t.impressions ? r2((t.spend / t.impressions) * 1000) : null,
    frequency: t.reach ? r2(t.impressions / t.reach) : null,
    impressions: t.impressions,
    clicks: t.clicks,
  };
}

/** How an ad's cost per result (or ROAS) sits against the client's KPI target */
export function vsTarget(cpr: number | null, target: number | null, roas: boolean): { pct: number; good: boolean } | null {
  if (cpr == null || target == null || !(target > 0)) return null;
  const pct = roas ? cpr / target - 1 : target / cpr - 1;
  return { pct: Math.round(pct * 100) / 100, good: pct >= 0 };
}

/** Why a fatigue-flagged ad is tiring, in a few words */
export function fatigueWhy(s: { ctrChange: number; cprChange: number | null; freqNow: number; hookChange?: number | null }): string {
  const parts: string[] = [];
  if (s.ctrChange <= -0.15) parts.push(`CTR down ${Math.round(-s.ctrChange * 100)}%`);
  if (s.cprChange != null && s.cprChange >= 0.15) parts.push(`cost per result up ${Math.round(s.cprChange * 100)}%`);
  if (s.hookChange != null && s.hookChange <= -0.15) parts.push(`hook rate down ${Math.round(-s.hookChange * 100)}%`);
  if (s.freqNow > 2) parts.push(`frequency ${s.freqNow.toFixed(1)}`);
  return parts.join(", ") || "Wearing out";
}

// ─── The list: filters, search and sort ────────────────────────────────────

export type AdFilters = { status: "active" | "recent" | "all"; campaign: string | null; tiring: boolean; format: AdFormat | null; q: string };
export const DEFAULT_FILTERS: AdFilters = { status: "active", campaign: null, tiring: false, format: null, q: "" };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The ads to show, by spend (biggest first). active: live now; recent: live or spent in the window; all: everything. */
export function filterAds(ads: readonly AdRow[], f: AdFilters): AdRow[] {
  const q = fold(f.q.trim());
  return ads
    .filter((a) => (f.status === "active" ? isLive(a.status) : f.status === "recent" ? isLive(a.status) || a.ranInWindow : true))
    .filter((a) => !f.campaign || a.campaignId === f.campaign || a.campaign === f.campaign)
    .filter((a) => !f.tiring || Boolean(a.fatigue))
    .filter((a) => !f.format || a.format === f.format)
    .filter((a) => !q || fold(`${a.name} ${a.campaign ?? ""} ${a.adset ?? ""} ${a.headline ?? ""}`).includes(q))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

/** Whole days since an ad started (null when not known) */
export function daysSince(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

/** Meta's ad format from its creative's object type (and a carousel's child cards) */
export function metaFormat(objectType: string | null | undefined, cards = 0, video = false): AdFormat {
  const t = String(objectType ?? "").toUpperCase();
  if (cards > 1) return "carousel";
  if (video || t === "VIDEO") return "video";
  if (t === "PHOTO" || t === "SHARE" || t === "LINK" || t === "STATUS") return "image";
  return t ? "other" : "image";
}
