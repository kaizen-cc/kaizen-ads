import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { CREATIVE_TABS, EMAIL_TABS, membersOf, normName, tabHref, TEAM_BOARD_TITLE, type TeamBoard, type TeamTab } from "@/lib/team-kpis-core";

// The team KPI boards for the assistant and the agents: "how is the email build team doing", "who's the bottleneck on
// strategy", "how many errors did our designers make". Execs read both boards; the Head of Email the Email Team KPIs;
// the creative leads the Creative Team KPIs. Each answer carries the tab's address so open_screen can take them there.
// People on a tab are worked out by role (heads and execs are never on it, nor whoever asks).

/** Who may read which board: execs both, the Head of Email the email one, other leads the creative one */
export function teamBoardsFor(me: { role: string; isExec: boolean; isLead: boolean }): TeamBoard[] {
  if (me.isExec) return ["email", "creative"];
  if (me.role === "head_of_email") return ["email"];
  if (me.isLead && me.role !== "head_of_social") return ["creative"];
  // The lead graphic designer and lead video editor read their team's numbers too
  if (me.role === "lead_graphic_designer" || me.role === "lead_video_editor") return ["creative"];
  return [];
}

const PERIOD = { type: "string", enum: ["cycle", "30", "90"], description: "This billing month (default), or the last 30 or 90 days" };

