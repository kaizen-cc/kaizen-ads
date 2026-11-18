import type { ConversionMetric, MonthRevenue, RevenueTarget } from "@/lib/email-metrics";
import type { EmailProvider } from "@/lib/email-providers/core";
import type { EmailScoreResult } from "@/lib/email-score-calc";
import type { SocialAccountScore } from "@/lib/social-score";
import type { RateBasis } from "@/lib/social/rate";
import type { ChannelStatus, Line, Month } from "./calc";

// The shapes the Email and Social boards and the Overview pass around (types only, so a browser file can import them).

export type DataState = "connected" | "behind" | "pending" | "failing" | "missing";

export type EmailSupport = {
  campaignRevenue: number;
  flowRevenue: number;
  /** Orders Klaviyo attributes to email and SMS this month */
  orders: number;
  /** All the store's orders this month as Klaviyo sees them (Placed Order), null when not read */
  storeOrders: number | null;
  openRate: number | null;
  clickRate: number | null;
  /** Net new subscribers this month (subscribed minus unsubscribed), null when Klaviyo gave no list metrics */
  listNet: number | null;
  campaignsSent: number;
  lastSendAt: string | null;
};

export type SocialSupport = {
  /** What the main rate is over: reach (the standard), else views, else followers per post (when Meta gave neither); null with no rate */
  rateBasis?: RateBasis | null;
  /** Where the reach came from: Meta's account insights, or the posts added up */
  reachFrom?: "meta" | "posts" | null;
  /** Why a number is missing or filled in ("Meta didn't report reach for this period"), in plain words; empty when nothing needs saying */
  rateNotes?: string[];
  followers: number | null;
  /** Follows gained less lost over the window, null when Meta gave none */
  followersChange: number | null;
  reach: number | null;
  views: number | null;
  interactions: number | null;
  posts: number;
  topPost: { caption: string | null; permalink: string | null; interactions: number; platform: string } | null;
  lastPostAt: string | null;
};

/** One ranked conversion metric's numbers this month, for the sheet's side by side (primary first) */
export type MetricNumbers = ConversionMetric & {
  /** Share of the score's money checks this metric carried (0 to 1; 0 with no data in the last 30 days) */
  weight: number;
  /** This month so far: attributed revenue, conversions, and the store's own total for the metric */
  revenue: number | null;
  conversions: number | null;
  storeRevenue: number | null;
  storeOrders: number | null;
  /** Last 30 days, as the score read them */
  attributed: number | null;
  rpr: number | null;
};

export type ChannelRow = {
  line: Line;
  clientId: string;
  name: string;
  slug: string;
  kaizenId: number | null;
  data: DataState;
  /** Why the numbers aren't coming in, in plain words, and what fixes it */
  problem: { message: string; fix: string } | null;
  /** A read that worked in part: the numbers are shown with this beside them */
  warning: string | null;
  lastSyncedAt: string | null;
  account: string | null;
  /** Email: which provider the numbers come from (Klaviyo, Brevo or Customer.io); null when none is connected */
  provider?: EmailProvider | null;
  /** Email: false when the source reports no revenue, so the revenue goal, graph and money checks are left out */
  revenueMeasured?: boolean;
  /** Email: the Klaviyo metric that counts as the sale (Placed Order, Bought Ticket...), when it was named */
  conversionMetric?: string | null;
  /** Email: the ranked metrics that count as the sale, primary first (empty when only the automatic one is used) */
  conversionMetrics?: ConversionMetric[];
  /** Email: each ranked metric's numbers side by side (only when more than one is picked) */
  metricNumbers?: MetricNumbers[];
  /** Email: the month's revenue target (last month + 10%, or a higher one set by hand); `target` holds what it paces against */
  revenueTarget?: RevenueTarget | null;
  /** Email: the month's attributed revenue (primary metric) day by day, for the scrubbable chart */
  revenue?: MonthRevenue | null;
  /** The target as typed on the board (email: only counts when above the automatic floor) */
  targetManual?: number | null;
  currency: string | null;
  target: number | null;
  targetNote: string | null;
  targetBy: string | null;
  targetAt: string | null;
  canEdit: boolean;
  /** A lead or an exec: may paste or replace the client's Klaviyo key (the client page's rule) */
  canConnect: boolean;
  /** The signed-in person holds a seat on this client in this line */
  mine: boolean;
  status: ChannelStatus;
  ratio: number | null;
  /** Email: attributed revenue so far this month. Social: engagement rate over the basis window */
  value: number | null;
  /** Email: where the month lands at this pace */
  projected: number | null;
  /** Email: last month's total. Social: last month's rate */
  prev: number | null;
  /** Social: the window the rate is read over */
  basis: "month" | "last30";
  /** The chart: email a running total through the month, social a 7 day rate */
  series: (number | null)[];
  /** How many days the chart's x axis spans */
  span: number;
  quietDays: number | null;
  /** Seat by seat, strategist first; pending: named in the Account Overview sheet but not in the app yet */
  team: { name: string; seat: string; pending?: boolean }[];
  email: EmailSupport | null;
  social: SocialSupport | null;
  /** Email: the account score (the main KPI; status is its band). Null for social, or when nothing is read yet */
  score: EmailScoreResult | null;
  /** Social: the account score (0 to 100, every platform and the overall weighted by reach); null for email or nothing read */
  socialScore?: SocialAccountScore | null;
};

export type ChannelBoard = { line: Line; month: Month; rows: ChannelRow[]; targetsReady: boolean };
