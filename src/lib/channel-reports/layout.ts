import type { Move } from "@/lib/reports/weekly-core";
import { int, money, moveOf, pct, rateSub, reachSub, signed, targetSub, type ChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
import type { Grade } from "./email-detail";

// What an email or social report shows, picked the way an ads report's tiles and columns are: the tiles at the top of
// the PDF (swap one for another, add, remove) and the columns of its tables. Kept on the report (reports.layout) and
// carried to the client's next report on the same line. Pure, so the PDF, the studio and the tests read the same lists.

type Metrics = EmailMetrics | SocialMetrics;

export type ChannelLayout = { tiles?: string[]; columns?: string[]; notes?: boolean };

/** One tile as the PDF draws it: a number with its move, or the email's split box */
export type TileView = { key: string; kind: "stat" | "split"; label: string; value: string; sub: string | null; before?: string; move: Move; badge?: Grade | null };

export const MAX_TILES = 6;

const EMAIL_TILES = ["revenue", "orders", "split", "campaignRevenue", "flowRevenue", "aov", "recipients", "openRate", "clickRate", "orderRate", "subscribers", "sms", "rpr"] as const;
const SOCIAL_TILES = ["followers", "reach", "views", "rate", "interactions", "posts", "profileViews", "engaged", "gained"] as const;

const EMAIL_COLUMNS = ["date", "channel", "status", "recipients", "open", "click", "orders", "orderRate", "revenue", "rpr"] as const;
const SOCIAL_COLUMNS = ["followers", "change", "reach", "views", "rate", "posts"] as const;

const COLUMN_LABEL: Record<string, string> = { date: "Sent", channel: "Type", status: "Status", recipients: "Recipients", open: "Open", click: "Click", orders: "Orders", orderRate: "Order rate", revenue: "Revenue", rpr: "Per recipient", followers: "Followers", change: "Change", reach: "Reach", views: "Views", rate: "Engage", posts: "Posts" };

/** Every tile a report on this line can show (an older email report without the detail has fewer) */
export function tileOptions(m: Metrics): string[] {
  if (m.platform === "social") return [...SOCIAL_TILES];
  if (!m.detail) return ["revenue", "campaignRevenue", "flowRevenue", "subscribers", "openRate", "clickRate", "sms", "rpr"];
  return [...EMAIL_TILES];
}

/** The tiles a report starts with: what the team's own report leads with */
export function defaultTiles(m: Metrics): string[] {
  if (m.platform === "social") return ["followers", "reach", "views", "rate"];
  if (!m.detail) return ["revenue", "campaignRevenue", "flowRevenue", "subscribers"];
  // Revenue per recipient leads with revenue when revenue is tracked (the email team's headline numbers)
  return m.revenueMeasured === false ? ["revenue", "orders", "split"] : ["revenue", "orders", "rpr", "split"];
}

/** The tiles on the page: the ones picked (still offered for this report), else the defaults */
export function tileKeys(m: Metrics, layout?: ChannelLayout | null): string[] {
  const offered = new Set(tileOptions(m));
  const picked = [...new Set((layout?.tiles ?? []).filter((k) => offered.has(k)))].slice(0, MAX_TILES);
  return picked.length ? picked : defaultTiles(m);
}

/** Every table column a report on this line can show */
export const columnOptions = (platform: ChannelPlatform): string[] => (platform === "social" ? [...SOCIAL_COLUMNS] : [...EMAIL_COLUMNS]);
export const columnLabel = (k: string) => COLUMN_LABEL[k] ?? k;

/** The table columns on the page, in the catalog's order: the ones picked, else all of them */
export function columnKeys(platform: ChannelPlatform, layout?: ChannelLayout | null): string[] {
  const all = columnOptions(platform);
  const picked = new Set((layout?.columns ?? []).filter((k) => all.includes(k)));
  return picked.size ? all.filter((k) => picked.has(k)) : all;
}

/** A layout as it's kept: known tiles and columns only, no repeats, within the limits */
export function tidyChannelLayout(platform: ChannelPlatform, layout: ChannelLayout | null | undefined): ChannelLayout {
  const tiles = [...new Set((layout?.tiles ?? []).filter((k) => (platform === "social" ? (SOCIAL_TILES as readonly string[]) : (EMAIL_TILES as readonly string[])).includes(k)))].slice(0, MAX_TILES);
  const columns = [...new Set((layout?.columns ?? []).filter((k) => columnOptions(platform).includes(k)))];
  return { ...(tiles.length ? { tiles } : {}), ...(columns.length ? { columns } : {}), ...(layout?.notes === true ? { notes: true } : {}) };
}

/** A tile swapped for another: one already on the page trades places with it, so nothing shows twice */
export function swapChannelTile(list: string[], i: number, k: string): string[] {
  const out = [...list];
  const j = out.indexOf(k);
  if (j >= 0) [out[i], out[j]] = [out[j], out[i]];
  else out[i] = k;
  return out;
}

const tile = (key: string, label: string, value: string, sub: string | null, before: string | undefined, move: Move, badge?: Grade | null): TileView => ({ key, kind: "stat", label, value, sub, before, move, badge: badge ?? null });

/** One tile's numbers, worked out from the report's metrics (null when this report can't show it) */
export function tileView(m: Metrics, key: string): TileView | null {
  if (m.platform === "social") {
    const { now, before } = m;
    const t = m.target;
    const sub = (re: RegExp) => (t && re.test(t.metric) ? targetSub(t) : null);
    switch (key) {
      case "followers":
        return tile(key, "Followers", int(now.followers), sub(/follower/i) ?? (now.followerChange != null ? `${signed(now.followerChange)} in the period` : null), int(before.followers), moveOf(now.followers, before.followers));
      case "reach":
        return tile(key, "Reach", int(now.reach), reachSub(m, sub(/reach/i)), int(before.reach), moveOf(now.reach, before.reach));
      case "views":
        return tile(key, "Views", int(now.views), null, int(before.views), moveOf(now.views, before.views));
      case "rate":
        return tile(key, "Engagement rate", m.insightsRead ? pct(now.rate) : "–", rateSub(m, sub(/engagement|rate/i)), pct(before.rate), moveOf(now.rate, before.rate));
      case "interactions":
        return tile(key, "Interactions", int(now.interactions), "Likes, comments, shares and saves", int(before.interactions), moveOf(now.interactions, before.interactions));
      case "posts":
        return tile(key, "Posts published", int(now.posts), null, int(before.posts), moveOf(now.posts, before.posts, "none"));
      case "profileViews":
        return tile(key, "Profile visits", int(now.profileViews), null, int(before.profileViews), moveOf(now.profileViews, before.profileViews));
      case "engaged":
        return tile(key, "Accounts engaged", int(now.engaged), null, int(before.engaged), moveOf(now.engaged, before.engaged));
      case "gained":
        return tile(key, "New followers", int(now.gained), now.lost != null ? `${int(now.lost)} unfollowed` : null, int(before.gained), moveOf(now.gained, before.gained));
      default:
        return null;
    }
  }
  const c = m.currency;
  const { now, before } = m;
  const d = m.detail ?? null;
  // A source with no revenue (Customer.io without a purchase event, Brevo without a store) has no money tiles: unmeasured, not zero
  if (m.revenueMeasured === false && ["revenue", "orders", "split", "campaignRevenue", "flowRevenue", "aov", "orderRate", "sms", "rpr"].includes(key)) return null;
  switch (key) {
    case "revenue":
      return tile(key, d ? "Revenue from email & SMS" : "Attributed revenue", money(now.revenue, c), targetSub(m.target, c) ?? (now.estimated ? "Added up from campaigns and automated emails" : d ? "Attributed by Klaviyo" : null), money(before.revenue, c), moveOf(now.revenue, before.revenue));
    case "orders": {
      if (!d) return null;
      const aov = d.orders.now ? now.revenue / d.orders.now : null;
      return tile(key, "Orders", int(d.orders.now), aov != null ? `Average order ${money(aov, c)}` : null, int(d.orders.before), moveOf(d.orders.now, d.orders.before));
    }
    case "split": {
      if (!d) return null;
      const total = now.campaignRevenue + now.flowRevenue;
      const camp = total > 0 ? Math.round((now.campaignRevenue / total) * 100) : null;
      return { key, kind: "split", label: "Campaigns vs automated", value: camp == null ? "–" : `${camp}% / ${100 - camp}%`, sub: null, move: null };
    }
    case "campaignRevenue":
      return tile(key, "Campaign revenue", money(now.campaignRevenue, c), `${int(now.campaignsSent)} ${now.campaignsSent === 1 ? "campaign" : "campaigns"} sent`, money(before.campaignRevenue, c), moveOf(now.campaignRevenue, before.campaignRevenue));
    case "flowRevenue":
      return tile(key, d ? "Automated email revenue" : "Flow revenue", money(now.flowRevenue, c), now.revenue > 0 ? `${Math.round((now.flowRevenue / now.revenue) * 100)}% of email revenue` : null, money(before.flowRevenue, c), moveOf(now.flowRevenue, before.flowRevenue));
    case "aov": {
      if (!d) return null;
      const a = d.orders.now ? now.revenue / d.orders.now : null;
      const b = d.orders.before ? before.revenue / d.orders.before : null;
      return tile(key, "Average order", a == null ? "–" : money(a, c), null, b == null ? "–" : money(b, c), moveOf(a, b));
    }
    case "recipients":
      if (!d) return null;
      return tile(key, "Campaign recipients", int(d.campaign.recipients.now), null, int(d.campaign.recipients.before), moveOf(d.campaign.recipients.now, d.campaign.recipients.before, "none"));
    case "openRate":
      if (!d) return tile(key, "Open rate", pct(now.openRate), null, pct(before.openRate), moveOf(now.openRate, before.openRate));
      return tile(key, "Campaign open rate", pct(d.campaign.open.now), null, pct(d.campaign.open.before), moveOf(d.campaign.open.now, d.campaign.open.before));
    case "clickRate":
      if (!d) return tile(key, "Click rate", pct(now.clickRate, 2), null, pct(before.clickRate, 2), moveOf(now.clickRate, before.clickRate));
      return tile(key, "Campaign click rate", pct(d.campaign.click.now, 2), null, pct(d.campaign.click.before, 2), moveOf(d.campaign.click.now, d.campaign.click.before));
    case "orderRate":
      if (!d) return null;
      return tile(key, "Campaign order rate", pct(d.campaign.orderRate.now, 2), null, pct(d.campaign.orderRate.before, 2), moveOf(d.campaign.orderRate.now, d.campaign.orderRate.before));
    case "subscribers": {
      const sb = d?.subscribers ?? null;
      if (sb && sb.total.now != null) return tile(key, "Email subscribers", int(sb.total.now), sb.joined.now != null ? `${int(sb.joined.now)} joined, ${int(sb.left.now)} left` : null, int(sb.total.before), moveOf(sb.total.now, sb.total.before));
      const net = sb && sb.joined.now != null ? (sb.joined.now ?? 0) - (sb.left.now ?? 0) : m.list.net;
      return tile(key, "List growth", net != null ? signed(net) : "–", m.list.profiles != null ? `${int(m.list.profiles)} profiles in the main lists` : null, "–", null);
    }
    case "sms":
      return tile(key, "SMS revenue", money(now.smsRevenue, c), "Within the revenue from email & SMS", money(before.smsRevenue, c), moveOf(now.smsRevenue, before.smsRevenue));
    case "rpr":
      return tile(key, "Revenue per recipient", now.revenuePerRecipient != null ? cents(now.revenuePerRecipient, c) : "–", "Every email and text sent", before.revenuePerRecipient != null ? cents(before.revenuePerRecipient, c) : "–", moveOf(now.revenuePerRecipient, before.revenuePerRecipient));
    default:
      return null;
  }
}

/** Revenue per recipient with its cents always shown (it's a small number) */
const cents = (n: number, currency: string | null) => `${!currency || currency === "USD" ? "$" : `${currency} `}${n.toFixed(2)}`;

/** A tile's name for a picker (whatever this report's numbers are) */
export function tileLabel(m: Metrics, key: string): string {
  return tileView(m, key)?.label ?? key;
}

/** The tiles on the page, drawn */
export function tileViews(m: Metrics, layout?: ChannelLayout | null): TileView[] {
  return tileKeys(m, layout)
    .map((k) => tileView(m, k))
    .filter((t): t is TileView => Boolean(t));
}
