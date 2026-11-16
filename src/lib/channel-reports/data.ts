import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEmailScore } from "@/lib/email-score-load";
import { keyFlowCoverage, shiftDay, type CampaignLite, type DailyRow as EmailDay, type FlowLite } from "@/lib/klaviyo/insights";
import type { DailyRow as SocialDay } from "@/lib/social/insights";
import type { Platform, PostFormat, SocialPost } from "@/lib/social/core";
import { scoreSnapshot, campaignsIn, channelPeriods, emailMetrics, heroImage, platformOfLine, socialMetrics, targetLine, windowsFor, type ChannelKind, type ChannelLine, type EmailMetrics, type SocialMetrics, type TargetRow, type Window } from "./core";

// What a channel report reads: the numbers the client page already shows (klaviyo_* and social_* tables, filled by the
// syncs), gathered for the report's own dates and worked out by core.ts. Read with the admin client, after the caller has
// decided the person may see the client and the line. Nothing here calls Klaviyo or Meta except the preview of an email
// that was never opened (a read of Klaviyo's template, cached), and only for the best few campaigns.

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** The team's target for a client's line, when the targets table exists and has one (an older database has none: no target, no error) */
export async function readTarget(admin: SupabaseClient, clientId: string, line: ChannelLine): Promise<TargetRow | null> {
  try {
    const { data, error } = await admin.from("channel_targets").select("metric, target").eq("client_id", clientId).eq("line", line).maybeSingle();
    if (error || !data) return null;
    const target = Number((data as { target: unknown }).target);
    return Number.isFinite(target) && target > 0 ? { metric: String((data as { metric: unknown }).metric ?? ""), target } : null;
  } catch {
    return null;
  }
}

/** Whether the report's tables exist for a line (its sync migration applied) and the client has numbers in them */
export async function hasNumbers(admin: SupabaseClient, line: ChannelLine, clientId: string, since: string): Promise<boolean> {
  if (line === "email") {
    const [d, c] = await Promise.all([admin.from("klaviyo_daily").select("date", { head: true, count: "exact" }).eq("client_id", clientId).gte("date", since), admin.from("klaviyo_campaigns").select("campaign_id", { head: true, count: "exact" }).eq("client_id", clientId).gte("send_time", `${since}T00:00:00Z`)]);
    return (d.count ?? 0) > 0 || (c.count ?? 0) > 0;
  }
  const [d, p] = await Promise.all([admin.from("social_daily").select("date", { head: true, count: "exact" }).eq("client_id", clientId).gte("date", since), admin.from("social_posts").select("post_id", { head: true, count: "exact" }).eq("client_id", clientId).gte("posted_at", `${since}T00:00:00Z`)]);
  return (d.count ?? 0) > 0 || (p.count ?? 0) > 0;
}

// ─── Email ─────────────────────────────────────────────────────────────────

/** The picture of each of these campaigns' saved emails (the preview is read from Klaviyo once for the best few that have none) */
async function emailImages(admin: SupabaseClient, clientId: string, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const { data } = await admin.from("klaviyo_previews").select("campaign_id, html").eq("client_id", clientId).in("campaign_id", ids);
  const have = new Map((data ?? []).map((r) => [r.campaign_id as string, (r.html as string | null) ?? null]));
  for (const id of ids) if (have.has(id)) out.set(id, heroImage(have.get(id)));
  // The best three with no saved preview: read once (cached by the call), never holding the report up for long
  const missing = ids.filter((id) => !have.has(id) || !have.get(id)).slice(0, 3);
  if (missing.length) {
    const { campaignPreview } = await import("@/lib/klaviyo/store");
    await Promise.all(
      missing.map(async (id) => {
        const got = await within(9_000, campaignPreview(admin, clientId, id).catch(() => null), null);
        if (got && got.ok) out.set(id, heroImage(got.preview.html));
      }),
    );
  }
  return out;
}

