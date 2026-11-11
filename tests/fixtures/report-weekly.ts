import type { ReportMetrics } from "@/lib/reports/metrics";
import type { Sections } from "@/lib/reports/write";

// Weekly report fixtures. OceanBox's Meta and Google weeks (Nov 2 to 8, 2026) are the real synced numbers: the report as
// drafted, its ads from meta_ad_daily and its five weeks from the daily rows (they match the buyer's own export). The
// TikTok, joint and white label clients are made up, shaped like real accounts.

const period = (label: string, start: string, end: string, p: { spend: number; impressions: number; clicks: number; results: number; revenue?: number; views6s?: number }) => ({
  label,
  start,
  end,
  days: 7,
  spend: p.spend,
  impressions: p.impressions,
  clicks: p.clicks,
  ctr: p.impressions ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null,
  cpc: p.clicks ? Math.round((p.spend / p.clicks) * 100) / 100 : null,
  cpm: p.impressions ? Math.round((p.spend / p.impressions) * 100000) / 100 : null,
  results: p.results,
  costPerResult: p.results ? Math.round((p.spend / p.results) * 100) / 100 : null,
  revenue: p.revenue ?? 0,
  roas: p.revenue && p.spend ? Math.round((p.revenue / p.spend) * 100) / 100 : null,
  ...(p.views6s != null ? { views6s: p.views6s, hookRate: Math.round((p.views6s / p.impressions) * 10000) / 100 } : {}),
});

const week = (label: string, start: string, end: string, spend: number, results: number, revenue = 0, clicks = 0, impressions = 0) => ({ label, start, end, spend, results, costPerResult: results ? Math.round((spend / results) * 100) / 100 : null, revenue, roas: revenue && spend ? Math.round((revenue / spend) * 100) / 100 : null, clicks, impressions });

const base = { kind: "weekly" as const, mtd: null, mtdCompare: null, leftOut: [], dataThrough: "2026-11-09", gaps: [], campaigns: [], topAds: [] };

export const oceanboxMeta: ReportMetrics = {
  ...base,
  platform: "meta",
  conversion: "Purchases",
  roasKpi: false,
  target: 100,
  monthlyBudget: 9000,
  main: { cpc: 2.05, cpm: 35.45, ctr: 1.73, end: "2026-11-08", days: 7, roas: 1.67, label: "Nov 2 – Nov 8", spend: 1683.37, start: "2026-11-02", clicks: 823, results: 12, revenue: 2817.21, impressions: 47488, costPerResult: 140.28 },
  compare: { cpc: 2.84, cpm: 50.13, ctr: 1.76, end: "2026-11-01", days: 7, roas: 1.15, label: "Oct 26 – Nov 1", spend: 1720.49, start: "2026-10-26", clicks: 605, results: 7, revenue: 1970, impressions: 34318, costPerResult: 245.78 },
  campaigns: [
    { id: "120236314521280407", name: "Kaizen | Testing | Recipe | ABO | Sales Campaign | HV", result: "Purchase", spend: 803.65, results: 5, costPerResult: 160.73, roas: 1.49, ctr: 1.91, impressions: 28310, clicks: 542, cpc: 1.48, cpm: 28.39, revenue: 1199.5 },
    { id: "120233816385870407", name: "Kaizen  | CBO | Sales Campaign | {HV > CC| Sept 9} {Relaunched | Sept 8}", result: "Purchase", spend: 696.48, results: 6, costPerResult: 116.08, roas: 2, ctr: 1.29, impressions: 16316, clicks: 210, cpc: 3.32, cpm: 42.69, revenue: 1392.71 },
    { id: "120237521882460407", name: "Kaizen | TOF | ABO | Salmon Lover Box | Jan 9", result: "Purchase", spend: 183.24, results: 1, costPerResult: 183.24, roas: 1.23, ctr: 2.48, impressions: 2862, clicks: 71, cpc: 2.58, cpm: 64.03, revenue: 225 },
  ],
  topAds: [
    { id: "120236318449120407", name: "ID: 17849814834607249  | Lobster | Dec 10", campaign: "Kaizen | Testing | Recipe | ABO | Sales Campaign | HV", spend: 804.22, results: 5, costPerResult: 160.84, ctr: 1.91, clicks: 542, impressions: 28344, cpc: 1.48, revenue: 1199.5, roas: 1.49, link: "https://fb.me/qzB4cKYGdiQu5ek", image: null, format: "Video", active: true },
    { id: "120233817859220407", name: "Instagram Flexible Seafood plan | Oct 7", campaign: "Kaizen  | CBO | Sales Campaign", spend: 233.76, results: 4, costPerResult: 58.44, ctr: 1.12, clicks: 70, impressions: 6267, cpc: 3.34, revenue: 980.21, roas: 4.19, link: "https://fb.me/1WkdsKzLxmAseeF", image: null, format: "Flexible", active: false },
    { id: "120249989965590407", name: "Instagram Flexible Seafood plan | Oct 7 - Copy", campaign: "Kaizen  | CBO | Sales Campaign", spend: 462.98, results: 2, costPerResult: 231.49, ctr: 1.39, clicks: 140, impressions: 10055, cpc: 3.31, revenue: 412.5, roas: 0.89, link: "https://fb.me/239sTlbXhRjSIN3", image: null, format: "Flexible", active: true },
    { id: "120237521882480407", name: "VID | Salmon Lover Box | Jan 9", campaign: "Kaizen | TOF | ABO | Salmon Lover Box | Jan 9", spend: 183.24, results: 1, costPerResult: 183.24, ctr: 2.48, clicks: 71, impressions: 2862, cpc: 2.58, revenue: 225, roas: 1.23, link: null, image: null, format: "Video", active: false },
  ],
  weeks: [
    week("Oct 5–11", "2026-10-05", "2026-10-11", 3497.12, 9),
    week("Oct 12–18", "2026-10-12", "2026-10-18", 1785.1, 6),
    week("Oct 19–25", "2026-10-19", "2026-10-25", 1696.58, 2),
    week("Oct 26–Nov 1", "2026-10-26", "2026-11-01", 1720.49, 7),
    week("Nov 2–8", "2026-11-02", "2026-11-08", 1683.37, 12),
  ],
};

