import { requireStaff } from "@/lib/auth";
import type { Agg, Pacing, Status, Trend } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { createClient } from "@/lib/supabase/server";
import { KpiBoard, type KpiRow } from "./kpi-board";

// Pulling one client's numbers from Meta on demand can take a minute
export const maxDuration = 120;

type Snap = {
  status: Status | null;
  deviation: number | null;
  vs_month: number | null;
  vs_quarter: number | null;
  trend: Trend | null;
  windows: Partial<Record<string, Agg>>;
  months: Partial<Record<string, Agg>>;
  budget: Partial<Pacing>;
  daily: { d: string; spend: number; results: number }[];
  error: string | null;
  computed_at: string;
  data_through: string | null;
};

export default async function Kpis() {
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: targets }, { data: snaps }, { data: buyers }, { data: clients }] = await Promise.all([
    supabase
      .from("kpi_targets")
      .select("id, client_id, platform, ad_account_id, label, conversion, custom_action, campaign_match, target, monthly_budget, budget_note, source, owner_id, owner_name, clients(name, slug, status), profiles!kpi_targets_owner_id_fkey(full_name)")
      .eq("active", true),
    supabase.from("kpi_snapshots").select("*"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).in("role", ["media_buyer", "head_of_meta"]).order("full_name"),
    supabase.from("clients").select("id, name").neq("status", "offboarded").order("name"),
  ]);
  const snapBy = new Map((snaps ?? []).map((s) => [s.target_id as string, s as unknown as Snap]));

  const rows: KpiRow[] = (targets ?? [])
    .map((t) => {
      const c = t.clients as unknown as { name: string; slug: string; status: string } | null;
      const s = snapBy.get(t.id);
      const pace = s?.budget && "pace" in s.budget ? (s.budget as Pacing) : null;
      return {
        id: t.id,
        clientId: t.client_id,
        client: c?.name ?? "Unknown",
        slug: c?.slug ?? "",
        clientStatus: c?.status ?? "active",
        platform: t.platform as "meta" | "google",
        accountId: t.ad_account_id,
        label: t.label,
        conversion: t.conversion,
        conversionLabel: conversionLabel(t.conversion, t.custom_action),
        customAction: t.custom_action,
        campaignMatch: t.campaign_match,
        roas: Boolean(conversionFor(t.conversion).roas),
        target: t.target == null ? null : Number(t.target),
        budget: t.monthly_budget == null ? null : Number(t.monthly_budget),
        budgetNote: t.budget_note,
        source: t.source as "strategy" | "client",
        ownerId: t.owner_id,
        owner: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? t.owner_name ?? null,
        status: (s?.status ?? "setup") as Status,
        deviation: s?.deviation == null ? null : Number(s.deviation),
        vsMonth: s?.vs_month == null ? null : Number(s.vs_month),
        vsQuarter: s?.vs_quarter == null ? null : Number(s.vs_quarter),
        trend: s?.trend ?? null,
        windows: (s?.windows ?? {}) as KpiRow["windows"],
        months: (s?.months ?? {}) as KpiRow["months"],
        pace,
        daily: s?.daily ?? [],
        error: s?.error ?? (s ? null : "Not synced yet"),
        computedAt: s?.computed_at ?? null,
        dataThrough: s?.data_through ?? null,
      };
    })
    .sort((a, b) => a.client.localeCompare(b.client) || (a.label ?? "").localeCompare(b.label ?? ""));

  const lastSync = (snaps ?? []).map((s) => s.computed_at as string).sort().at(-1) ?? null;
  const mine = rows.some((r) => r.ownerId === me.id);

  return (
    <KpiBoard
      rows={rows}
      buyers={(buyers ?? []).map((b) => ({ id: b.id, name: b.full_name }))}
      clients={clients ?? []}
      me={{ id: me.id, firstName: me.fullName.split(" ")[0] }}
      initialOwner={mine ? me.id : "all"}
      lastSync={lastSync}
    />
  );
}
