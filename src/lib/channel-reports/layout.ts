import type { Move } from "@/lib/reports/weekly-core";
import { int, money, moveOf, nounOf, pct, rateSub, reachSub, signed, targetSub, type ChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
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
/** More of what the data source returns, any of which can be a tile: the email provider's sends, cadence and list health,
 *  the automated emails' own rates; social's unfollows and net change, and each platform's own numbers ("instagram:reach") */
const EMAIL_MORE = ["sends", "campaignsSent", "cadence", "unsubRate", "spamRate", "bounceRate", "share", "storeRevenue", "joined", "left", "flowRecipients", "flowOpenRate", "flowClickRate", "flowOrderRate"] as const;
const SOCIAL_MORE = ["followerChange", "lost"] as const;
const PER_PLATFORM = ["followers", "reach", "views", "rate", "interactions", "posts", "profileViews"] as const;
const PER_PLATFORM_KEY = /^([a-z_]+):(followers|reach|views|rate|interactions|posts|profileViews)$/;
const PLATFORM_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", youtube: "YouTube", x: "X", threads: "Threads", pinterest: "Pinterest" };
const platformName = (p: string) => PLATFORM_NAME[p] ?? p.replace(/^\w/, (c) => c.toUpperCase());

/** How the picker groups a line's tiles (search finds them by these names too) */
const EMAIL_GROUP: Record<string, string> = { revenue: "Revenue", orders: "Revenue", split: "Revenue", campaignRevenue: "Revenue", flowRevenue: "Revenue", aov: "Revenue", sms: "Revenue", rpr: "Revenue", share: "Revenue", storeRevenue: "Revenue", recipients: "Campaigns", openRate: "Campaigns", clickRate: "Campaigns", orderRate: "Campaigns", sends: "Campaigns", campaignsSent: "Campaigns", cadence: "Campaigns", flowRecipients: "Automated emails", flowOpenRate: "Automated emails", flowClickRate: "Automated emails", flowOrderRate: "Automated emails", subscribers: "List", joined: "List", left: "List", unsubRate: "Deliverability", spamRate: "Deliverability", bounceRate: "Deliverability" };
const SOCIAL_GROUP: Record<string, string> = { followers: "Audience", gained: "Audience", lost: "Audience", followerChange: "Audience", reach: "Reach", views: "Reach", profileViews: "Reach", rate: "Engagement", interactions: "Engagement", engaged: "Engagement", posts: "Publishing" };

/** A tile's group in the picker */
export function tileGroup(m: Metrics, key: string): string {
  const per = key.match(PER_PLATFORM_KEY);
  if (per) return platformName(per[1]);
  return (m.platform === "social" ? SOCIAL_GROUP[key] : EMAIL_GROUP[key]) ?? "More";
}

const EMAIL_COLUMNS = ["date", "channel", "status", "recipients", "open", "click", "orders", "orderRate", "revenue", "rpr"] as const;
const SOCIAL_COLUMNS = ["followers", "change", "reach", "views", "rate", "posts"] as const;

const COLUMN_LABEL: Record<string, string> = { date: "Sent", channel: "Type", status: "Status", recipients: "Recipients", open: "Open", click: "Click", orders: "Orders", orderRate: "Order rate", revenue: "Revenue", rpr: "Per recipient", followers: "Followers", change: "Change", reach: "Reach", views: "Views", rate: "Engage", posts: "Posts" };

/** Every tile a report on this line can show (an older email report without the detail has fewer) */
export function tileOptions(m: Metrics): string[] {
  if (m.platform === "social") {
    // Each platform's own numbers when the account posts on more than one
    const per = (m.platforms ?? []).length >= 2 ? (m.platforms ?? []).flatMap((p) => PER_PLATFORM.map((k) => `${p.platform}:${k}`)) : [];
    const keys = [...new Set<string>([...SOCIAL_TILES, ...SOCIAL_MORE, ...per])];
    return keys.filter((k) => (SOCIAL_TILES as readonly string[]).includes(k) || tileView(m, k) != null);
  }
  const base: string[] = m.detail ? [...EMAIL_TILES] : ["revenue", "campaignRevenue", "flowRevenue", "subscribers", "openRate", "clickRate", "sms", "rpr"];
  // The extra ones only when this report has the numbers for them
  return [...base, ...EMAIL_MORE.filter((k) => tileView(m, k) != null)];
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
  const known = (k: string) => (platform === "social" ? ([...SOCIAL_TILES, ...SOCIAL_MORE] as readonly string[]).includes(k) || PER_PLATFORM_KEY.test(k) : ([...EMAIL_TILES, ...EMAIL_MORE] as readonly string[]).includes(k));
  const tiles = [...new Set((layout?.tiles ?? []).filter((k) => typeof k === "string" && known(k)))].slice(0, MAX_TILES);
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
      case "lost":
        return now.lost == null ? null : tile(key, "Unfollows", int(now.lost), null, int(before.lost), moveOf(now.lost, before.lost, "down"));
      case "followerChange":
        return now.followerChange == null ? null : tile(key, "Net follower change", signed(now.followerChange), now.followers != null ? `${int(now.followers)} followers now` : null, before.followerChange != null ? signed(before.followerChange) : "–", moveOf(now.followerChange, before.followerChange));
      default: {
        // One platform's own number ("instagram:reach")
        const per = key.match(PER_PLATFORM_KEY);
        const p = per ? (m.platforms ?? []).find((x) => x.platform === per[1]) : null;
        if (!per || !p) return null;
        const base = tileView({ ...m, now: p.now, before: p.before, target: null }, per[2]);
        return base ? { ...base, key, label: `${platformName(per[1])} ${base.label.toLowerCase()}`, sub: null } : null;
      }
    }
  }
  const c = m.currency;
  const { now, before } = m;
  const d = m.detail ?? null;
  // A source with no revenue (Customer.io without a purchase event, Brevo without a store) has no money tiles: unmeasured, not zero
  if (m.revenueMeasured === false && ["revenue", "orders", "split", "campaignRevenue", "flowRevenue", "aov", "orderRate", "sms", "rpr", "share", "storeRevenue", "flowOrderRate"].includes(key)) return null;
  switch (key) {
    case "revenue":
      return tile(key, d ? "Revenue from email & SMS" : "Attributed revenue", money(now.revenue, c), targetSub(m.target, c) ?? (now.estimated ? "Added up from campaigns and automated emails" : d ? "Attributed by Klaviyo" : null), money(before.revenue, c), moveOf(now.revenue, before.revenue));
    case "orders": {
      if (!d) return null;
      const aov = d.orders.now ? now.revenue / d.orders.now : null;
      const w = nounOf(m);
      return tile(key, w.title, int(d.orders.now), aov != null ? `${w.average} ${money(aov, c)}` : null, int(d.orders.before), moveOf(d.orders.now, d.orders.before));
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
    case "sends":
      return tile(key, "Messages sent", int(now.sends), "Every email and text", int(before.sends), moveOf(now.sends, before.sends, "none"));
    case "campaignsSent":
      return tile(key, "Campaigns sent", int(now.campaignsSent), null, int(before.campaignsSent), moveOf(now.campaignsSent, before.campaignsSent, "none"));
    case "cadence":
      return tile(key, "Campaigns a week", now.cadence.toFixed(1), null, before.cadence.toFixed(1), moveOf(now.cadence, before.cadence, "none"));
    case "unsubRate":
      return now.unsubscribeRate == null ? null : tile(key, "Unsubscribe rate", pct(now.unsubscribeRate, 2), null, pct(before.unsubscribeRate, 2), moveOf(now.unsubscribeRate, before.unsubscribeRate, "down"));
    case "spamRate":
      return now.spamRate == null ? null : tile(key, "Spam complaint rate", pct(now.spamRate, 3), null, pct(before.spamRate, 3), moveOf(now.spamRate, before.spamRate, "down"));
    case "bounceRate":
      return now.bounceRate == null ? null : tile(key, "Bounce rate", pct(now.bounceRate, 2), null, pct(before.bounceRate, 2), moveOf(now.bounceRate, before.bounceRate, "down"));
    case "share":
      return now.share == null ? null : tile(key, "Share of store revenue", pct(now.share), "Revenue from email and SMS over the store's", pct(before.share), moveOf(now.share, before.share));
    case "storeRevenue":
      return now.storeRevenue == null ? null : tile(key, "Store revenue", money(now.storeRevenue, c), "Every order placed in the store", money(before.storeRevenue, c), moveOf(now.storeRevenue, before.storeRevenue));
    case "joined":
      return d?.subscribers?.joined.now == null ? null : tile(key, "New subscribers", int(d.subscribers.joined.now), null, int(d.subscribers.joined.before), moveOf(d.subscribers.joined.now, d.subscribers.joined.before));
    case "left":
      return d?.subscribers?.left.now == null ? null : tile(key, "Unsubscribed", int(d.subscribers.left.now), null, int(d.subscribers.left.before), moveOf(d.subscribers.left.now, d.subscribers.left.before, "down"));
    case "flowRecipients":
      return d?.flow?.recipients.now == null ? null : tile(key, "Automated email recipients", int(d.flow.recipients.now), null, int(d.flow.recipients.before), moveOf(d.flow.recipients.now, d.flow.recipients.before, "none"));
    case "flowOpenRate":
      return d?.flow?.open.now == null ? null : tile(key, "Automated email open rate", pct(d.flow.open.now), null, pct(d.flow.open.before), moveOf(d.flow.open.now, d.flow.open.before));
    case "flowClickRate":
      return d?.flow?.click.now == null ? null : tile(key, "Automated email click rate", pct(d.flow.click.now, 2), null, pct(d.flow.click.before, 2), moveOf(d.flow.click.now, d.flow.click.before));
    case "flowOrderRate":
      return d?.flow?.orderRate.now == null ? null : tile(key, "Automated email order rate", pct(d.flow.orderRate.now, 2), null, pct(d.flow.orderRate.before, 2), moveOf(d.flow.orderRate.now, d.flow.orderRate.before));
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