/** The real report's words (as drafted and sent): the narrative stays in the message by default */
export const oceanboxMetaSections: Sections = {
  headline: "Cost per purchase fell 43% vs the week before to $140.28, still 40% over the $100 target",
  summary: "From Nov 2 to Nov 8 we spent $1,683.37 for 12 purchases at $140.28 each and a 1.67 ROAS, against 7 purchases at $245.78 and a 1.15 ROAS the week before.",
  did: ["Adjusted budgets on the two Stage 3 ad sets (Nov 2)", "Duplicated the Instagram Flexible Seafood plan ad, our best ad on cost per purchase (Nov 5)"],
  doing: ["Moving budget toward the Sales CBO, where the Flexible Seafood plan ad brought 4 purchases at $58.44"],
  next: ["Launch the approved box statics as a creative testing ad set on a controlled budget", "Confirm your margin on a typical order so we can set one breakeven cost per purchase"],
  highlights: [],
  stories: [],
};

export const oceanboxGoogle: ReportMetrics = {
  ...base,
  platform: "google",
  conversion: "Conversions",
  roasKpi: false,
  target: 90,
  monthlyBudget: 12000,
  main: { cpc: 0.8, cpm: 17.93, ctr: 2.24, end: "2026-11-08", days: 7, roas: 1.5, label: "Nov 2 – Nov 8", spend: 3890.73, start: "2026-11-02", clicks: 4860, results: 22, revenue: 5847.91, impressions: 217055, costPerResult: 177.15 },
  compare: { cpc: 0.95, cpm: 18.89, ctr: 1.99, end: "2026-11-01", days: 7, roas: 1.93, label: "Oct 26 – Nov 1", spend: 2816.24, start: "2026-10-26", clicks: 2966, results: 19, revenue: 5444.91, impressions: 149107, costPerResult: 148.22 },
  campaigns: [
    { name: "PMax | Colossal Shrimp Offer | Kaizen", spend: 965.96, results: 4, costPerResult: 241.49, roas: 1.08, ctr: 2.22, clicks: 871, impressions: 39228, cpc: 1.11, revenue: 1045.75 },
    { name: "CORE | PMax | Non Brand | Full Funnel | Kaizen", spend: 916.35, results: 0, costPerResult: null, roas: null, ctr: 3.86, clicks: 2146, impressions: 55601, cpc: 0.43, revenue: 0 },
    { name: "SCALE | Pmax | Feed Only | All Product | Kaizen", spend: 859.71, results: 5, costPerResult: 171.94, roas: 1.9, ctr: 1.32, clicks: 686, impressions: 51852, cpc: 1.25, revenue: 1632.77 },
    { name: "Shopping | NB | All Products | Kaizen", spend: 548.27, results: 3, costPerResult: 185.04, roas: 1.88, ctr: 1.42, clicks: 557, impressions: 39170, cpc: 0.98, revenue: 1031.64 },
    { name: "PMax | Built Your Own Box | Kaizen", spend: 278.99, results: 2, costPerResult: 139.49, roas: 1.39, ctr: 2.19, clicks: 317, impressions: 14481, cpc: 0.88, revenue: 388.9 },
    { name: "Shopping | Wild Chilean Sea Bass Portions | KZN", spend: 173, results: 1, costPerResult: 173, roas: 1.71, ctr: 1.39, clicks: 179, impressions: 12879, cpc: 0.97, revenue: 295.95 },
    { name: "CORE | Search | Brand | Kaizen", spend: 79.38, results: 6, costPerResult: 13.23, roas: 15.92, ctr: 36.9, clicks: 69, impressions: 187, cpc: 1.15, revenue: 1263.9 },
    { name: "Pmax | Feed Only | Norwegian Salmon | Kaizen", spend: 31.66, results: 1, costPerResult: 31.66, roas: 5.97, ctr: 0.74, clicks: 11, impressions: 1494, cpc: 2.88, revenue: 189 },
  ],
  weeks: [
    week("Oct 5–11", "2026-10-05", "2026-10-11", 1977.26, 24, 5743.23, 2321, 147589),
    week("Oct 12–18", "2026-10-12", "2026-10-18", 1665.98, 10, 2539.68, 2271, 128974),
    week("Oct 19–25", "2026-10-19", "2026-10-25", 2096.18, 9.9, 2492.3, 2169, 116012),
    week("Oct 26–Nov 1", "2026-10-26", "2026-11-01", 2816.24, 19, 5444.91, 2966, 149107),
    week("Nov 2–8", "2026-11-02", "2026-11-08", 3890.73, 22, 5847.91, 4860, 217055),
  ],
};

