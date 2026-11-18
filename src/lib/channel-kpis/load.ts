import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import type { EmailBand } from "@/lib/email-score";
import type { EmailScoreResult } from "@/lib/email-score-calc";
import { loadEmailScores } from "@/lib/email-score-load";
import { loadSocialScores, type SocialAccountScore } from "@/lib/social-score-load";
import { DEFAULT_ENGAGEMENT_BAR } from "@/lib/social-score";
import { conversionMetricsOf, monthRevenue, revenueTarget, type ConversionMetric } from "@/lib/email-metrics";
import { socialClientState, plainSocialError } from "@/lib/social/core";
import { partialSyncWarning } from "@/lib/klaviyo/core";
import { emailClientState } from "@/lib/email-providers/core";
import { emailConnections, type EmailConn } from "@/lib/email-providers/which";
import { servicesOf } from "@/lib/services";
import { loadPauses } from "@/lib/account-watch/pauses";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  SERVICE,
  cumulative,
  daysSince,
  engagement,
  etToday,
  judgeEmail,
  judgeSocial,
  monthOf,
  orderForBoard,
  riskOf,
  rollingRate,
  shiftDay,
  socialBasis,
  canSetTarget,
  crewOf,
  crewSeat,
  LINE_SEAT_ROLES,
  type ChannelStatus,
  type Line,
  type Month,
  type Risk,
} from "./calc";
import type { ChannelBoard, ChannelRow, DataState, EmailSupport, MetricNumbers, SocialSupport } from "./types";

// What the Email and Social KPI boards and the email and social Overview read. Everything here reads through the
// signed-in person's session (RLS: the clients they can see), except the Klaviyo connection and the sync notes, which
// are never readable from a browser session and are read with the server's rights for those clients only.
// Nothing reads a paid-ads table.

export type { ChannelBoard, ChannelRow, DataState, EmailSupport, MetricNumbers, SocialSupport } from "./types";

type Me = { id: string; role: string; isExec: boolean; isLead: boolean };

/** The score band as the status the boards and Overview already colour by: green, yellow, red */
const BAND_STATUS: Record<EmailBand, ChannelStatus> = { good: "good", watch: "close", bad: "off" };


const num = (v: unknown) => Number(v ?? 0) || 0;
const etDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

/** Read every row of a query, a thousand at a time (the API caps a request there) */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Every live client of this line the person can see, with this month's main KPI against its target, the supporting
 * numbers, where the data stands and who is on it. Worst first. `me` decides who may set a target (canEdit).
 * Reads degrade, never throw: a table the database doesn't have yet reads as "not connected".
 */
