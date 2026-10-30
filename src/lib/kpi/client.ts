import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agg, Pacing, Status, Trend } from "./calc";
import { conversionFor, conversionLabel } from "./conversions";

// One client's KPI targets as the tracker last computed them (every 2 hours): for the client page and for every
// agent that reads the client, so a brief for an off-target account knows it's off target.

export type ClientKpi = {
  id: string;
  label: string | null;
  platform: "meta" | "google";
  accountId: string | null;
  conversionLabel: string;
  conversion: string;
  customAction: string | null;
  campaignMatch: string | null;
  extraMetrics: string[];
  roas: boolean;
  target: number | null;
  source: "strategy" | "client";
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
      return {
        id: t.id,
        label: t.label,
        platform: t.platform as "meta" | "google",
        accountId: (t.ad_account_id as string | null) ?? null,
        conversionLabel: conversionLabel(t.conversion, t.custom_action),
        conversion: t.conversion as string,
        customAction: (t.custom_action as string | null) ?? null,
        campaignMatch: (t.campaign_match as string | null) ?? null,
        extraMetrics: (t.extra_metrics ?? []) as string[],
        roas: Boolean(conversionFor(t.conversion).roas),
        target: t.target == null ? null : Number(t.target),
        source: t.source as "strategy" | "client",
        owner: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? t.owner_name ?? null,
        status: (s?.status ?? "setup") as Status,
        deviation: s?.deviation == null ? null : Number(s.deviation),
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
    .sort((a, b) => (a.platform === b.platform ? (a.label ?? "").localeCompare(b.label ?? "") : a.platform === "meta" ? -1 : 1));
}

/** Cost per result (or ROAS) over a window, as the tracker computed it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const kpiOf = (a: Agg | undefined, _roas?: boolean) => a?.value ?? null;

const STATUS_WORDS: Record<Status, string> = { excellent: "well ahead of target", good: "on target", close: "close to target", off: "OFF TARGET", idle: "not spending", setup: "not set up yet" };

/** The KPI picture in plain lines, for the AI. */
export function describeKpis(kpis: ClientKpi[]) {
  if (!kpis.length) return "No KPI targets set for this client yet.";
  const v = (x: number | null, roas: boolean) => (x == null ? "n/a" : roas ? `${x.toFixed(2)}x ROAS` : `$${x.toFixed(2)}`);
  const pctWorse = (x: number | null) => (x == null ? null : `${Math.round(Math.abs(x) * 100)}% ${x > 0 ? "worse" : "better"}`);
  return kpis
    .map((k) => {
      const name = `${k.platform === "google" ? "Google" : "Meta"}${k.label ? ` · ${k.label}` : ""} · ${k.conversionLabel}`;
      if (k.status === "setup" || k.status === "idle") return `- ${name}: ${STATUS_WORDS[k.status]}.`;
      const parts = [
        `${STATUS_WORDS[k.status]}`,
        k.target != null && `target ${v(k.target, k.roas)} (set by ${k.source === "client" ? "the client" : "Kaizen"})`,
        `last 7 days ${v(kpiOf(k.windows.d7, k.roas), k.roas)}, last 14 days ${v(kpiOf(k.windows.d14, k.roas), k.roas)}, last 30 days ${v(kpiOf(k.windows.d30, k.roas), k.roas)}`,
        k.deviation != null && `14 days are ${pctWorse(k.deviation)} than target`,
        k.vsMonth != null && `${pctWorse(k.vsMonth)} than last month`,
        k.trend && `trend: ${k.trend}`,
        k.pace && k.budget && `budget pacing ${k.pace.status} (${Math.round(k.pace.pace * 100)}% of the $${Math.round(k.budget).toLocaleString("en-US")} month)`,
      ].filter(Boolean);
      return `- ${name}: ${parts.join("; ")}.`;
    })
    .join("\n");
}