/** The email report's numbers for a client over given dates (null when Klaviyo has nothing for the client) */
export async function loadEmailMetrics(admin: SupabaseClient, clientId: string, kind: ChannelKind, main: Window, compare: Window, opts: { images?: boolean } = {}): Promise<EmailMetrics | null> {
  const today = todayET();
  // The trend's eight weeks and the comparison both reach back: the earliest day any of them needs
  const from = [compare.start, shiftDay(main.end, -55)].sort()[0];
  const [{ data: days, error }, { data: camps }, { data: flows }, { data: auds }, { data: conn }, { data: snaps }] = await Promise.all([
    admin.from("klaviyo_daily").select("*").eq("client_id", clientId).gte("date", from).lte("date", today).order("date"),
    admin.from("klaviyo_campaigns").select("*").eq("client_id", clientId).not("send_time", "is", null).gte("send_time", `${shiftDay(compare.start, -1)}T00:00:00Z`).order("send_time", { ascending: false }).limit(600),
    admin.from("klaviyo_flows").select("*").eq("client_id", clientId).order("revenue_30", { ascending: false }).limit(200),
    admin.from("klaviyo_audiences").select("audience_id, kind, name, profile_count").eq("client_id", clientId).eq("kind", "list").order("profile_count", { ascending: false, nullsFirst: false }).limit(10),
    admin.from("klaviyo_connections").select("account_name, currency").eq("client_id", clientId).maybeSingle(),
    admin.from("klaviyo_audience_sizes").select("audience_id, date, profile_count").eq("client_id", clientId).gte("date", shiftDay(main.end, -45)).order("date"),
  ]);
  if (error || (!days?.length && !camps?.length && !flows?.length)) return null;
  const dailyRows: EmailDay[] = (days ?? []).map((d) => ({
    date: d.date as string,
    revenue: num(d.revenue),
    campaignRevenue: num(d.campaign_revenue),
    flowRevenue: num(d.flow_revenue),
    smsRevenue: num(d.sms_revenue),
    sends: num(d.sends),
    recipients: num(d.campaign_recipients) + num(d.flow_recipients),
    campaignsSent: num(d.campaigns_sent),
    storeRevenue: numOrNull(d.store_revenue),
    storeOrders: numOrNull(d.store_orders),
    subscribed: numOrNull(d.subscribed),
    unsubscribed: numOrNull(d.unsubscribed),
  }));
  const campaigns: CampaignLite[] = (camps ?? []).map((c) => ({
    id: c.campaign_id as string,
    name: (c.name as string | null) ?? "(untitled)",
    channel: (c.channel as string | null) ?? "email",
    sendTime: (c.send_time as string | null) ?? null,
    subject: (c.subject as string | null) ?? null,
    recipients: num(c.recipients),
    delivered: num(c.delivered),
    opensUnique: num(c.opens_unique),
    clicksUnique: num(c.clicks_unique),
    unsubscribes: num(c.unsubscribes),
    bounced: num(c.bounced),
    spamComplaints: num(c.spam_complaints),
    revenue: num(c.revenue),
    conversions: num(c.conversions),
    openRate: numOrNull(c.open_rate),
    clickRate: numOrNull(c.click_rate),
  }));
  const flowViews: FlowLite[] = (flows ?? []).map((f) => ({
    id: f.flow_id as string,
    name: (f.name as string | null) ?? "(untitled)",
    status: (f.status as string | null) ?? null,
    trigger: (f.trigger_type as string | null) ?? null,
    revenue30: num(f.revenue_30),
    revenue90: num(f.revenue_90),
    recipients30: num(f.recipients_30),
    recipients90: num(f.recipients_90),
    openRate30: numOrNull(f.open_rate_30),
    clickRate30: numOrNull(f.click_rate_30),
    openRate90: numOrNull(f.open_rate_90),
    clickRate90: numOrNull(f.click_rate_90),
  }));
  // The main list's size, with its growth over the period when the snapshots reach it
  const top = (auds ?? [])[0];
  const hist = (snaps ?? []).filter((s) => s.audience_id === top?.audience_id).map((s) => ({ date: s.date as string, profiles: Number(s.profile_count) }));
  const sentIds = campaignsIn(campaigns, main.start, main.end)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6)
    .map((c) => c.id);
  const images = opts.images === false ? undefined : await emailImages(admin, clientId, sentIds).catch(() => undefined);
  const m = emailMetrics({
    kind,
    main,
    compare,
    today,
    days: dailyRows,
    campaigns,
    flows: flowViews,
    keyFlows: keyFlowCoverage(flowViews),
    profiles: top?.profile_count != null ? Number(top.profile_count) : (hist.at(-1)?.profiles ?? null),
    currency: (conn?.currency as string | null) ?? null,
    account: (conn?.account_name as string | null) ?? null,
    images,
  });
  m.target = targetLine("email", await readTarget(admin, clientId, "email"), { kind, main, revenue: m.now.revenue });
  // The account score, as of now (its own 30 days), so the report can say what is lifting it and what is weighing it down
  const sc = await loadEmailScore(admin, clientId).catch(() => null);
  if (sc) m.score = scoreSnapshot(sc);
  return m;
}

