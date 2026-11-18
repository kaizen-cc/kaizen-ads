import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkText } from "@/lib/email-score-calc";
import { socialCheckText } from "@/lib/social-score";
import { loadChannelBoard } from "./load";
import type { ChannelRow } from "./types";

// What a KPI board shows for one client, for the agents, the assistant and Kaizen AI (the kpi_board tool, and the
// Email Strategist's fresh context in the deliverable flow): the same loaders as the boards, so an agent never says
// "no deliverability score on file" while the board shows one. Email: the score and every check (pace, attributed
// share, revenue per recipient, deliverability with its parts, campaign and flow open and click rates), the revenue
// target and pace, the month's numbers, the sending cycle against last cycle, and the segments. Social: the account
// score, its checks per platform and the engagement numbers. Ads: the Meta, Google and TikTok board lines (KPI against
// target, pace, trend and the reasons). Read with the person's own session; nothing they can't see.

type Me = { id: string; role: string; isExec: boolean; isLead: boolean };
export type KpiLine = "email" | "social" | "ads";

const pct = (x: number | null | undefined, d = 1) => (x == null ? null : Math.round(x * 10 ** (d + 2)) / 10 ** d);
const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);

function emailView(r: ChannelRow) {
  const s = r.score;
  const cur = r.currency ?? "USD";
  return {
    client: r.name,
    data: r.data,
    problem: r.problem?.message ?? null,
    warning: r.warning,
    source: r.provider ?? null,
    last_synced: r.lastSyncedAt,
    revenue_measured: r.revenueMeasured !== false,
    email_score: s
      ? {
          score: Math.round(s.score),
          band: s.band === "good" ? "green" : s.band === "watch" ? "yellow" : "red",
          window: s.window,
          checks: s.checks.map((c) => ({ check: c.label, key: c.key, value: checkText(c.unit, c.value, cur, c.bar), bar: checkText(c.unit, c.bar, cur), met: c.met, points: `${Math.round(c.points * 10) / 10} of ${c.weight}` })),
          weighing_down: s.weighingDown.map((c) => c.label),
          not_measured: s.unmeasured,
          deliverability: s.deliverability ? { score: Math.round(s.deliverability.score), parts: s.deliverability.parts.map((p) => ({ part: p.label, rate_pct: pct(p.rate, 2), grade: p.grade, points: `${Math.round(p.points * 10) / 10} of ${p.of}` })) } : "No email campaign went out in the score's window, so deliverability isn't scored this time.",
          totals_30d: { revenue: r2(s.totals.revenue), store_revenue: s.totals.storeRead ? r2(s.totals.storeRevenue) : null, recipients: s.totals.recipients, campaigns_sent: s.totals.campaignsSent, flows_live: s.totals.flowsLive },
        }
      : "No email score yet: the account isn't connected or nothing has been read.",
    revenue_this_month: {
      currency: cur,
      so_far: r2(r.value),
      target: r2(r.target),
      target_from: r.revenueTarget ?? null,
      pace_of_target: r.ratio == null ? null : Math.round(r.ratio * 100) / 100,
      projected: r2(r.projected),
      last_month: r2(r.prev),
      status: r.status,
    },
    month: r.email
      ? {
          campaign_revenue: r2(r.email.campaignRevenue),
          flow_revenue: r2(r.email.flowRevenue),
          orders: r.email.orders,
          store_orders: r.email.storeOrders,
          open_rate_pct: pct(r.email.openRate),
          click_rate_pct: pct(r.email.clickRate),
          list_net: r.email.listNet,
          campaigns_sent: r.email.campaignsSent,
          last_send: r.email.lastSendAt,
          quiet_days: r.quietDays,
        }
      : null,
    conversion_metrics: (r.metricNumbers ?? []).map((m) => ({ metric: m.name, weight: m.weight, revenue: r2(m.revenue), attributed_30d: r2(m.attributed), rpr_30d: r2(m.rpr) })),
    team: r.team.map((t) => `${t.seat}: ${t.name}${t.pending ? " (not in the app yet)" : ""}`),
  };
}

