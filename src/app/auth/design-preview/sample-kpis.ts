import type { KpiRow } from "@/app/(team)/kpis/kpi-board";
import { computeSnapshot, type Day } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";

// Design preview only: realistic rows built by running the real KPI math over made-up daily numbers.

const NOW = new Date("2026-10-15T16:00:00Z");

function days(spendPerDay: number, costPerResult: number, drift: number, seed: number): Day[] {
  const out: Day[] = [];
  let x = seed;
  const rand = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  for (let i = 199; i >= 0; i--) {
    const d = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const spend = spendPerDay * (0.75 + rand() * 0.5);
    const cpr = costPerResult * (1 + drift * ((200 - i) / 200)) * (0.7 + rand() * 0.6);
    out.push({ date: d, spend, actions: { omni_purchase: spend / cpr, landing_page_view: spend / 0.3, schedule_total: spend / cpr }, values: { omni_purchase: (spend / cpr) * 160 } });
  }
  return out;
}

const make = (
  id: string,
  client: string,
  conversion: string,
  owner: string,
  target: number,
  budget: number | null,
  spend: number,
  cpr: number,
  drift: number,
  extra: Partial<KpiRow> = {},
): KpiRow => {
  const s = computeSnapshot(days(spend, cpr, drift, id.charCodeAt(1) * 31), { conversion, target, budget, now: NOW });
  return {
    id,
    clientId: id,
    client,
    slug: client.toLowerCase().replace(/\W+/g, "-"),
    clientStatus: "active",
    platform: "meta",
    accountId: "526528539355910",
    audit: null,
    extraMetrics: [],
    sprint: null,
    lastChange: null,
    label: null,
    conversion,
    conversionLabel: conversionLabel(conversion),
    customAction: null,
    campaignMatch: null,
    roas: Boolean(conversionFor(conversion).roas),
    target,
    budget,
    budgetNote: null,
    source: "strategy",
    ownerId: owner,
    owner,
    status: s.status,
    deviation: s.deviation,
    vsMonth: s.vsMonth,
    vsQuarter: s.vsQuarter,
    trend: s.trend,
    windows: s.windows,
    months: s.months,
    pace: s.budget,
    daily: s.daily,
    error: null,
    computedAt: NOW.toISOString(),
    dataThrough: s.dataThrough,
    ...extra,
  };
};

export const sampleKpis: KpiRow[] = [
  make("k1", "Nectr", "purchases", "Rahul", 45, 24000, 820, 38, 0.25),
  make("k2", "OceanBox", "purchases", "Rahul", 100, 9000, 260, 128, 0.1),
  make("k3", "Aldecoa Coffee", "purchases", "Dipesh", 38, 6000, 260, 27, -0.15),
  make("k4", "Sierra Dreams", "roas", "Dipesh", 3, null, 900, 60, 0.2, { budgetNote: "No limit as long as we see 3x returns. Desired is to get to $150k/month profitably" }),
  make("k5", "Idalia Photography", "schedules", "Priscila", 95, 6000, 150, 88, 0.12, { label: "Bridal Boudoir", campaignMatch: "Bridal Boudoir" }),
  make("k6", "Crust Pizza Co.", "landing_page_views", "Eduarda", 0.34, 3100, 70, 0.3, 0),
  make("k7", "Goodmellow", "purchases", "Dipesh", 30, 5000, 120, 31, 0.02),
  make("k8", "Leap Funding", "purchases", "Mark", 75, 2500, 40, 70, -0.05),
  make("k9", "Unveiled", "purchases", "Rahul", 0, 4750, 150, 60, 0, { status: "setup", target: null, error: "Add a target" }),
];
