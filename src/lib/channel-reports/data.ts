import "server-only";
import { providerHasFlows, providerName } from "@/lib/email-providers/core";
import { emailConnection } from "@/lib/email-providers/which";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEmailScore } from "@/lib/email-score-load";
import { keyFlowCoverage, shiftDay, type CampaignLite, type DailyRow as EmailDay, type FlowLite } from "@/lib/klaviyo/insights";
import type { DailyRow as SocialDay } from "@/lib/social/insights";
import type { Platform, PostFormat, SocialPost } from "@/lib/social/core";
import { upcomingItems, type FlowDay, type Upcoming } from "./email-detail";
import { scoreSnapshot, campaignsIn, channelPeriods, emailMetrics, heroImage, platformOfLine, socialMetrics, targetLine, windowsFor, type ChannelKind, type ChannelLine, type EmailMetrics, type MetricSide, type SocialMetrics, type TargetRow, type Window } from "./core";
import { conversionMetricsOf, revenueTarget, type ConversionMetric } from "@/lib/email-metrics";
import { monthSoFar } from "@/lib/reports/period";
import { locationBreakdown, type LocationBreakdown, type LocationRow } from "@/lib/klaviyo/locations";
import { mirroredOverlap, revenueSources } from "./email-sources";
import { campaignPicks } from "./email-cards";

// What a channel report reads: the numbers the client page already shows (klaviyo_* and social_* tables, filled by the
// syncs), gathered for the report's own dates and worked out by core.ts. Read with the admin client, after the caller has
// decided the person may see the client and the line. Nothing here calls Klaviyo or Meta except the preview of an email
// that was never opened (a read of Klaviyo's template, cached), and only for the best few campaigns.

const num = (v: unknown) => Number(v ?? 0) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);
/** The earliest day a report needs: its comparison's first day, or (a weekly) the same days last month's first, whichever is earlier */
const reachBack = (kind: ChannelKind, main: Window, compare: Window) => (kind === "weekly" ? [compare.start, monthSoFar(main.end).mtdCompare.start].sort()[0] : compare.start);
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

/** Each flow's numbers per day over the dates (null while klaviyo_flow_daily isn't there or holds nothing for them) */
async function readFlowDays(admin: SupabaseClient, clientId: string, from: string, to: string): Promise<FlowDay[] | null> {
  const out: FlowDay[] = [];
  // Paged: a month and the one before across a few dozen flows passes a single page
  for (let at = 0; at < 20_000; at += 1000) {
    const { data, error } = await admin.from("klaviyo_flow_daily").select("flow_id, date, recipients, delivered, opens_unique, clicks_unique, conversions, revenue").eq("client_id", clientId).gte("date", from).lte("date", to).order("date").order("flow_id").range(at, at + 999);
    if (error) return null;
    for (const r of data ?? []) out.push({ flowId: r.flow_id as string, date: r.date as string, recipients: num(r.recipients), delivered: num(r.delivered), opensUnique: num(r.opens_unique), clicksUnique: num(r.clicks_unique), conversions: num(r.conversions), revenue: num(r.revenue) });
    if ((data ?? []).length < 1000) break;
  }
  return out.length ? out : null;
}

/** What's dated after the period: campaigns scheduled in Klaviyo, and the campaigns the team planned or suggested (email_suggestions) */
async function readUpcoming(admin: SupabaseClient, clientId: string, after: string, camps: Record<string, unknown>[]): Promise<Upcoming[]> {
  const until = shiftDay(after, 21);
  const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const scheduled: Upcoming[] = camps
    .filter((c) => c.send_time && !num(c.recipients) && !/cancel|draft/i.test(String(c.status ?? "")))
    .map((c) => ({ date: etDay(String(c.send_time)), title: String(c.name ?? "").trim(), source: "klaviyo" as const }));
  const { data, error } = await admin.from("email_suggestions").select("title, send_on, status").eq("client_id", clientId).in("status", ["new", "in_motion", "done"]).gt("send_on", after).lte("send_on", until).limit(30);
  const planned: Upcoming[] = error ? [] : (data ?? []).map((s) => ({ date: String(s.send_on), title: String(s.title ?? "").trim(), source: s.status === "new" ? ("idea" as const) : ("planned" as const) }));
  return upcomingItems([...scheduled, ...planned], after);
}

