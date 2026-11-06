// Launch sheets: the plan of ads a buyer (or a client) writes in a spreadsheet or PDF, read into one shape whatever the
// file looked like, so the Media Buyer can check it against the ad account, ask what only the buyer can answer, and
// push what's agreed. Shared by the server and the chat card (no server code here).

import type { LandingSet } from "@/lib/landing-pages-core";

/** One cell of a sheet, from any source: its text, the links inside it, its background color (null: none/white) */
export type Cell = { text: string; links: string[]; color: string | null };
/** A sheet as rows of cells (PDF pages one after another; an XLSX's first sheet with rows; a CSV) */
export type Grid = { rows: Cell[][]; source: "pdf" | "xlsx" | "csv" | "gsheet"; pages?: number };

/** What a column holds, by its header */
export type ColumnRole =
  | "date"
  | "end_date"
  | "page"
  | "access"
  | "geo"
  | "creative"
  | "headline"
  | "primary"
  | "description"
  | "link"
  | "cta"
  | "audience"
  | "budget"
  | "placement"
  | "status"
  | "notes"
  | "campaign"
  | "adset"
  | "ad_name"
  | "other";

export type Column = { index: number; header: string; role: ColumnRole; n: number | null };

/** One budget period from the sheet: a total for the period (not a daily amount unless the sheet says so) */
export type BudgetPeriod = { label: string; start: string | null; end: string | null; amount: number | null };
export type BudgetTier = { platform: string; periods: BudgetPeriod[] };

export type CopyOption = { headline: string; primary: string; description: string };

/** A creative as the sheet names it: its name and every link behind it (Drive files or folders, a post) */
export type CreativeRef = { name: string; links: string[] };

export type LaunchRow = {
  /** Position among the sheet's data rows (0-based), how every later step refers to it */
  index: number;
  dateText: string;
  date: string | null;
  endDate: string | null;
  page: string;
  access: string;
  geo: string;
  creative: CreativeRef;
  /** An existing Instagram or Facebook post the row runs as is (its URL), instead of new creative */
  existingPost: string | null;
  copy: CopyOption[];
  link: string | null;
  cta: string;
  audience: string;
  /** The row's background color as a word ("red", "green", "yellow"), when it has one: its meaning is asked */
  color: string | null;
  colorHex: string | null;
  /** Footnotes the row points to ([2]) */
  notes: number[];
  /** Any other column, by its header */
  extra: Record<string, string>;
};

export type LaunchSheet = {
  title: string;
  event: { name: string; dateText: string; date: string | null; link: string | null; location: string };
  goal: string;
  totalBudget: number | null;
  spentToDate: number | null;
  spentThrough: string | null;
  budgets: BudgetTier[];
  columns: Column[];
  rows: LaunchRow[];
  footnotes: { n: number; text: string }[];
  /** Header lines that didn't fit a known field */
  facts: { label: string; value: string }[];
  /** How the table was found: "layout" (read from the file's own structure) or "model" (the model read it) */
  via: "layout" | "model";
  warnings: string[];
};

// ─── What the system checked (resolution) ────────────────────────────────────────────────────────────────────────

export type CheckLevel = "ok" | "warn" | "fail" | "info";
export type CheckItem = { key: string; label: string; level: CheckLevel; detail: string; fix?: string | null; rows?: number[] };

export type ResolvedPage = { name: string; pageId: string | null; pageName: string | null; igId: string | null; igName: string | null; canAdvertise: boolean; how: string | null; rows: number[] };
export type ResolvedFile = { id: string; name: string; mime: string; aspect: "4x5" | "9x16" | "1x1" | "16x9" | "other"; kind: "image" | "video"; width: number | null; height: number | null; thumb: string | null; bytes: number | null };
export type ResolvedCreative = { row: number; name: string; files: ResolvedFile[]; picked: { feed: string | null; vertical: string | null }; missing: ("4x5" | "9x16")[]; error: string | null };
export type ResolvedPost = { row: number; url: string; platform: "instagram" | "facebook"; shortcode: string | null; mediaId: string | null; igId: string | null; pageId: string | null; storyId: string | null; error: string | null };
export type ResolvedGeo = { text: string; key: string | null; name: string | null; type: string | null; region: string | null; country: string | null; rows: number[] };
/** related: not named like the sheet's event, but live in the account (offered as a place to add to, or an ad set to copy) */
export type ExistingMatch = { level: "campaign" | "adset"; id: string; name: string; status: string; campaignId?: string | null; dailyBudget: number | null; lifetimeBudget: number | null; spend: number | null; related?: boolean };