// ─── Social ────────────────────────────────────────────────────────────────

/** The social report's numbers for a client over given dates (null when nothing was read from the linked accounts) */
export async function loadSocialMetrics(admin: SupabaseClient, clientId: string, kind: ChannelKind, main: Window, compare: Window): Promise<SocialMetrics | null> {
  const today = todayET();
  const from = [shiftDay(compare.start, -1), shiftDay(main.end, -55)].sort()[0];
  const [{ data: allDays, error }, { data: allPosts }, { data: link }] = await Promise.all([
    admin.from("social_daily").select("*").eq("client_id", clientId).gte("date", from).lte("date", today).order("date"),
    admin.from("social_posts").select("*").eq("client_id", clientId).gte("posted_at", `${shiftDay(compare.start, -1)}T00:00:00Z`).order("posted_at", { ascending: false, nullsFirst: false }).limit(600),
    admin.from("social_accounts").select("page_name, ig_username, page_id, ig_id").eq("client_id", clientId).maybeSingle(),
  ]);
  // Only the linked accounts' rows (a Page picked before keeps its history, unread)
  const current = (r: { platform: string; account_id?: string | null }) => r.account_id === (r.platform === "facebook" ? link?.page_id : link?.ig_id);
  const dayRows = (allDays ?? []).filter(current);
  const postRows = (allPosts ?? []).filter(current);
  if (error || (!dayRows.length && !postRows.length)) return null;
  const days: SocialDay[] = dayRows.map((d) => ({ platform: d.platform as Platform, date: d.date as string, followers: numOrNull(d.followers), gained: numOrNull(d.follows_gained), lost: numOrNull(d.follows_lost), reach: numOrNull(d.reach), views: numOrNull(d.views), profileViews: numOrNull(d.profile_views), engaged: numOrNull(d.accounts_engaged), interactions: numOrNull(d.interactions) }));
  const posts: SocialPost[] = postRows.map((p) => ({ id: p.post_id as string, platform: p.platform as Platform, format: ((p.format as string | null) ?? "image") as PostFormat, caption: (p.caption as string | null) ?? null, permalink: (p.permalink as string | null) ?? null, thumbnail: (p.thumbnail_url as string | null) ?? null, postedAt: (p.posted_at as string | null) ?? null, likes: numOrNull(p.likes), comments: numOrNull(p.comments), shares: numOrNull(p.shares), saves: numOrNull(p.saves), reach: numOrNull(p.reach), views: numOrNull(p.views), interactions: numOrNull(p.interactions), insightsOk: Boolean(p.insights_ok) }));
  const m = socialMetrics({ kind, main, compare, days, posts, names: { instagram: (link?.ig_username as string | null) ? `@${link!.ig_username}` : null, facebook: (link?.page_name as string | null) ?? null } });
  m.target = targetLine("social", await readTarget(admin, clientId, "social"), { kind, main, rate: m.now.rate, followers: m.now.followers, reach: m.now.reach });
  return m;
}

/** A report's numbers for its line, for given dates */
export async function loadChannelMetrics(admin: SupabaseClient, platform: "klaviyo" | "social", clientId: string, kind: ChannelKind, period: { start: string; end: string }, opts: { images?: boolean } = {}) {
  const w = windowsFor(kind, period, todayET());
  return platform === "klaviyo" ? loadEmailMetrics(admin, clientId, kind, w.main, w.compare, opts) : loadSocialMetrics(admin, clientId, kind, w.main, w.compare);
}

/** The dates a report of this kind is drafted for today */
export const periodsToday = (kind: ChannelKind) => channelPeriods(kind, todayET());
export { platformOfLine };