/** The email report's numbers for a client over given dates (null when Klaviyo has nothing for the client) */
export async function loadEmailMetrics(admin: SupabaseClient, clientId: string, kind: ChannelKind, main: Window, compare: Window, opts: { images?: boolean } = {}): Promise<EmailMetrics | null> {
  const today = todayET();
  // The trend's eight weeks and the comparison both reach back: the earliest day any of them needs
  const back = reachBack(kind, main, compare);
  const from = [back, shiftDay(main.end, -55)].sort()[0];
  const [{ data: days, error }, { data: camps }, { data: flows }, { data: auds }, { data: conn }, { data: snaps }] = await Promise.all([
    admin.from("klaviyo_daily").select("*").eq("client_id", clientId).gte("date", from).lte("date", today).order("date"),
    admin.from("klaviyo_campaigns").select("*").eq("client_id", clientId).not("send_time", "is", null).gte("send_time", `${shiftDay(back, -1)}T00:00:00Z`).order("send_time", { ascending: false }).limit(600),
    admin.from("klaviyo_flows").select("*").eq("client_id", clientId).order("revenue_30", { ascending: false }).limit(200),
    admin.from("klaviyo_audiences").select("audience_id, kind, name, profile_count").eq("client_id", clientId).eq("kind", "list").order("profile_count", { ascending: false, nullsFirst: false }).limit(10),
    emailConnection(admin, clientId).then((c) => ({ data: c ? { account_name: c.account, currency: c.currency, provider: c.provider, revenue: c.revenueRead } : null })),
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
    conversions: numOrNull(d.conversions),
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
  const inPeriod = campaignsIn(campaigns, main.start, main.end);
  // The best few by revenue, and the best and lowest by revenue per recipient (the report's two campaign cards)
  const picks = campaignPicks(inPeriod.map((c) => ({ ...c, orders: c.conversions, channel: c.channel === "sms" ? ("sms" as const) : ("email" as const) })), { currency: null, revenueMeasured: conn ? conn.revenue : true });
  const sentIds = [...new Set([...(picks ? [picks.best.row.id, picks.lowest.row.id] : []), ...[...inPeriod].sort((a, b) => b.revenue - a.revenue).slice(0, 6).map((c) => c.id)])];
  const [images, flowDays, upcoming] = await Promise.all([
    opts.images === false ? undefined : emailImages(admin, clientId, sentIds).catch(() => undefined),
    readFlowDays(admin, clientId, compare.start, main.end),
    readUpcoming(admin, clientId, main.end, camps ?? []),
  ]);
  const m = emailMetrics({
    kind,
    main,
    compare,
    today,
    days: dailyRows,
    campaigns,
    flows: flowViews,
    // A source that doesn't list automations (Brevo) has no key flows to judge
    keyFlows: providerHasFlows(conn?.provider ?? "klaviyo") ? keyFlowCoverage(flowViews) : [],
    source: conn ? providerName(conn.provider) : undefined,
    revenueMeasured: conn ? conn.revenue : true,
    profiles: top?.profile_count != null ? Number(top.profile_count) : (hist.at(-1)?.profiles ?? null),
    currency: (conn?.currency as string | null) ?? null,
    account: (conn?.account_name as string | null) ?? null,
    images,
    flowDays,
    sizes: hist,
    upcoming,
  });
  // The target the board paces against: last month + 10% by itself, a higher one typed on the board wins
  const row = m.revenueMeasured === false ? null : await emailTarget(admin, clientId, main);
  m.target = row ? targetLine("email", row, { kind, main, revenue: m.now.revenue }) : null;
  // The month to date counts against the whole month's target, not a weekly share of it
  if (m.mtd) m.mtd.target = row ? targetLine("email", row, { kind: "monthly", main: m.mtd.window, revenue: m.mtd.now.revenue }) : null;
  // Several metrics counting as the sale: each one's numbers side by side, primary first
  const ranked = await rankedMetrics(admin, clientId);
  if (ranked.length > 1) m.byMetric = await metricSides(admin, clientId, ranked, main, compare).catch(() => null);
  // A multi-location client's orders by restaurant, for the campaigns sent in the period (the report's last section)
  const loc = await locationsFor(admin, clientId, main, compare, campaigns, conn?.currency as string | null).catch(() => undefined);
  if (loc) {
    m.locations = loc.breakdown;
    m.locationAttributed = loc.attributed;
  }
  // Two or more order systems as revenue sources (Toast and a custom POS): each one, and the combined with each order once
  if (m.byMetric && m.revenueMeasured !== false) {
    const ids = ranked.map((x) => x.id);
    const rows = loc?.rows ?? [];
    m.sources = revenueSources({ metrics: ranked, sides: m.byMetric, locations: m.locations ?? null, overlap: { now: mirroredOverlap(rows, ids, main), before: mirroredOverlap(rows, ids, compare) } });
    // The location section's combined line follows the sources' (each order once), not a plain sum
    if (m.sources && m.locations && m.locations.metrics.length > 1) m.locations = { ...m.locations, combined: { conversions: Math.max(0, m.locations.combined.conversions - m.sources.combined.overlap.orders), revenue: Math.max(0, Math.round((m.locations.combined.revenue - m.sources.combined.overlap.revenue) * 100) / 100) }, note: m.sources.note };
  }
  // Order systems email earns through that nobody ranked yet (the sync's weekly check), for the QA
  if (m.revenueMeasured !== false) m.unrankedSources = await unrankedSources(admin, clientId, ranked.map((x) => x.id)).catch(() => []);
  // The account score, as of now (its own 30 days), so the report can say what is lifting it and what is weighing it down
  const sc = await loadEmailScore(admin, clientId).catch(() => null);
  if (sc) m.score = scoreSnapshot(sc);
  return m;
}

/** The month a report counts against: the month its period ends in, and the calendar month before it */
function targetMonth(main: Window) {
  const start = `${main.end.slice(0, 8)}01`;
  const prevEnd = shiftDay(start, -1);
  return { start, prevStart: `${prevEnd.slice(0, 8)}01`, prevEnd };
}

/**
 * The email revenue target as the Email board paces it (src/lib/email-metrics.ts): last month's attributed revenue + 10%,
 * worked out by itself, unless the target typed on the board is higher. Null with neither.
 */
async function emailTarget(admin: SupabaseClient, clientId: string, main: Window): Promise<TargetRow | null> {
  const manual = await readTarget(admin, clientId, "email");
  const t = targetMonth(main);
  const { data, error } = await admin.from("klaviyo_daily").select("revenue").eq("client_id", clientId).gte("date", t.prevStart).lte("date", t.prevEnd).limit(40);
  const last = !error && data?.length ? data.reduce((s, d) => s + num(d.revenue), 0) : null;
  // A manual target on another metric (an older row) stays as it was
  if (manual && !/revenue|sales/i.test(manual.metric)) return manual;
  const rt = revenueTarget(last, manual?.target ?? null);
  return rt.target == null ? null : { metric: "revenue", target: rt.target, source: rt.source };
}

/** The sync's weekly find of order metrics carrying email revenue that aren't ranked (none before its first run) */
async function unrankedSources(admin: SupabaseClient, clientId: string, ranked: string[]): Promise<NonNullable<EmailMetrics["unrankedSources"]>> {
  const { data } = await admin.from("sync_state").select("last_result").eq("source", `klaviyo-sources:${clientId}`).maybeSingle();
  const found = ((data?.last_result as { found?: unknown } | null)?.found ?? []) as NonNullable<EmailMetrics["unrankedSources"]>;
  return Array.isArray(found) ? found.filter((f) => f && typeof f.id === "string" && !ranked.includes(f.id) && Number(f.revenue) > 0) : [];
}

/** The ranked conversion metrics on the connection, primary first ([] before that migration) */
async function rankedMetrics(admin: SupabaseClient, clientId: string): Promise<ConversionMetric[]> {
  const { data, error } = await admin.from("klaviyo_connections").select("conversion_metric_id, conversion_metric_name, conversion_metrics").eq("client_id", clientId).maybeSingle();
  if (error || !data) return [];
  return conversionMetricsOf(data.conversion_metrics, { id: (data.conversion_metric_id as string | null) ?? null, name: (data.conversion_metric_name as string | null) ?? null });
}

/** Each ranked metric's attributed revenue, conversions and store total over the period and the one before (klaviyo_metric_daily) */
async function metricSides(admin: SupabaseClient, clientId: string, metrics: ConversionMetric[], main: Window, compare: Window): Promise<MetricSide[] | null> {
  const from = [main.start, compare.start].sort()[0];
  const { data, error } = await admin.from("klaviyo_metric_daily").select("metric_id, date, revenue, conversions, store_revenue, campaign_revenue, flow_revenue").eq("client_id", clientId).in("metric_id", metrics.map((m) => m.id)).gte("date", from).lte("date", main.end).limit(2000);
  if (error || !data?.length) return null;
  type K = "revenue" | "conversions" | "store_revenue" | "campaign_revenue" | "flow_revenue";
  const sumOf = (id: string, w: Window, k: K) => {
    const rows = data.filter((d) => d.metric_id === id && (d.date as string) >= w.start && (d.date as string) <= w.end);
    if (!rows.length || (k === "store_revenue" && rows.every((d) => d.store_revenue == null))) return null;
    return Math.round(rows.reduce((s, d) => s + num(d[k]), 0) * 100) / 100;
  };
  const pairOf = (id: string, k: K) => ({ now: sumOf(id, main, k), before: sumOf(id, compare, k) });
  return metrics.map((m) => ({ id: m.id, name: m.name, revenue: pairOf(m.id, "revenue"), conversions: pairOf(m.id, "conversions"), store: pairOf(m.id, "store_revenue"), campaignRevenue: pairOf(m.id, "campaign_revenue"), flowRevenue: pairOf(m.id, "flow_revenue") }));
}

/**
 * A flagged client's location breakdown for the campaigns sent in the period, with what Klaviyo attributes to the same
 * campaigns per metric (for the QA's check). Undefined for a client that isn't multi-location.
 */
async function locationsFor(admin: SupabaseClient, clientId: string, main: Window, compare: Window, campaigns: CampaignLite[], currency: string | null): Promise<{ breakdown: LocationBreakdown | null; attributed: Record<string, number>; rows: LocationRow[] } | undefined> {
  const { locationConfig, readLocationRowsIn } = await import("@/lib/klaviyo/location-store");
  const cfg = await locationConfig(admin, clientId);
  if (!cfg) return undefined;
  const sent = campaignsIn(campaigns, main.start, main.end);
  // Every order in the dates by location: campaigns sent then or earlier (still earning) and the flows
  // Read from the period before too: the sources' combined counts an order both systems recorded once in either period
  const all = await readLocationRowsIn(admin, clientId, cfg.metrics.map((m) => m.id), [compare.start, main.start].sort()[0], main.end);
  const rows = all ? all.filter((r) => r.date >= main.start && r.date <= main.end) : null;
  const sendDay = (c: CampaignLite) => new Date(c.sendTime ?? "").toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const breakdown = rows && rows.length ? locationBreakdown({ metrics: cfg.metrics, rows, campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, sendDay: sendDay(c) })), maxColumns: 6, currency }) : null;
  // The primary's campaign revenue is on the campaigns; the others' in klaviyo_campaign_metrics
  const attributed: Record<string, number> = {};
  const primary = cfg.metrics[0];
  const ids = sent.map((c) => c.id);
  const { data: per } = ids.length ? await admin.from("klaviyo_campaign_metrics").select("metric_id, campaign_id, revenue").eq("client_id", clientId).in("campaign_id", ids).in("metric_id", cfg.metrics.map((m) => m.id)) : { data: [] };
  for (const m of cfg.metrics) {
    const rowsFor = (per ?? []).filter((r) => r.metric_id === m.id);
    if (rowsFor.length) attributed[m.id] = rowsFor.reduce((s, r) => s + num(r.revenue), 0);
  }
  const ranked = await rankedMetrics(admin, clientId);
  if (primary && ranked[0]?.id === primary.id && attributed[primary.id] == null) attributed[primary.id] = sent.reduce((s, c) => s + c.revenue, 0);
  return { breakdown, attributed, rows: all ?? [] };
}

