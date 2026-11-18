import "server-only";
import { allowedKpiLines, CRITICAL_FROM, criticalityOf, portfolioOf, KPI_LINES, LINE_LABEL, overallHealth, sortClients, summarize, summaryText, topReasons, type KpiLine } from "@/lib/clients-kpi/core";
import { cachedClientKpis, loadAllClientKpis, type AllClientKpis } from "@/lib/clients-kpi/load";
import { LIVE } from "@/lib/live";
import { lineOfTeam, teamPlatform } from "@/lib/roles";
import type { ToolCtx } from "./tools";

// rank_clients with line "all": the clients most critical across every line the person may see (or the best), each with
// how it's doing on each line and the top reasons, the same numbers, order and reasons as the Clients list. Read only,
// from stored data; never runs an AI.

const LINE_TAB: Record<KpiLine, string> = { meta: "facebook-ads", google: "google-ads", tiktok: "tiktok-ads", email: "email-marketing", social: "social-media", creative: "creative" };

export async function rankCriticalClients(ctx: ToolCtx, input: Record<string, unknown>) {
  const lines = allowedKpiLines(ctx.me, lineOfTeam(ctx.me.role), teamPlatform(ctx.me.role));
  const asked = String(input.only_line ?? "") as KpiLine;
  const only = KPI_LINES.includes(asked) ? asked : null;
  if (only && !lines.includes(only)) throw new Error(`You can rank ${lines.map((l) => LINE_LABEL[l]).join(", ")} only.`);
  // Across lines the default is the trouble first: "bottom" (or none) is most critical first, "top" the best performing
  const best = input.order === "top";
  // Clients the person may see (their session), with the shared KPI read for them
  const [{ data }, all] = await Promise.all([
    ctx.db.from("clients").select("id, name, slug").is("archived_at", null).in("status", [...LIVE]).order("name"),
    cachedClientKpis().catch((): Promise<AllClientKpis> => loadAllClientKpis(ctx.admin)),
  ]);
  const cards = ((data ?? []) as { id: string; name: string; slug: string }[]).map((c) => ({ ...c, kpis: (all[c.id]?.kpis ?? []).filter((k) => lines.includes(k.line)), atRisk: all[c.id]?.atRisk ?? false }));
  const judged = cards.filter((c) => c.kpis.some((k) => k.health != null && (!only || k.line === only)));
  // Business size against the book: a small account far off ranks below a big one slightly off (the list's own order)
  const book = portfolioOf(cards, only);
  const sorted = sortClients(judged, best ? "best" : "critical", only, book);
  const n = Math.min(25, Math.max(1, Math.trunc(Number(input.limit)) || 5));
  const sum = summarize(cards, only, book);
  return {
    order: best ? "best performing first" : "most critical first",
    ...(only ? { line: LINE_LABEL[only] } : {}),
    summary: summaryText(sum),
    off_target: sum.offTarget,
    critical: sum.critical,
    clients_judged: judged.length,
    left_out_without_a_kpi: cards.length - judged.length,
    ranking: sorted.slice(0, n).map((c, i) => {
      const crit = criticalityOf(c, only, book);
      return {
        rank: i + 1,
        client: c.name,
        ...(best ? { health: Math.round(overallHealth(c.kpis, only) ?? 0) } : { criticality: crit, critical: (crit ?? 0) >= CRITICAL_FROM }),
        at_risk_of_leaving: c.atRisk || undefined,
        lines: c.kpis.map((k) => ({ line: LINE_LABEL[k.line], kpi: k.shown, status: k.tone === "bad" ? "off target" : k.tone === "watch" ? "close" : k.tone === "good" ? "on target" : "not judged" })),
        top_reasons: topReasons(c.kpis.filter((k) => !only || k.line === only), 3, best ? "up" : "down"),
      };
    }),
    show_on_screen: `open_screen place "clients most critical" (${only ? `then the ${LINE_LABEL[only]} tab` : "every line"})`,
    ...(only ? { tab: LINE_TAB[only] } : {}),
  };
}
