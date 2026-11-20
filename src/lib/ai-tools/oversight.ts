import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isHeadRole, visibleRows } from "@/lib/oversight/core";
import { str, type AiTool } from "./types";

// Accountability and money as tools, for the assistant and every Kaizen AI agent (src/lib/kaizen-ai/extensions.ts):
//   team_scorecard     per buyer/strategist and head: missed commitments, unapproved changes, silent and at-risk
//                      accounts, accounts per person (execs everyone, a head their line)
//   account_economics  executives only: fee, cost in hours, paid/unpaid/overdue, losing money, underpriced, billed with
//                      no work, unpaid. Never to be repeated in Slack, an email to a client, or anything a client sees.
// open_screen place 'scorecard' and 'account economics'.

const scorecardTool: AiTool = {
  name: "team_scorecard",
  description:
    "This week's scorecard per media buyer, Google buyer, email strategist and social media manager, and per line head (with their line's totals): missed commitments (promises and replies past due), our changes without the client's sign-off, accounts with no update to the client in 5+ days, accounts at retention risk, and accounts per person (load balance). Execs see everyone, a line head their line. person narrows it to a name. open_screen place 'scorecard' shows it.",
  input_schema: { type: "object", properties: { person: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec && !isHeadRole(user.role)) return { ok: false, error: "The scorecard is for the executives and the line heads." };
    const { loadScorecard } = await import("@/lib/oversight/load");
    const { rows } = await loadScorecard(createAdminClient());
    const who = str(input.person)?.toLowerCase();
    const shown = visibleRows(rows, user).filter((r) => !who || r.name.toLowerCase().includes(who));
    return { ok: true, page: "/scorecard", people: shown.slice(0, 40).map((r) => ({ name: r.name, role: r.role, line: r.line, accounts: r.accounts, missedCommitments: r.missed, unapprovedChanges: r.unapproved, silentAccounts: r.silent, atRiskAccounts: r.atRisk, ...(r.team ? { lineTotals: r.team } : {}) })) };
  },
};

const economicsTool: AiTool = {
  name: "account_economics",
  description:
    "Executives only. Each client's monthly fee (Stripe through Kaizen Track), team cost in logged hours over 30 days, margin, paid / invoice open / overdue, failed or never-collected invoices (when Stripe is connected directly), and the flags: losing money, underpriced (results far above target), billed with no work done, unpaid. client narrows it; flagged: true only the flagged ones. These numbers are internal: never put them in Slack, a client email, a report or anything a client sees. open_screen place 'account economics' shows it.",
  input_schema: { type: "object", properties: { client: { type: "string" }, flagged: { type: "boolean" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return { ok: false, error: "Billing and the company's money are for the executives." };
    const { loadEconomics } = await import("@/lib/oversight/load");
    const e = await loadEconomics(createAdminClient());
    if (!e.ok) return { ok: false, error: e.setup };
    const c = str(input.client)?.toLowerCase();
    const rows = e.rows.filter((r) => (!c || r.client.toLowerCase().includes(c)) && (input.flagged !== true || r.flags.length));
    return {
      ok: true,
      page: "/economics",
      internalOnly: "Never share these numbers in Slack or with a client.",
      stripeDirect: e.stripeDirect,
      clients: rows.slice(0, 50).map((r) => ({ client: r.client, feeMonthly: Math.round(r.fee), hours30d: Math.round(r.hours), cost30d: Math.round(r.cost), margin: Math.round(r.margin), payment: r.pay, owed: Math.round(r.owed), flags: r.flags })),
    };
  },
};

const supportTool: AiTool = {
  name: "support_dashboard",
  description:
    "The support positions' dashboards (on their Overview under Today). part 'tracking': open tracking problems across accounts (audits that found tracking issues, platform conversions vs the store's orders, conversion rate drops, spend with no results or landing page views, leads with no CRM sync, lost access, integrations losing authorization). 'client_health': per client, reply time in client channels, clients waiting on us, days since our last update, and sentiment from their own messages (a rough read), low sentiment first. 'onboarding': onboarding clients with intake (no delivery dates until it's in), assets, access and weekly check-in, and days stuck. Defaults to the person's own part. open_screen place 'overview' shows it.",
  input_schema: { type: "object", properties: { part: { type: "string", enum: ["tracking", "client_health", "onboarding"] } }, additionalProperties: false },
  run: async (user, input) => {
    const own = user.role === "tracking_specialist" ? "tracking" : user.role === "customer_success" ? "client_health" : user.role === "onboarding_specialist" ? "onboarding" : null;
    const part = str(input.part) ?? own;
    if (!part) return { ok: false, error: "Say which: tracking, client_health or onboarding." };
    const { isCreativeRole } = await import("@/lib/roles");
    if (isCreativeRole(user.role)) return { ok: false, error: "Account numbers aren't part of your view." };
    const admin = createAdminClient();
    const s = await import("@/lib/oversight/support");
    if (part === "tracking") return { ok: true, page: "/pipeline", issues: (await s.trackingBoard(admin)).slice(0, 40).map((r) => ({ client: r.client, kind: r.kind, severity: r.severity, title: r.title, why: r.body })) };
    if (part === "client_health") return { ok: true, page: "/pipeline", sentimentNote: "Sentiment is read from words in the client's messages: guessing.", clients: (await s.csBoard(admin)).filter((r) => r.rank > 0).slice(0, 40).map((r) => ({ client: r.client, sentiment: r.sentiment.now, trend: r.sentiment.trend, replyHours: r.replyHours == null ? null : Math.round(r.replyHours), waiting: r.waiting, daysSinceOurUpdate: r.quietDays })) };
    return { ok: true, page: "/pipeline", onboardings: (await s.onboardingBoard(admin)).map((r) => ({ client: r.client, daysIn: r.state.daysIn, stuck: r.state.stuck, intake: r.state.intake, assets: r.state.assets, access: r.state.access, daysSinceCheckIn: r.state.checkInDays, blockers: r.state.blockers })) };
  },
};

export const tools: AiTool[] = [scorecardTool, economicsTool, supportTool];
