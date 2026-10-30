import { googleAdsConfigured } from "@/lib/context/google-ads";
import { teamPlatform } from "@/lib/roles";
import { requireStaff } from "@/lib/auth";
import type { Agg, Pacing, Status, Trend } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { KpiBoard, type KpiRow } from "./kpi-board";
import { latestAudits } from "@/lib/audit-summary";
import { changeKey, loadChanges } from "@/lib/account-changes";
import { loadSprints } from "@/lib/sprints";

// Pulling one client's numbers from Meta on demand can take a minute; an audit runs a few minutes after the click
export const maxDuration = 800;

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


export default async function Kpis({ searchParams }: PageProps<"/kpis">) {
  const sp = await searchParams;
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: targets }, { data: snaps }, { data: buyers }, { data: clients }, auditBy] = await Promise.all([
    supabase
      .from("kpi_targets")
      .select("id, client_id, platform, ad_account_id, label, conversion, custom_action, campaign_match, target, monthly_budget, budget_note, source, owner_id, owner_name, extra_metrics, sheet, clients!inner(name, slug, status), profiles!kpi_targets_owner_id_fkey(full_name)")
      .eq("active", true)
      .is("clients.archived_at", null),
    supabase.from("kpi_snapshots").select("*"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).or("role.in.(media_buyer,head_of_meta),also_buys.eq.true").order("full_name"),
    supabase.from("clients").select("id, name").neq("status", "offboarded").order("name"),
    latestAudits(supabase),
  ]);
  const snapBy = new Map((snaps ?? []).map((s) => [s.target_id as string, s as unknown as Snap]));
  const { data: activity } = await supabase.from("ad_account_activity").select("ad_account_id, last_change_at, last_change, checked_at, error");
  const activityBy = new Map((activity ?? []).map((x) => [x.ad_account_id as string, x]));
  const sprints = new Map((await loadSprints(supabase, { targetIds: (targets ?? []).map((t) => t.id) })).map((x) => [x.targetId, x.sprint]));
  // Each account's last 10 changes, for its change history
  const changes = await loadChanges(supabase, (targets ?? []).filter((t) => t.ad_account_id).map((t) => changeKey(t.platform, String(t.ad_account_id))), 10);

  // The Meta team sees Meta accounts and the Google team Google's; execs and everyone else see both
  const team = teamPlatform(me.role);
  const rows: KpiRow[] = (targets ?? [])
    .filter((t) => !team || (t.platform === "google" ? "google" : "meta") === team)
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
        audit: auditBy.get(t.id) ?? null,
        extraMetrics: (t.extra_metrics ?? []) as string[],
        sheet: (t.sheet ?? null) as KpiRow["sheet"],
        sprint: sprints.get(t.id) ?? null,
        changes: t.ad_account_id ? (changes.get(changeKey(t.platform, String(t.ad_account_id))) ?? []) : [],
        lastChange: (() => {
          const x = t.ad_account_id ? activityBy.get(t.platform === "google" ? String(t.ad_account_id).replace(/\D/g, "") : String(t.ad_account_id).replace(/^act_/, "")) : undefined;
          if (!x) return null;
          const c = x.last_change as { at: string; who: string | null; what: string; object: string | null } | null;
          return { at: x.last_change_at, who: c?.who ?? null, what: c?.what ?? null, object: c?.object ?? null, checkedAt: x.checked_at, error: x.error };
        })(),
      };
    })
    .sort((a, b) => a.client.localeCompare(b.client) || (a.label ?? "").localeCompare(b.label ?? ""));

  // Ad accounts Meta shares with us that no client has yet (server-side bookmark; execs link them)
  const { data: accounts } = me.isExec && adminConfigured() ? await createAdminClient().from("sync_state").select("last_result").eq("source", "meta:accounts").maybeSingle() : { data: null };
  const unlinked = ((accounts?.last_result as { unlinked?: { id: string; name: string }[] } | null)?.unlinked ?? []).slice(0, 50);

  const lastSync = (snaps ?? []).map((s) => s.computed_at as string).sort().at(-1) ?? null;
  const mine = rows.some((r) => r.ownerId === me.id);
  // Opened from somewhere about one account (?target=<id>, or ?client=<slug> with an optional &platform=): that card
  // opens on its own tab, with everyone's accounts showing so it's never filtered out
  const want = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const focus =
    rows.find((r) => r.id === want("target")) ??
    rows
      .filter((r) => r.slug === want("client") && (!want("platform") || r.platform === want("platform")))
      .sort((a, b) => (a.platform === b.platform ? 0 : a.platform === "meta" ? -1 : 1))[0] ??
    null;

  return (
    <KpiBoard
      rows={rows}
      buyers={(buyers ?? []).map((b) => ({ id: b.id, name: b.full_name }))}
      clients={clients ?? []}
      me={{ id: me.id, firstName: me.fullName.split(" ")[0] }}
      initialOwner={focus || me.isExec || me.isLead ? "all" : mine ? me.id : "all"}
      focus={focus ? { id: focus.id, platform: focus.platform } : null}
      lastSync={lastSync}
      unlinked={unlinked}
      googleConnected={googleAdsConfigured()}
      only={team}
    />
  );
}