/** A Google week with its ad groups and asset groups read (the RSA headline as the creative, PMax pictures) */
export const googleWithUnits: ReportMetrics = {
  ...oceanboxGoogle,
  googleUnits: [
    { id: "ag-1", kind: "ad_group", name: "Brand | Exact", campaign: "CORE | Search | Brand | Kaizen", headline: "OceanBox Seafood Delivery", image: null, spend: 79.38, clicks: 69, impressions: 187, results: 6, revenue: 1263.9 },
    { id: "pg-1", kind: "asset_group", name: "Colossal Shrimp | Offer", campaign: "PMax | Colossal Shrimp Offer | Kaizen", headline: null, image: "fixture:shrimp", spend: 965.96, clicks: 871, impressions: 39228, results: 4, revenue: 1045.75 },
    { id: "pg-2", kind: "asset_group", name: "Build Your Own Box", campaign: "PMax | Built Your Own Box | Kaizen", headline: null, image: "fixture:box", spend: 278.99, clicks: 317, impressions: 14481, results: 2, revenue: 388.9 },
    { id: "ag-2", kind: "ad_group", name: "Wild Sea Bass", campaign: "Shopping | Wild Chilean Sea Bass Portions | KZN", headline: "Wild Chilean Sea Bass Portions", image: null, spend: 173, clicks: 179, impressions: 12879, results: 1, revenue: 295.95 },
  ],
};

// Harbor & Pine Coffee (made up): Meta judged on ROAS, TikTok riding with it in one weekly
export const harborMeta: ReportMetrics = {
  ...base,
  platform: "meta",
  conversion: "Purchases",
  roasKpi: true,
  target: 3,
  monthlyBudget: 12000,
  main: period("Nov 2 – Nov 8", "2026-11-02", "2026-11-08", { spend: 2840.5, impressions: 98210, clicks: 1904, results: 96, revenue: 9375.2 }),
  compare: period("Oct 26 – Nov 1", "2026-10-26", "2026-11-01", { spend: 2702.1, impressions: 91877, clicks: 1650, results: 81, revenue: 7790.4 }),
  topAds: [
    { id: "h1", name: "Morning Ritual | UGC | Oct 30", campaign: "Sales | ASC", spend: 980.4, results: 38, costPerResult: 25.8, ctr: 2.31, clicks: 712, impressions: 30821, revenue: 3920.5, roas: 4.0, link: null, image: "fixture:coffee1", format: "Video", active: true },
    { id: "h2", name: "Single Origin Sampler | Static", campaign: "Sales | ASC", spend: 744.9, results: 27, costPerResult: 27.59, ctr: 1.88, clicks: 498, impressions: 26489, revenue: 2687.3, roas: 3.61, link: null, image: "fixture:coffee2", format: "Static", active: true },
    { id: "h3", name: "Subscribe & Save | Carousel", campaign: "Retargeting", spend: 601.2, results: 21, costPerResult: 28.63, ctr: 2.02, clicks: 401, impressions: 19851, revenue: 1984.1, roas: 3.3, link: null, image: "fixture:coffee3", format: "Carousel", active: true },
    { id: "h4", name: "Founder Story | Video", campaign: "Prospecting", spend: 514.0, results: 10, costPerResult: 51.4, ctr: 1.41, clicks: 293, impressions: 21049, revenue: 783.3, roas: 1.52, link: null, image: "fixture:coffee4", format: "Video", active: false },
  ],
  weeks: [
    week("Oct 5–11", "2026-10-05", "2026-10-11", 2510.2, 70, 6420.4),
    week("Oct 12–18", "2026-10-12", "2026-10-18", 2655.8, 77, 7105.9),
    week("Oct 19–25", "2026-10-19", "2026-10-25", 2600.3, 74, 6890.2),
    week("Oct 26–Nov 1", "2026-10-26", "2026-11-01", 2702.1, 81, 7790.4),
    week("Nov 2–8", "2026-11-02", "2026-11-08", 2840.5, 96, 9375.2),
  ],
};