// ─── Social ────────────────────────────────────────────────────────────────

/** The social report's numbers for a client over given dates (null when nothing was read from the linked accounts) */
export async function loadSocialMetrics(admin: SupabaseClient, clientId: string, kind: ChannelKind, main: Window, compare: Window): Promise<SocialMetrics | null> {
  const today = todayET();
  const back = reachBack(kind, main, compare);
  const from = [shiftDay(back, -1), shiftDay(main.end, -55)].sort()[0];
  const [{ data: allDays, error }, { data: allPosts }, { data: link }] = await Promise.all([
    admin.from("social_daily").select("*").eq("client_id", clientId).gte("date", from).lte("date", today).order("date"),
    admin.from("social_posts").select("*").eq("client_id", clientId).gte("posted_at", `${shiftDay(back, -1)}T00:00:00Z`).order("posted_at", { ascending: false, nullsFirst: false }).limit(600),
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
  const row = await readTarget(admin, clientId, "social");
  m.target = targetLine("social", row, { kind, main, rate: m.now.rate, followers: m.now.followers, reach: m.now.reach });
  if (m.mtd) m.mtd.target = targetLine("social", row, { kind: "monthly", main: m.mtd.window, rate: m.mtd.now.rate, followers: m.mtd.now.followers, reach: m.mtd.now.reach });
  m.score = await (await import("./social-score-report")).socialReportScore(admin, clientId, main.end);
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