export type Resolution = {
  account: string | null;
  pages: ResolvedPage[];
  creatives: ResolvedCreative[];
  posts: ResolvedPost[];
  geos: ResolvedGeo[];
  pixel: { id: string; name: string; lastFired: string | null; purchaseRecent: boolean | null; domainSeen: boolean | null } | null;
  existing: ExistingMatch[];
  spend: { matched: number | null; sheet: number | null };
  checks: CheckItem[];
  at: string;
  /** The client's pages the ads can send people to (src/lib/landing-pages.ts) */
  landing?: LandingSet | null;
};

// ─── The conversation ────────────────────────────────────────────────────────────────────────────────────────────

/** A question only the buyer can answer, with the Media Buyer's proposed default and why */
export type LaunchQuestion = {
  key: string;
  question: string;
  why: string;
  proposal: string;
  options: string[];
  required: boolean;
  answer: string | null;
  /** A short name to show for an option whose value is long (a landing page's full link → "Seafood box") */
  labels?: Record<string, string>;
};

// ─── The plan (line items) ───────────────────────────────────────────────────────────────────────────────────────

export type BudgetSpec = { type: "daily" | "lifetime"; amount: number; schedules?: { start: string; end: string; amount: number }[] };
export type Targeting = {
  countries: string[];
  cities: { key: string; name: string; radius: number; unit: "mile" | "kilometer" }[];
  regions: { key: string; name: string }[];
  zips: string[];
  ageMin: number;
  ageMax: number;
  advantageAudience: boolean;
};

export type PlanCampaign = {
  key: string;
  mode: "new" | "existing";
  existingId: string | null;
  name: string;
  objective: string;
  specialAdCategories: string[];
  /** Advantage campaign budget (on the campaign), or null when each ad set holds its own */
  budget: BudgetSpec | null;
  start: string | null;
  end: string | null;
};

export type PlanAdset = {
  key: string;
  campaignKey: string;
  mode: "new" | "existing";
  existingId: string | null;
  name: string;
  optimizationGoal: string;
  pixelId: string | null;
  event: string | null;
  budget: BudgetSpec | null;
  start: string | null;
  end: string | null;
  targeting: Targeting;
  placements: "advantage" | "feeds_stories_reels";
  /** A new ad set copied from this existing one (Kaizen's launcher rule): its targeting, pixel, event and optimization */
  cloneFrom?: string | null;
  /** What was read from it when the plan was laid out (used instead of `targeting` and the pixel) */
  cloned?: { targeting: Record<string, unknown>; promotedObject: Record<string, unknown> | null; optimizationGoal: string; billingEvent: string; name: string } | null;
};

export type PlanMedia = { fileId: string; name: string; aspect: string; kind: "image" | "video"; thumb: string | null };

export type PlanAd = {
  key: string;
  adsetKey: string;
  name: string;
  rows: number[];
  identity: { mode: "page" | "partnership"; pageId: string; pageName: string; igId: string | null; partnerPageId: string | null; partnerIgId: string | null; partnerName: string | null };
  source: { kind: "files"; feed: PlanMedia | null; vertical: PlanMedia | null } | { kind: "existing_post"; platform: "instagram" | "facebook"; url: string; mediaId: string | null; storyId: string | null };
  copy: { bodies: string[]; titles: string[]; descriptions: string[] };
  cta: string;
  link: string;
  urlTags: string | null;
};

export type LaunchPlan = {
  account: string;
  /** Created ACTIVE with a future start only when the buyer chose a scheduled start in the conversation */
  goLive: "paused" | "scheduled";
  campaigns: PlanCampaign[];
  adsets: PlanAdset[];
  ads: PlanAd[];
  note: string;
};

/** Meta: campaign, adset, media, creative, ad. Google (src/lib/google-launch/core.ts): budget, campaign, targeting, negative, extension, ad_group, keyword, rsa, pmax_asset */
export type ItemKind = "campaign" | "adset" | "media" | "creative" | "ad" | "budget" | "targeting" | "negative" | "extension" | "ad_group" | "keyword" | "rsa" | "pmax_asset";
export type ItemStatus = "planned" | "valid" | "invalid" | "unchecked" | "creating" | "created" | "failed" | "skipped" | "existing";

/** One line of the plan as it's checked and created (a launch_items row) */
export type LaunchItem = {
  key: string;
  kind: ItemKind;
  position: number;
  parentKey: string | null;
  label: string;
  status: ItemStatus;
  metaId: string | null;
  error: string | null;
  help: string | null;
  checked: string | null;
};

export type RunStatus = "reading" | "resolving" | "asking" | "planning" | "checking" | "ready" | "applying" | "applied" | "partial" | "failed" | "set_aside" | "discarded";