function socialView(r: ChannelRow) {
  const s = r.socialScore;
  return {
    client: r.name,
    data: r.data,
    problem: r.problem?.message ?? null,
    engagement_rate_pct: pct(r.value, 2),
    target_pct: pct(r.target, 2),
    of_target: r.ratio == null ? null : Math.round(r.ratio * 100) / 100,
    last_month_pct: pct(r.prev, 2),
    basis: r.basis === "month" ? "this month" : "last 30 days",
    status: r.status,
    social_score: s
      ? {
          score: Math.round(s.score),
          band: s.band,
          window: s.window,
          promised_posts_per_month: s.promised.perMonth,
          checks: s.checks.map((c) => ({ check: c.label, value: socialCheckText(c.unit, c.value), bar: socialCheckText(c.unit, c.bar), met: c.met, points: `${Math.round(c.points * 10) / 10} of ${c.weight}` })),
          weighing_down: s.weighingDown.map((d) => ({ check: d.label, platform: d.platform, points_lost: Math.round(d.cost * 10) / 10 })),
          platforms: s.platforms.map((p) => ({ platform: p.platform, score: Math.round(p.score), band: p.band })),
        }
      : "No social score yet: the Page or Instagram isn't linked, or nothing has been read.",
    numbers: r.social ? { followers: r.social.followers, followers_change: r.social.followersChange, reach: r.social.reach, views: r.social.views, interactions: r.social.interactions, posts: r.social.posts, last_post: r.social.lastPostAt, notes: r.social.rateNotes ?? [] } : null,
    team: r.team.map((t) => `${t.seat}: ${t.name}${t.pending ? " (not in the app yet)" : ""}`),
  };
}

/** The sending cycle as the Email design KPIs count it: sent this cycle against last cycle, what's in the works */
async function sendingCycle(db: SupabaseClient, clientId: string) {
  try {
    const { loadEmailDesignKpis } = await import("@/lib/email-kpis");
    const k = await loadEmailDesignKpis(db, "cycle");
    const c = k.cadence.find((x) => x.id === clientId);
    if (!c) return null;
    return { cycle_started: c.periodStart, resets: c.resets, sent_this_cycle: c.sent, sent_last_cycle: c.usual, in_the_works: c.open, business_days_in: c.elapsed, status: c.status, set_aside: c.dismissed?.reason ?? null, numbers_coming_in: c.sync.ok ? true : c.sync.label };
  } catch {
    return null;
  }
}

/** The client's segments as the Segments tab shows them (90 days) */
async function segments(admin: SupabaseClient, clientId: string) {
  try {
    const { loadSegmentReport } = await import("@/lib/klaviyo/segments");
    const { segmentDigest, PATTERN_LABEL } = await import("@/lib/klaviyo/segments-core");
    const report = await loadSegmentReport(admin, clientId, { days: 90, peerDb: admin });
    if (!report) return null;
    return { summary: segmentDigest(report), top: report.segments.slice(0, 10).map((s) => ({ name: s.name, kind: PATTERN_LABEL[s.pattern], campaigns: s.campaigns, recipients: s.recipients, open_rate: s.openRate, click_rate: s.clickRate, revenue: s.revenue, revenue_per_recipient: s.rpr, flags: s.flags })) };
  } catch {
    return null;
  }
}

/**
 * One client's KPI board for a line, as the board shows it. `admin` reads the segments (the Segments tab's own reader)
 * only after the session has shown the client is visible (the board row came back).
 */
export async function kpiBoardFor(db: SupabaseClient, admin: SupabaseClient, me: Me, clientId: string, line: KpiLine, opts: { cycle?: boolean; segments?: boolean } = {}) {
  if (line === "ads") {
    const { cachedClientKpis } = await import("@/lib/clients-kpi/load");
    const { data } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (!data) return { on_board: false, note: "You can't see this client." };
    const all = await cachedClientKpis();
    const k = all[clientId];
    const ads = (k?.kpis ?? []).filter((x) => !["email", "social", "creative"].includes(String(x.line)));
    if (!ads.length) return { on_board: false, note: "Not on the Meta, Google or TikTok KPI boards (no KPI set, or no ads line)." };
    return { at_risk: k?.atRisk ?? false, lines: ads.map((x) => ({ line: x.line, kpi: x.label, shown: x.shown, health: x.health, tone: x.tone, spend_14d: x.spend, pace: x.pace ?? null, trend: x.trend ?? null, reasons: x.reasons })) };
  }
  const board = await loadChannelBoard(db, line, me, [clientId]);
  const row = board.rows[0];
  if (!row) return { on_board: false, note: `Not on the ${line === "email" ? "Email" : "Social"} KPI board: the client doesn't have ${line === "email" ? "email marketing" : "social media"} as a service, it's paused, or you can't see it.` };
  if (line === "social") return { on_board: true, board_month: board.month, ...socialView(row) };
  const [cycle, segs] = await Promise.all([opts.cycle === false ? null : sendingCycle(db, clientId), opts.segments === false ? null : segments(admin, clientId)]);
  return { on_board: true, board_month: board.month, ...emailView(row), sending_cycle: cycle ?? "Not counted for this client this cycle.", segments: segs ?? "No segment numbers read yet." };
}
