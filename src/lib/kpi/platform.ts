// The ad platforms a KPI card can be on: Meta and Google Ads, and TikTok (read only). One place for their names, their
// daily tables and what a new card counts, so a third platform doesn't fall through to Meta by accident.

export type KpiPlatform = "meta" | "google" | "tiktok";
export const KPI_PLATFORMS: readonly KpiPlatform[] = ["meta", "google", "tiktok"];

export const asKpiPlatform = (p: unknown): KpiPlatform => (p === "google" ? "google" : p === "tiktok" ? "tiktok" : "meta");

/** "Meta", "Google Ads", "TikTok" */
export const platformLabel = (p: unknown) => (p === "google" ? "Google Ads" : p === "tiktok" ? "TikTok" : "Meta");
/** "Meta", "Google", "TikTok" */
export const platformShort = (p: unknown) => (p === "google" ? "Google" : p === "tiktok" ? "TikTok" : "Meta");

/** Each platform's campaign days (the same shape, so the KPI math is shared) */
export const dailyTable = (p: unknown) => (p === "google" ? "google_campaign_daily" : p === "tiktok" ? "tiktok_campaign_daily" : "meta_campaign_daily");

/** What a new card counts until someone picks */
export const defaultConversion = (p: unknown) => (p === "google" ? "conversions" : p === "tiktok" ? "tiktok_conversions" : "purchases");

/** An ad account id as each platform's days store it: Google's digits, Meta's without act_, TikTok's advertiser id as is */
export const accountKey = (p: unknown, account: string) => (p === "google" ? account.replace(/\D/g, "") : account.replace(/^act_/, "").trim());

/** TikTok is read only: no audits, sprints, launches or changes from Kaizen Ads */
export const readOnlyPlatform = (p: unknown) => p === "tiktok";