export function teamKpiTools(ctx: ToolCtx): ChatTool[] {
  const boards = teamBoardsFor(ctx.me);
  if (!boards.length) return [];
  const tabs = [...new Set([...(boards.includes("email") ? EMAIL_TABS : []), ...(boards.includes("creative") ? CREATIVE_TABS : [])].map((t) => t.key))];
  return [
    {
      name: "team_kpis",
      description: `The team KPI boards (${boards.map((b) => TEAM_BOARD_TITLE[b]).join(" and ")}): each person on a tab with their numbers. Email: design (turnaround, internal and client revision rates, revision turnaround, errors read from comments, due dates pushed), build (turnaround, builds that came back, errors, pushback), copy (copy approved, AI first pass, rewrites, subject lines), strategy (their accounts' email score and trend, requests on time against the send date, how long work sent back to them sits and whether they're a bottleneck, Slack and email reply time, reports on time). Creative: design, video, copy. Optionally one person by name. Answer in a few plain sentences; the tab's address is in 'open' for open_screen.`,
      input_schema: {
        type: "object",
        properties: {
          board: { type: "string", enum: boards },
          tab: { type: "string", enum: tabs },
          person: { type: "string", description: "One teammate's name, to answer about them only" },
          period: PERIOD,
        },
        required: ["board"],
        additionalProperties: false,
      },
      status: (input) => `Reading the ${input.board === "creative" ? "Creative" : "Email"} Team KPIs…`,
      run: async (input) => {
        const board: TeamBoard = input.board === "creative" && boards.includes("creative") ? "creative" : boards.includes("email") ? "email" : "creative";
        const list = board === "email" ? EMAIL_TABS : CREATIVE_TABS;
        const tab = (list.find((t) => t.key === input.tab)?.key ?? "design") as TeamTab;
        const period = input.period === "30" || input.period === "90" ? input.period : "cycle";
        const who = typeof input.person === "string" && input.person.trim() ? normName(input.person) : null;
        const named = (name: string) => !who || normName(name).includes(who) || who.includes(normName(name).split(" ")[0]);
        const open = tabHref(board, tab, period);
        const cache = await import("@/lib/board-kpis-cache");
        if (board === "email") {
          const k = await cache.cachedEmailDesignKpis(period);
          const on = (ids: string[]) => new Set(ids.filter((id) => id !== ctx.me.id));
          const base = { board: TEAM_BOARD_TITLE.email, tab, period: `last ${k.days} days`, open };
          if (tab === "design") {
            const m = on(k.members.design);
            return {
              ...base,
              people: k.makers.filter((x) => m.has(x.profileId) && named(x.name)).map((x) => ({ name: x.name, role: x.role, designed: x.pieces, turnaround_days: x.turnaround, internal_revision_rate: x.sendbacks.d90.pieces ? Math.round((x.sendbacks.d90.internal / x.sendbacks.d90.pieces) * 100) : null, client_revision_rate: x.sendbacks.d90.pieces ? Math.round((x.sendbacks.d90.client / x.sendbacks.d90.pieces) * 100) : null, revision_turnaround_days: x.revisionTurnaround, errors_90d: x.errors.d90, due_dates_pushed_pct: x.pushedBack.pct, on_plate: x.plate.length, late: x.late, flag: x.act })),
              team: k.headlines.map((h) => ({ label: h.label, value: h.value, unit: h.unit, previous: h.previous })),
            };
          }
          if (tab === "build") {
            const m = on(k.members.build);
            return { ...base, people: k.builders.filter((x) => m.has(x.profileId) && named(x.name)).map((x) => ({ name: x.name, builds: x.builds, turnaround_days: x.turnaround, came_back_pct: x.returnRate, errors_90d: x.errors.d90, pushback_pct: x.pushedBack.pct, on_plate: x.plate.length, late: x.late, flag: x.act })) };
          }
          if (tab === "strategy") {
            const m = on(k.members.strategy);
            return {
              ...base,
              people: k.strategists.filter((x) => m.has(x.profileId) && named(x.name)).map((x) => ({ name: x.name, accounts: x.accounts.n, email_score_avg: x.accounts.avg, score_trend: x.accounts.trend, score_was: x.accounts.before, lowest_accounts: x.accounts.lowest, requests_on_time_pct: x.requests.onTime, requests_counted: x.requests.of, sent_back_avg_days: x.response.avgDays, waiting_past_target: x.response.sitting, bottleneck: x.response.bottleneck, reply_median_hours: x.replies.medianHours, replies_waiting: x.replies.waiting, replies_escalated: x.replies.escalated, reports_on_time_pct: x.reports.rate, reports_late: x.reports.late, flag: x.act })),
            };
          }
          const c = await cache.cachedEmailCopyKpis(period);
          const m = on(k.members.copy);
          return { ...base, people: c.strategists.filter((x) => m.has(x.id) && named(x.name)).map((x) => ({ name: x.name, copy_approved: x.approved, turnaround_days: x.turnaround, ai_first_pass_pct: x.firstPass, rewrites: x.rewrites, client_copy_sendbacks: x.sendbacks, open_rate: x.openRate, open_now: x.open, late: x.late, flag: x.act })), team: c.headlines.map((h) => ({ label: h.label, value: h.value, unit: h.unit, previous: h.previous })) };
        }
        // Creative: who's on the tab by role, from the person's own session
        const { data: people } = await ctx.db.from("profiles").select("id, role, is_exec").eq("is_active", true);
        const m = membersOf("creative", tab, (people ?? []) as { id: string; role: string; is_exec: boolean }[], [], ctx.me.id);
        const base = { board: TEAM_BOARD_TITLE.creative, tab, open };
        if (tab === "copy") {
          const c = await cache.cachedCopyKpis(period);
          return { ...base, period: `last ${c.days} days`, people: c.writers.filter((x) => m.has(x.id) && named(x.name)).map((x) => ({ name: x.name, reviewed: x.reviewed, turnaround_days: x.turnaround, first_pass_pct: x.firstPass, client_sendbacks: x.sendbacks, conflicts_caught: x.caught, open_now: x.open, flag: x.act })) };
        }
        const k = await cache.cachedCreativeKpis(period);
        return {
          ...base,
          period: `last ${k.days} days`,
          people: k.makers.filter((x) => x.profileId && m.has(x.profileId) && named(x.name)).map((x) => ({ name: x.name, role: x.role, pieces: x.pieces, turnaround_days: x.turnaround, first_pass_pct: x.firstPass, internal_revision_rate: x.sendbacks.d90.pieces ? Math.round((x.sendbacks.d90.internal / x.sendbacks.d90.pieces) * 100) : null, client_revision_rate: x.sendbacks.d90.pieces ? Math.round((x.sendbacks.d90.client / x.sendbacks.d90.pieces) * 100) : null, revision_turnaround_days: x.revisionTurnaround, errors_90d: x.errors.d90, due_dates_pushed_pct: x.pushedBack.pct, on_plate: x.plate.length, late: x.late, flag: x.act })),
          team: k.headlines.map((h) => ({ label: h.label, value: h.value, unit: h.unit, previous: h.previous })),
        };
      },
    },
  ];
}