export async function loadChannelBoard(db: SupabaseClient, line: Line, me: Me, only?: string[] | null): Promise<ChannelBoard> {
  const month = monthOf(etToday());
  // `only`: just these clients (the daily recap for someone seated on a few), so nothing else is read
  if (only && !only.length) return { line, month, rows: [], targetsReady: true };
  let q = db.from("clients").select("id, name, slug, status, kaizen_id, services, services_extra, services_removed, channel_sheet").is("archived_at", null).in("status", [...LIVE]);
  if (only) q = q.in("id", only);
  const { data: all } = await q.order("name");
  // A line a lead paused until a date (the account watch's pauses) is left out until then; nothing is deleted
  const paused = await loadPauses(db, SERVICE[line], etToday());
  const clients = (all ?? []).filter((c) => (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes(SERVICE[line]) && !paused.has(c.id as string));
  const ids = clients.map((c) => c.id as string);
  if (!ids.length) return { line, month, rows: [], targetsReady: true };

  const [targetsRes, seatsRes] = await Promise.all([
    db.from("channel_targets").select("client_id, target, notes, updated_at, updated_by, profiles:updated_by(full_name)").eq("line", line).in("client_id", ids),
    db.from("client_assignments").select("client_id, role, profile_id, is_primary, profiles(full_name)").in("client_id", ids).in("role", LINE_SEAT_ROLES[line]),
  ]);
  const targets = new Map((targetsRes.data ?? []).map((t) => [t.client_id as string, t]));
  type Seat = { client_id: string; role: string; profile_id: string; is_primary: boolean | null; profiles: { full_name: string } | null };
  const seats = (seatsRes.data ?? []) as unknown as Seat[];
  const seatsOf = (id: string) => seats.filter((s) => s.client_id === id);

  const base: BaseOf = (c) => {
    const t = targets.get(c.id as string);
    const mine = seatsOf(c.id as string);
    return {
      line,
      clientId: c.id as string,
      name: c.name as string,
      slug: c.slug as string,
      kaizenId: (c.kaizen_id as number | null) ?? null,
      // Social: Kaizen's 5% engagement target unless the client has its own
      target: t?.target == null ? (line === "social" ? DEFAULT_ENGAGEMENT_BAR : null) : Number(t.target),
      targetManual: t?.target == null ? null : Number(t.target),
      targetNote: (t?.notes as string | null) ?? null,
      targetBy: ((t?.profiles as unknown as { full_name: string } | null)?.full_name ?? null) as string | null,
      targetAt: (t?.updated_at as string | null) ?? null,
      canEdit: canSetTarget(me, line, mine.filter((s) => s.profile_id === me.id).map((s) => s.role)),
      canConnect: me.isExec || me.isLead,
      mine: mine.some((s) => s.profile_id === me.id),
      // Seat by seat, strategist first: who's seated, else who the sheet names (not in the app yet)
      team: crewOf(
        line,
        mine.map((s) => ({ seat: crewSeat(s.role, s.is_primary !== false), name: s.profiles?.full_name ?? "Someone" })),
        ((c.channel_sheet ?? {}) as Record<string, { seat: string; names: string[] }[]>)[line],
      ),
    };
  };

  const rows = line === "email" ? await emailRows(db, clients, ids, month, base) : await socialRows(db, clients, ids, month, base);
  return { line, month, rows: line === "email" || line === "social" ? worstScoreFirst(rows) : orderForBoard(rows), targetsReady: !targetsRes.error };
}

type Base = Pick<ChannelRow, "line" | "clientId" | "name" | "slug" | "kaizenId" | "target" | "targetManual" | "targetNote" | "targetBy" | "targetAt" | "canEdit" | "canConnect" | "mine" | "team">;
type ClientRef = { id: unknown; name: unknown; slug?: unknown; kaizen_id?: unknown; channel_sheet?: unknown };
type BaseOf = (c: ClientRef) => Base;

// ─── Email ─────────────────────────────────────────────────────────────────

async function emailRows(db: SupabaseClient, clients: ClientRef[], ids: string[], month: Month, base: BaseOf): Promise<ChannelRow[]> {
  const admin = adminConfigured() ? createAdminClient() : null;
  const sinceCamp = shiftDay(month.today, -60);
  // The ranked metrics that count as the sale, read apart from the connection's state so a database without their
  // migration still loads the board (one metric, as before)
  const ranked: Map<string, ConversionMetric[]> = admin
    ? await admin
        .from("klaviyo_connections")
        .select("client_id, conversion_metric_id, conversion_metric_name, conversion_metrics")
        .in("client_id", ids)
        .then((r) => new Map((r.error ? [] : (r.data ?? [])).map((c) => [c.client_id as string, conversionMetricsOf(c.conversion_metrics, { id: (c.conversion_metric_id as string | null) ?? null, name: (c.conversion_metric_name as string | null) ?? null })])))
    : new Map();
  const extraIds = [...new Set([...ranked.values()].flatMap((l) => (l.length > 1 ? l.map((m) => m.id) : [])))];
  // Every client's provider and its state (Klaviyo, Brevo or Customer.io), read with the server's rights
  const connMap = admin ? await emailConnections(admin, ids).catch(() => new Map<string, EmailConn>()) : new Map<string, EmailConn>();
  const noRevenue = new Set([...connMap.values()].filter((c) => !c.revenueRead).map((c) => c.clientId));
  const [days, camps, memos, scores, metricDays] = await Promise.all([
    readAll<Record<string, unknown>>((a, b) =>
      db.from("klaviyo_daily").select("client_id, date, revenue, campaign_revenue, flow_revenue, conversions, store_revenue, store_orders, subscribed, unsubscribed").in("client_id", ids).gte("date", month.prevStart).lte("date", month.today).order("client_id").order("date").range(a, b),
    ),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("klaviyo_campaigns").select("client_id, campaign_id, channel, send_time, recipients, delivered, opens_unique, clicks_unique").in("client_id", ids).gte("send_time", `${sinceCamp}T00:00:00Z`).order("client_id").order("campaign_id").range(a, b),
    ),
    admin ? admin.from("sync_state").select("source, last_result").in("source", ids.map((i) => `klaviyo:${i}`)).then((r) => r.data ?? []) : Promise.resolve([] as Record<string, unknown>[]),
    // The account score (the main email KPI), read through the same session as the rest
    loadEmailScores(db, ids, new Map([...ranked.entries()].map(([k, l]) => [k, l.map((m) => m.id)])), noRevenue).catch(() => new Map<string, EmailScoreResult>()),
    // Each ranked metric's own days this month, for the side by side (none until a lead ranks more than one)
    extraIds.length
      ? readAll<Record<string, unknown>>((a, b) => db.from("klaviyo_metric_daily").select("client_id, metric_id, date, revenue, conversions, store_revenue, store_orders").in("client_id", ids).in("metric_id", extraIds).gte("date", month.start).lte("date", month.today).order("client_id").order("metric_id").order("date").range(a, b)).catch(() => [] as Record<string, unknown>[])
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const connBy = connMap;
  const memoBy = new Map(memos.map((m) => [String(m.source).slice("klaviyo:".length), (m.last_result ?? null) as { seriesError?: string | null; storeError?: string | null } | null]));
  const daysBy = groupBy(days, (d) => d.client_id as string);
  const campsBy = groupBy(camps, (c) => c.client_id as string);

  return clients.map((c) => {
    const id = c.id as string;
    const b = base(c);
    const mine = daysBy.get(id) ?? [];
    const conn = connBy.get(id);
    const memo = memoBy.get(id);
    // With the server's rights the connection says where it stands; without them the daily rows do
    const st = conn
      ? emailClientState(conn.provider, { status: conn.status, lastSyncedAt: conn.lastSyncedAt, error: conn.lastError })
      : { state: (mine.length ? "connected" : "missing") as DataState, error: null };
    const partial = partialSyncWarning(memo);
    const thisMonth = mine.filter((d) => (d.date as string) >= month.start);
    const lastMonth = mine.filter((d) => (d.date as string) < month.start);
    const sum = (xs: Record<string, unknown>[], k: string) => xs.reduce((s, x) => s + num(x[k]), 0);
    const mtd = sum(thisMonth, "revenue");
    const readable = st.state !== "missing" && st.state !== "failing" && st.state !== "pending";
    // A source with no revenue (Customer.io without a purchase event, Brevo without a store) has no revenue goal or graph: unmeasured, never zero
    const revenueOn = conn ? conn.revenueRead : true;
    // The month's revenue target: last month + 10% by itself, a higher one typed on the board wins
    const prevTotal = lastMonth.length ? sum(lastMonth, "revenue") : null;
    const rt = revenueOn ? revenueTarget(prevTotal, b.targetManual ?? null) : revenueTarget(null, null);
    // The main KPI is the score; the month's pace against the target is the progression goal beside it
    const j = judgeEmail({ readable, target: rt.target, mtd, month });
    const rev = readable && revenueOn ? monthRevenue({ days: thisMonth.map((d) => ({ date: d.date as string, value: num(d.revenue) })), prevDays: lastMonth.map((d) => ({ date: d.date as string, value: num(d.revenue) })), month, target: rt.target }) : null;
    const list = ranked.get(id) ?? [];
    const found = readable ? (scores.get(id) ?? null) : null;
    const score = found && found.unmeasured.length < found.checks.length ? found : null;
    const status: ChannelStatus = score ? BAND_STATUS[score.band] : "setup";
    const cs = (campsBy.get(id) ?? []).filter((x) => num(x.recipients) > 0);
    const inMonth = cs.filter((x) => etDay(x.send_time as string) >= month.start);
    const em = inMonth.filter((x) => x.channel !== "sms");
    const delivered = em.reduce((s, x) => s + (num(x.delivered) || num(x.recipients)), 0);
    const lastSendAt = cs.map((x) => x.send_time as string).sort().at(-1) ?? null;
    const subDays = thisMonth.filter((d) => d.subscribed != null || d.unsubscribed != null);
    const storeDays = thisMonth.filter((d) => d.store_orders != null);
    const email: EmailSupport = {
      campaignRevenue: sum(thisMonth, "campaign_revenue"),
      flowRevenue: sum(thisMonth, "flow_revenue"),
      orders: sum(thisMonth, "conversions"),
      storeOrders: storeDays.length ? sum(storeDays, "store_orders") : null,
      openRate: delivered ? em.reduce((s, x) => s + num(x.opens_unique), 0) / delivered : null,
      clickRate: delivered ? em.reduce((s, x) => s + num(x.clicks_unique), 0) / delivered : null,
      listNet: subDays.length ? subDays.reduce((s, d) => s + num(d.subscribed) - num(d.unsubscribed), 0) : null,
      campaignsSent: inMonth.length,
      lastSendAt,
    };
    // Nothing sent in the 60 days read counts as 60: only a connected client can be "quiet"
    const quietDays = readable ? (daysSince(lastSendAt, month.today) ?? 60) : null;
    // Each ranked metric side by side: the primary from the main rows, the others from their own
    const metricNumbers: MetricNumbers[] | undefined =
      readable && list.length > 1
        ? list.map((m, i) => {
            const own = i === 0 ? thisMonth : metricDays.filter((d) => d.client_id === id && d.metric_id === m.id);
            const money = score?.byMetric?.[i];
            const stores = own.filter((d) => d.store_revenue != null || d.store_orders != null);
            return {
              ...m,
              weight: money?.weight ?? 0,
              revenue: own.length ? sum(own, "revenue") : null,
              conversions: own.length ? sum(own, "conversions") : null,
              storeRevenue: stores.length ? sum(stores, "store_revenue") : null,
              storeOrders: stores.length ? sum(stores, "store_orders") : null,
              attributed: money?.attributed ?? null,
              rpr: money?.rpr ?? null,
            };
          })
        : undefined;
    return {
      ...b,
      target: rt.target,
      revenueTarget: rt,
      revenue: rev,
      conversionMetrics: list,
      metricNumbers,
      data: st.state as DataState,
      problem: st.error ? { message: st.error.message, fix: st.error.fix } : null,
      warning: partial && st.state !== "missing" ? partial.message : null,
      provider: conn?.provider ?? null,
      revenueMeasured: revenueOn,
      lastSyncedAt: conn?.lastSyncedAt ?? null,
      account: conn?.account ?? null,
      conversionMetric: conn?.conversionMetric ?? null,
      currency: conn?.currency ?? null,
      status,
      ratio: j.ratio,
      value: readable ? mtd : null,
      projected: readable ? j.projected : null,
      prev: prevTotal,
      basis: "month" as const,
      series: readable ? cumulative(thisMonth.map((d) => ({ date: d.date as string, value: num(d.revenue) })), month.start, month.today) : [],
      span: month.daysInMonth,
      quietDays,
      email,
      social: null,
      score,
    };
  });
}

// ─── Social ────────────────────────────────────────────────────────────────

async function socialRows(db: SupabaseClient, clients: ClientRef[], ids: string[], month: Month, base: BaseOf): Promise<ChannelRow[]> {
  const basis = socialBasis(month);
  const from = basis === "month" ? month.start : shiftDay(month.today, -29);
  // Last month for the comparison, and 36 days back so the 7 day rate has its window on the oldest day charted
  const earliest = [month.prevStart, shiftDay(month.today, -36)].sort()[0];
  const [links, days, posts, scores] = await Promise.all([
    db.from("social_accounts").select("client_id, page_id, ig_id, page_name, ig_username, last_synced_at, last_error, missing_permissions").in("client_id", ids).then((r) => r.data ?? []),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_daily").select("client_id, platform, account_id, date, followers, follows_gained, follows_lost, reach, views, interactions").in("client_id", ids).gte("date", earliest).order("client_id").order("platform").order("date").range(a, b),
    ),
    readAll<Record<string, unknown>>((a, b) =>
      db.from("social_posts").select("client_id, platform, account_id, post_id, caption, permalink, posted_at, interactions").in("client_id", ids).gte("posted_at", `${shiftDay(month.today, -45)}T00:00:00Z`).order("client_id").order("post_id").range(a, b),
    ),
    // The account score (every platform and the overall), read through the same session as the rest
    loadSocialScores(db, ids, month.today).catch(() => new Map<string, SocialAccountScore>()),
  ]);
  const linkBy = new Map(links.map((l) => [l.client_id as string, l]));
  const daysBy = groupBy(days, (d) => d.client_id as string);
  const postsBy = groupBy(posts, (p) => p.client_id as string);

  return clients.map((c) => {
    const id = c.id as string;
    const b = base(c);
    const link = linkBy.get(id);
    const st = socialClientState(link ? { pageId: (link.page_id as string | null) ?? null, igId: (link.ig_id as string | null) ?? null, lastSyncedAt: (link.last_synced_at as string | null) ?? null, error: (link.last_error as string | null) ?? null, missing: (link.missing_permissions as string[] | null) ?? [] } : null);
    // Only the linked accounts' rows: a Page or Instagram account picked before keeps its history, unread
    const current = (r: Record<string, unknown>) => r.account_id === (r.platform === "facebook" ? link?.page_id : link?.ig_id);
    const mine = (daysBy.get(id) ?? []).filter(current);
    const win = (lo: string, hi: string) => mine.filter((d) => (d.date as string) >= lo && (d.date as string) <= hi);
    const total = (xs: Record<string, unknown>[], k: string): number | null => {
      let any = false;
      let s = 0;
      for (const x of xs) {
        if (x[k] == null) continue;
        any = true;
        s += num(x[k]);
      }
      return any ? s : null;
    };
    const now = win(from, month.today);
    const reach = total(now, "reach");
    const interactions = total(now, "interactions");
    const rate = engagement(interactions, reach);
    const prevRows = win(month.prevStart, month.prevEnd);
    const prevRate = engagement(total(prevRows, "interactions"), total(prevRows, "reach"));
    const readable = st.state !== "missing" && st.state !== "failing" && st.state !== "pending";
    const j = judgeSocial({ readable, target: b.target, rate });
    // The account's colour is its social score (engagement is one part of it), like email
    const sc = readable ? (scores.get(id) ?? null) : null;
    // Followers now: each platform's latest count, added up
    const latest = (p: string) => [...mine].reverse().find((d) => d.platform === p && d.followers != null)?.followers;
    const f = (["instagram", "facebook"] as const).map(latest).filter((x) => x != null).map(Number);
    const gained = total(now, "follows_gained");
    const lost = total(now, "follows_lost");
    const ps = (postsBy.get(id) ?? []).filter(current);
    const inWin = ps.filter((p) => p.posted_at && etDay(p.posted_at as string) >= from);
    const top = [...inWin].sort((x, y) => num(y.interactions) - num(x.interactions))[0];
    const lastPostAt = ps.map((p) => p.posted_at as string | null).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    const social: SocialSupport = {
      followers: f.length ? f.reduce((s, x) => s + x, 0) : null,
      followersChange: gained == null && lost == null ? null : (gained ?? 0) - (lost ?? 0),
      reach,
      views: total(now, "views"),
      interactions,
      posts: inWin.length,
      topPost: top && num(top.interactions) > 0 ? { caption: (top.caption as string | null) ?? null, permalink: (top.permalink as string | null) ?? null, interactions: num(top.interactions), platform: top.platform as string } : null,
      lastPostAt,
    };
    const stateErr = st.error ?? (link ? plainSocialError(link.last_error as string | null, (link.missing_permissions as string[] | null) ?? []) : null);
    // Connected but Meta gave no reach at all: the rate can't be read, and the person is told why
    const noInsights = st.state !== "missing" && readable && rate == null;
    return {
      ...b,
      data: st.state as DataState,
      problem: stateErr ? { message: stateErr.message, fix: stateErr.fix } : noInsights ? { message: "Meta isn't giving reach for this account yet", fix: "The first read can take a day. If it stays empty, check the Page and Instagram account are shared with Kaizen's Business Manager." } : null,
      warning: null,
      lastSyncedAt: (link?.last_synced_at as string | null) ?? null,
      account: link ? ([link.page_name, link.ig_username ? `@${link.ig_username}` : null].filter(Boolean).join(" · ") || null) : null,
      currency: null,
      status: sc ? BAND_STATUS[sc.band] : j.status,
      ratio: j.ratio,
      value: rate,
      projected: null,
      prev: prevRate,
      basis,
      series: readable ? rollingRate(sumByDate(mine), shiftDay(month.today, -29), month.today) : [],
      span: 30,
      quietDays: readable ? (daysSince(lastPostAt, month.today) ?? 45) : null,
      email: null,
      social,
      score: null,
      socialScore: sc,
    };
  });
}

/** Both platforms' days added up per date (a day with no number from either stays null) */
function sumByDate(rows: Record<string, unknown>[]): { date: string; interactions: number | null; reach: number | null }[] {
  const by = new Map<string, { date: string; interactions: number | null; reach: number | null }>();
  for (const d of rows) {
    const k = d.date as string;
    const x = by.get(k) ?? { date: k, interactions: null, reach: null };
    if (d.interactions != null) x.interactions = (x.interactions ?? 0) + num(d.interactions);
    if (d.reach != null) x.reach = (x.reach ?? 0) + num(d.reach);
    by.set(k, x);
  }
  return [...by.values()];
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Email boards read worst score first; accounts with no score yet (not connected) after the scored ones */
function worstScoreFirst(rows: ChannelRow[]): ChannelRow[] {
  const of = (r: ChannelRow) => r.score?.score ?? r.socialScore?.score ?? 1000;
  return [...rows].sort((a, b) => of(a) - of(b) || a.name.localeCompare(b.name));
}

/** A row's retention risk, with the owed replies on its client folded in */
export function riskForRow(r: ChannelRow, owed: { n: number; escalated: number } | undefined): Risk {
  const risk = riskOf(r.line, { status: r.status, data: r.data, quietDays: r.quietDays, owed: owed?.n ?? 0, escalated: owed?.escalated ?? 0 });
  if (r.line !== "email") return risk;
  // Email has no target to be off: the reason is the score's colour, with its biggest drag named
  const top = r.score?.weighingDown[0];
  const colour = (word: string) => [`Score ${r.score?.score ?? ""} (${word})`, ...(top ? [`${top.label} is the biggest drag`] : [])];
  return { score: risk.score, reasons: risk.reasons.filter((x) => x !== "No target set").flatMap((x) => (x === "Off target" ? colour("red") : x === "Close to target" ? colour("yellow") : [x])) };
}