export const harborTiktok: ReportMetrics = {
  ...base,
  platform: "tiktok",
  conversion: "Purchases",
  roasKpi: false,
  target: 35,
  monthlyBudget: 4000,
  main: period("Nov 2 – Nov 8", "2026-11-02", "2026-11-08", { spend: 912.4, impressions: 141220, clicks: 1288, results: 29, revenue: 2401.6, views6s: 31907 }),
  compare: period("Oct 26 – Nov 1", "2026-10-26", "2026-11-01", { spend: 880.15, impressions: 132004, clicks: 1342, results: 24, revenue: 1977.0, views6s: 26137 }),
  topAds: [
    { id: "t1", name: "POV: your first sip | Creator", campaign: "TT | Conversions", spend: 402.1, results: 15, costPerResult: 26.81, ctr: 0.98, clicks: 612, impressions: 62441, cpc: 0.66, views6s: 16120, hookRate: 25.82, link: null, image: "fixture:tt1", format: "Video", active: true },
    { id: "t2", name: "Pour-over in 30 seconds", campaign: "TT | Conversions", spend: 311.7, results: 10, costPerResult: 31.17, ctr: 0.87, clicks: 418, impressions: 48033, cpc: 0.75, views6s: 10290, hookRate: 21.42, link: null, image: "fixture:tt2", format: "Video", active: true },
    { id: "t3", name: "Bag unboxing | Green screen", campaign: "TT | Conversions", spend: 198.6, results: 4, costPerResult: 49.65, ctr: 0.84, clicks: 258, impressions: 30746, cpc: 0.77, views6s: 5497, hookRate: 17.88, link: null, image: "fixture:tt3", format: "Video", active: false },
  ],
  weeks: [
    week("Oct 5–11", "2026-10-05", "2026-10-11", 760.2, 17),
    week("Oct 12–18", "2026-10-12", "2026-10-18", 805.9, 19),
    week("Oct 19–25", "2026-10-19", "2026-10-25", 842.3, 21),
    week("Oct 26–Nov 1", "2026-10-26", "2026-11-01", 880.15, 24),
    week("Nov 2–8", "2026-11-02", "2026-11-08", 912.4, 29),
  ],
};

// Northside Dental (made up): a white label lead-gen client, judged on leads and cost per lead
export const northsideMeta: ReportMetrics = {
  ...base,
  platform: "meta",
  conversion: "Leads",
  roasKpi: false,
  target: 45,
  monthlyBudget: 3000,
  main: period("Nov 2 – Nov 8", "2026-11-02", "2026-11-08", { spend: 702.3, impressions: 38410, clicks: 512, results: 17 }),
  compare: period("Oct 26 – Nov 1", "2026-10-26", "2026-11-01", { spend: 688.9, impressions: 36980, clicks: 534, results: 19 }),
  topAds: [
    { id: "n1", name: "Free Whitening Consult | Static", campaign: "Leads | Instant Form", spend: 301.4, results: 9, costPerResult: 33.49, ctr: 1.52, clicks: 241, impressions: 15855, link: null, image: "fixture:dent1", format: "Static", active: true },
    { id: "n2", name: "Invisalign Q&A | Video", campaign: "Leads | Instant Form", spend: 254.2, results: 6, costPerResult: 42.37, ctr: 1.21, clicks: 168, impressions: 13884, link: null, image: "fixture:dent2", format: "Video", active: true },
    { id: "n3", name: "New Patient Special | Carousel", campaign: "Leads | Instant Form", spend: 146.7, results: 2, costPerResult: 73.35, ctr: 1.18, clicks: 103, impressions: 8671, link: null, image: "fixture:dent3", format: "Carousel", active: false },
  ],
  weeks: [
    week("Oct 5–11", "2026-10-05", "2026-10-11", 640.5, 14),
    week("Oct 12–18", "2026-10-12", "2026-10-18", 671.2, 16),
    week("Oct 19–25", "2026-10-19", "2026-10-25", 655.8, 21),
    week("Oct 26–Nov 1", "2026-10-26", "2026-11-01", 688.9, 19),
    week("Nov 2–8", "2026-11-02", "2026-11-08", 702.3, 17),
  ],
};

export const emptySections: Sections = { headline: "", summary: "", did: [], doing: [], next: [], highlights: [], stories: [] };
