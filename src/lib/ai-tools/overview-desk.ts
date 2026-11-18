import "server-only";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { str, type AiTool } from "./types";

// The email and social Overview's tabs, for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   my_overview   what the person's Overview holds: their accounts first then the team's (worst first), the audits and
//                 sprints that need them (a head: only critical or gone stale), campaign ideas critical first, and the
//                 clients still to connect. Each part has its open_screen place ("overview clients", ...).
// Read with the person's own session: only clients they can see (src/lib/overview-desk.ts decides the order).

const myOverview: AiTool = {
  name: "my_overview",
  description:
    "What the person's own Overview holds, tab by tab (email, social, Meta and Google teams; the creative line's clients are on its Overview): part clients (their own accounts first, then the rest of their team's, each worst first by retention risk, with why), audits (audits and sprints that need them: a head of a line gets only the critical or stale ones, a strategist all of their own), ideas (email campaign ideas, critical first: send gaps, missing core flows, revenue drops, holidays about to be missed; then worth doing, then nice to have), setup (clients still to connect), or all. To show a part, open_screen place 'overview clients', 'overview campaign ideas', 'overview audits and sprints' or 'overview setup'.",
  input_schema: { type: "object", properties: { part: { type: "string", enum: ["all", "clients", "audits", "ideas", "setup"] } }, additionalProperties: false },
  run: async (user: Staff, input) => {
    const { lineOfTeam } = await import("@/lib/roles");
    const line = lineOfTeam(user.role);
    const part = str(input.part) ?? "all";
    const db = await createClient();
    if (!line) {
      // The ads lines: ad accounts against their KPI, keyed by account
      const { worksAs } = await import("@/lib/roles");
      const platform = worksAs(user.role, "head_of_meta", "media_buyer") ? "meta" : worksAs(user.role, "head_of_google", "google_buyer") ? "google" : null;
      if (!platform) return { ok: false, error: "This Overview has no client tabs for this role. Use my_work for what's on you." };
      const [desk, load, { etToday }] = await Promise.all([import("@/lib/overview-desk"), import("@/lib/overview-desk-load"), import("@/lib/channel-kpis/calc")]);
      const head = user.isLead || user.isExec;
      const [ads, owed] = await Promise.all([load.loadAdsDesk(db, user, platform), load.owedByClient(db, user)]);
      const scoped = head ? ads.rows : ads.rows.filter((r) => r.mine);
      const label = new Map(ads.rows.map((r) => [r.targetId, `${r.name}${r.label ? ` · ${r.label}` : ""}`]));
      const out: Record<string, unknown> = { ok: true, line: platform, head };
      if (part === "all" || part === "clients") {
        const live = scoped.filter((r) => r.status !== "setup").map((r) => ({ ...r, risk: desk.adsRisk({ status: r.status, deviation: r.deviation, pacing: r.pacing, hasAccount: r.hasAccount, owed: owed.get(r.clientId)?.n, escalated: owed.get(r.clientId)?.escalated }) }));
        const { mine, team } = desk.mineFirst(live);
        const brief = (r: (typeof live)[number]) => ({ client: r.name, account: r.label, status: r.status, risk: r.risk.score, why: r.risk.reasons, kpiCard: `/kpis?target=${r.targetId}` });
        out.clients = { mine: mine.map(brief), team: team.slice(0, 40).map(brief), teamTotal: team.length };
      }
      if (part === "all" || part === "audits") out.audits = desk.auditReminders(scoped.map((r) => ({ clientId: r.targetId })), ads.audits, ads.sprints, etToday(), { head }).map((i) => ({ account: label.get(i.clientId), kind: i.kind, id: i.id, level: i.level, why: i.why, moves: `${i.progress.done}/${i.progress.of}`, href: `/kpis/${i.kind}/${i.id}` }));
      if (part === "all" || part === "setup") out.setup = scoped.filter((r) => r.status === "setup" || r.status === "unset").map((r) => ({ account: label.get(r.targetId), problem: r.status === "unset" ? "No KPI set" : r.hasAccount ? "Can't read the account" : "No ad account" }));
      return out;
    }
    const [{ loadChannelBoard, riskForRow }, { etToday, orderByRisk }, { needsConnecting }, desk, load] = await Promise.all([import("@/lib/channel-kpis/load"), import("@/lib/channel-kpis/calc"), import("@/components/channel-parts"), import("@/lib/overview-desk"), import("@/lib/overview-desk-load")]);
    const [board, owed] = await Promise.all([loadChannelBoard(db, line, user), load.owedByClient(db, user)]);
    const head = user.isLead || user.isExec;
    const day = etToday();
    const rows = orderByRisk(board.rows.map((r) => ({ ...r, risk: riskForRow(r, owed.get(r.clientId)) })));
    const name = new Map(rows.map((r) => [r.clientId, r.name]));
    const live = rows.filter((r) => !needsConnecting(r));
    const out: Record<string, unknown> = { ok: true, line, head };
    if (part === "all" || part === "clients") {
      const { mine, team } = desk.mineFirst(live);
      const brief = (r: (typeof live)[number]) => ({ client: r.name, status: r.status, risk: r.risk.score, why: r.risk.reasons, score: r.score?.score ?? r.socialScore?.score ?? null });
      out.clients = { mine: mine.map(brief), team: team.slice(0, 40).map(brief), teamTotal: team.length };
    }
    if (part === "all" || part === "audits") {
      const ops = await load.loadDeskOps(db, rows.map((r) => r.clientId), line);
      const items = desk.auditReminders(head ? rows : rows.filter((r) => r.mine), ops.audits, ops.sprints, day, { head });
      out.audits = items.map((i) => ({ client: name.get(i.clientId), kind: i.kind, id: i.id, level: i.level, why: i.why, score: i.score, moves: `${i.progress.done}/${i.progress.of}` }));
    }
    if (line === "email" && (part === "all" || part === "ideas")) {
      const { loadSuggestions } = await import("@/lib/email-ops/load");
      const open = (await loadSuggestions(db, rows.map((r) => r.clientId), 240)).filter((s) => s.status === "new" || s.status === "in_motion");
      out.ideas = desk.prioritizeIdeas(open, day)
        .slice(0, 25)
        .map((s) => ({ id: s.id, client: name.get(s.clientId) ?? s.clientName, title: s.title, tier: s.priority.tier, why: s.priority.reason, sendOn: s.sendOn, status: s.status, createRequest: `/board/email/new?client=${rows.find((r) => r.clientId === s.clientId)?.slug ?? ""}&idea=${s.id}` }));
    }
    if (part === "all" || part === "setup") out.setup = rows.filter(needsConnecting).map((r) => ({ client: r.name, problem: r.problem?.message ?? r.data }));
    return out;
  },
};

export const tools: AiTool[] = [myOverview];
