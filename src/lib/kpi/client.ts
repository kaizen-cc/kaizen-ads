import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shownStatus, type Agg, type Pacing, type Status, type Trend } from "./calc";
import { conversionFor, conversionLabel } from "./conversions";
import { successOf, successLine, type BenchmarkTarget, type Success, type TargetFrom } from "./success";
import type { GoogleHealth } from "@/lib/google-flags";
import { KPI_PLATFORMS, asKpiPlatform, platformShort, type KpiPlatform } from "./platform";

// One client's KPI targets as the tracker last computed them (every 30 minutes in business hours, hourly otherwise): for the client page and for every
// agent that reads the client, so a brief for an off-target account knows it's off target.

export type ClientKpi = {
  id: string;
  label: string | null;
  platform: KpiPlatform;
  accountId: string | null;
  conversionLabel: string;
  conversion: string;
  customAction: string | null;
  campaignMatch: string | null;
  extraMetrics: string[];
  roas: boolean;
  target: number | null;
  source: "strategy" | "client";
  /** Where the target came from; null when none is set (the status is then "unset" and the benchmark only a hint) */
  targetFrom: TargetFrom | null;
  benchmark: BenchmarkTarget | null;
  /** Trending toward the target (or the benchmark)? */
  success: Success | null;
  /** Google: brand share, impression share, conversion rate and CTR, last 30 days, with what's flagged */
  google?: GoogleHealth | null;
  owner: string | null;
  status: Status;
  deviation: number | null; // 14 days vs target; positive = worse
  vsMonth: number | null; // vs last month; positive = worse
  trend: Trend | null;
  windows: Partial<Record<"d3" | "d7" | "d14" | "d30" | "d60" | "d90", Agg>>;
  months: Partial<Record<"mtd" | "lastMonth" | "qtd" | "lastQuarter", Agg>>;
  pace: Pacing | null;
  budget: number | null;
  daily: { d: string; spend: number; results: number }[];
  computedAt: string | null;
  error: string | null;
};

export async function loadClientKpis(db: SupabaseClient, clientId: string): Promise<ClientKpi[]> {
  const { data: targets } = await db
    .from("kpi_targets")
    .select("id, label, platform, ad_account_id, conversion, custom_action, campaign_match, extra_metrics, target, monthly_budget, source, owner_name, profiles!kpi_targets_owner_id_fkey(full_name)")
    .eq("client_id", clientId)
    .eq("active", true);
  if (!targets?.length) return [];
  const { data: snaps } = await db.from("kpi_snapshots").select("*").in("target_id", targets.map((t) => t.id));
  return targets
    .map((t) => {
      const s = (snaps ?? []).find((x) => x.target_id === t.id);
      // No target: the industry benchmark is a hint only; the KPI is never judged against it
      const benchmark = t.target == null ? ((s?.benchmark ?? null) as BenchmarkTarget | null) : null;
      const status = shownStatus(s?.status, t.target);
      return {
        id: t.id,
        label: t.label,
        platform: asKpiPlatform(t.platform),
        accountId: (t.ad_account_id as string | null) ?? null,
        conversionLabel: conversionLabel(t.conversion, t.custom_action),
        conversion: t.conversion as string,
        customAction: (t.custom_action as string | null) ?? null,
        campaignMatch: (t.campaign_match as string | null) ?? null,
        extraMetrics: (t.extra_metrics ?? []) as string[],
        roas: Boolean(conversionFor(t.conversion).roas),
        target: t.target == null ? null : Number(t.target),
        source: t.source as "strategy" | "client",
        targetFrom: (t.target != null ? (t.source as "strategy" | "client") : null) as TargetFrom | null,
        benchmark,
        success: successOf(status, s?.trend ?? null, s?.vs_month == null ? null : Number(s.vs_month)),
        google: (s?.google_health ?? null) as GoogleHealth | null,
        owner: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? t.owner_name ?? null,
        status,
        deviation: status === "unset" || s?.deviation == null ? null : Number(s.deviation),
        vsMonth: s?.vs_month == null ? null : Number(s.vs_month),
        trend: s?.trend ?? null,
        windows: (s?.windows ?? {}) as ClientKpi["windows"],
        months: (s?.months ?? {}) as ClientKpi["months"],
        pace: s?.budget && "pace" in s.budget ? (s.budget as Pacing) : null,
        budget: t.monthly_budget == null ? null : Number(t.monthly_budget),
        daily: s?.daily ?? [],
        computedAt: s?.computed_at ?? null,
        error: s?.error ?? null,
      };
    })
    .sort((a, b) => (a.platform === b.platform ? (a.label ?? "").localeCompare(b.label ?? "") : KPI_PLATFORMS.indexOf(a.platform) - KPI_PLATFORMS.indexOf(b.platform)));
}

/** Cost per result (or ROAS) over a window, as the tracker computed it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const kpiOf = (a: Agg | undefined, _roas?: boolean) => a?.value ?? null;

const STATUS_WORDS: Record<Status, string> = { excellent: "well ahead of target", good: "on target", close: "close to target", off: "OFF TARGET", idle: "not spending", setup: "not set up yet", unset: "no KPI target set yet (numbers only, not judged on or off target)" };

/** The KPI picture in plain lines, for the AI. */
export function describeKpis(kpis: ClientKpi[]) {
  if (!kpis.length) return "No KPI targets set for this client yet.";
  const v = (x: number | null, roas: boolean) => (x == null ? "n/a" : roas ? `${x.toFixed(2)}x ROAS` : `$${x.toFixed(2)}`);
  const pctWorse = (x: number | null) => (x == null ? null : `${Math.round(Math.abs(x) * 100)}% ${x > 0 ? "worse" : "better"}`);
  return kpis
    .map((k) => {
      const name = `${platformShort(k.platform)}${k.platform === "tiktok" ? " (read only)" : ""}${k.label ? ` · ${k.label}` : ""} · ${k.conversionLabel}`;
      if (k.status === "setup" || k.status === "idle") return `- ${name}: ${STATUS_WORDS[k.status]}.`;
      const parts = [
        `${STATUS_WORDS[k.status]}`,
        k.target != null && `target ${v(k.target, k.roas)} (set by ${k.source === "client" ? "the client" : "Kaizen"})`,
        k.target == null && k.benchmark && `for reference only, the ${k.benchmark.vertical} industry benchmark is ${v(k.benchmark.value, k.roas)} (${k.benchmark.source} ${k.benchmark.year}); don't call it on or off target`,
        k.success && `${successLine(k.success, k.targetFrom ?? "strategy").toLowerCase()}`,
        `last 7 days ${v(kpiOf(k.windows.d7, k.roas), k.roas)}, last 14 days ${v(kpiOf(k.windows.d14, k.roas), k.roas)}, last 30 days ${v(kpiOf(k.windows.d30, k.roas), k.roas)}`,
        k.deviation != null && `14 days are ${pctWorse(k.deviation)} than target`,
        k.vsMonth != null && `${pctWorse(k.vsMonth)} than last month`,
        k.trend && `trend: ${k.trend}`,
        k.pace && k.budget && `budget pacing ${k.pace.status} (${Math.round(k.pace.pace * 100)}% of the $${Math.round(k.budget).toLocaleString("en-US")} month)`,
      ].filter(Boolean);
      const flags = k.google?.flags.length ? ` Google flags: ${k.google.flags.map((f) => `${f.title} (${f.fix.toLowerCase()})`).join("; ")}.` : "";
      return `- ${name}: ${parts.join("; ")}.${flags}`;
    })
    .join("\n");
}
