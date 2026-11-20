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

export const tools: AiTool[] = [scorecardTool, economicsTool];
