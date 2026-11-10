import { googleAdsConfigured } from "@/lib/context/google-ads";
import { teamPlatform } from "@/lib/roles";
import { orderSeats, platformOf, seatRoleFor, type SeatRow } from "@/lib/buyer-seats";
import { clientPerms } from "@/lib/chat-permissions";
import { requireStaff } from "@/lib/auth";
import { shownStatus, type Agg, type Pacing, type Status, type Trend } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { KpiBoard, type KpiRow } from "./kpi-board";
import { latestAudits } from "@/lib/audit-summary";
import { changeKey, loadChanges } from "@/lib/account-changes";
import { loadSprints } from "@/lib/sprints";
import { successOf, type BenchmarkTarget } from "@/lib/kpi/success";
import type { GoogleHealth } from "@/lib/google-flags";
import { asKpiPlatform } from "@/lib/kpi/platform";
import { tiktokConfigured } from "@/lib/tiktok/core";

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
  benchmark: BenchmarkTarget | null;
  google_health: GoogleHealth | null;
};


export default async function Kpis({ searchParams }: PageProps<"/kpis">) {
  const sp = await searchParams;
  const [me, supabase] = await Promise.all([requireStaff(), createClient()]);
  // The Meta team sees Meta accounts and the Google team Google's; execs and everyone else see both
  const team = teamPlatform(me.role);
  // A buyer: only the accounts they're on (they own the KPI, or they're the client's buyer for that platform)
  const buyer = Boolean(team) && !me.isExec && !me.isLead;
  const [{ data: targets }, { data: snaps }, { data: buyers }, { data: clients }, auditBy, { data: activity }, { data: seats }, { data: allSeats }] = await Promise.all([
    supabase
      .from("kpi_targets")
      .select("id, client_id, platform, ad_account_id, label, conversion, custom_action, campaign_match, target, monthly_budget, budget_note, source, owner_id, owner_name, extra_metrics, sheet, clients!inner(name, slug, status, kaizen_id), profiles!kpi_targets_owner_id_fkey(full_name)")
      .eq("active", true)
      .is("clients.archived_at", null),
    supabase.from("kpi_snapshots").select("*"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).or("role.in.(media_buyer,head_of_meta),also_buys.eq.true").order("full_name"),
    supabase.from("clients").select("id, name").neq("status", "offboarded").order("name"),
    latestAudits(supabase),
    supabase.from("ad_account_activity").select("ad_account_id, last_change_at, last_change, checked_at, error"),
    buyer ? supabase.from("client_assignments").select("client_id, role").eq("profile_id", me.id).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]) : Promise.resolve({ data: [] as { client_id: string; role: string }[] }),
    // Every buyer seat, primary first: the "needs a KPI" rows' buyer, and each card's secondary buyers
    supabase.from("client_assignments").select("client_id, role, profile_id, is_primary, created_at, profiles(full_name)").in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]),
  ]);
  type Seat = SeatRow & { client_id: string; profiles: { full_name: string } | null };
  const buyerSeats = orderSeats((allSeats ?? []) as unknown as Seat[]);
  // TikTok: its own seat when the client has one, else the Meta buyer's
  const seatsOn = (clientId: string, platform: string) => buyerSeats.filter((s) => s.client_id === clientId && s.role === seatRoleFor(buyerSeats, platform, clientId));
  // A card's secondary buyers: everyone on the seat but its primary, and never the card's own owner
  const coBuyersOf = (clientId: string, platform: string, ownerId: string | null) =>
    seatsOn(clientId, platform)
      .slice(1)
      .filter((s) => s.profile_id !== ownerId)
      .map((s) => ({ id: s.profile_id, name: s.profiles?.full_name ?? "Unknown" }));
  const snapBy = new Map((snaps ?? []).map((s) => [s.target_id as string, s as unknown as Snap]));
  const activityBy = new Map((activity ?? []).map((x) => [x.ad_account_id as string, x]));
  // The sprints, and each account's last 10 changes for its change history, together
  const [sprintList, changes] = await Promise.all([
    loadSprints(supabase, { targetIds: (targets ?? []).map((t) => t.id) }),
    loadChanges(supabase, (targets ?? []).filter((t) => t.ad_account_id).map((t) => changeKey(t.platform, String(t.ad_account_id))), 10),
  ]);
  const sprints = new Map(sprintList.map((x) => [x.targetId, x.sprint]));
  const seated = new Set((seats ?? []).map((a) => `${a.client_id}:${platformOf(a.role)}`));
  // A seat on the card's platform: TikTok falls back to the Meta seat while the client has no TikTok buyer
  const onSeat = (clientId: string, platform: string) => seated.has(`${clientId}:${platformOf(seatRoleFor(buyerSeats, platform, clientId))}`);
  // What this person may do from each card's chat (src/lib/chat-permissions.ts): a buyer's seats on that client, or
  // the card being theirs
  const ownedBy = new Set((targets ?? []).filter((t) => t.owner_id === me.id).map((t) => `${t.client_id}:${t.platform === "google" ? "google" : "meta"}`));
  const seatsOf = (clientId: string) => (buyer ? (["meta", "google"] as const).filter((p) => seated.has(`${clientId}:${p}`) || ownedBy.has(`${clientId}:${p}`)) : []);
  const rows: KpiRow[] = (targets ?? [])
    .filter((t) => !team || (t.platform === "google" ? "google" : "meta") === team)
    .filter((t) => !buyer || t.owner_id === me.id || onSeat(t.client_id as string, t.platform as string))
    .map((t) => {
      const c = t.clients as unknown as { name: string; slug: string; status: string; kaizen_id: number | null } | null;
      const s = snapBy.get(t.id);
      const pace = s?.budget && "pace" in s.budget ? (s.budget as Pacing) : null;
      // No KPI set: the industry benchmark is a hint for setting one; the card is never judged against it
      const benchmark = t.target == null ? (s?.benchmark ?? null) : null;
      const status = shownStatus(s?.status, t.target);
      const vsMonth = s?.vs_month == null ? null : Number(s.vs_month);
      return {
        id: t.id,
        clientId: t.client_id,
        perms: clientPerms(me, seatsOf(t.client_id as string)),
        client: c?.name ?? "Unknown",
        kaizenId: c?.kaizen_id ?? null,
        slug: c?.slug ?? "",
        clientStatus: c?.status ?? "active",
        platform: asKpiPlatform(t.platform),
        accountId: t.ad_account_id,
        label: t.label,
        conversion: t.conversion,
        conversionLabel: conversionLabel(t.conversion, t.custom_action),
        customAction: t.custom_action,
        campaignMatch: t.campaign_match,
        roas: Boolean(conversionFor(t.conversion).roas),
        target: t.target == null ? null : Number(t.target),
        targetFrom: t.target != null ? (t.source as "strategy" | "client") : null,
        benchmark,
        success: successOf(status, s?.trend ?? null, vsMonth),
        googleFlags: s?.google_health?.flags ?? [],
        budget: t.monthly_budget == null ? null : Number(t.monthly_budget),
        budgetNote: t.budget_note,
        source: t.source as "strategy" | "client",
        ownerId: t.owner_id,
        owner: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? t.owner_name ?? null,
        coBuyers: coBuyersOf(t.client_id as string, t.platform as string, t.owner_id as string | null),
        status,
        deviation: status === "unset" || s?.deviation == null ? null : Number(s.deviation),
        vsMonth,
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

  // A client running ads with no KPI set has a real card (kpi_targets.needs_target, made by the database when the client
  // gains the service), so it's in `rows` like any other
  // TikTok shows on the board once it's set up and connected (or already has cards); dormant until then
  const tiktokOn = tiktokConfigured() && ((targets ?? []).some((t) => t.platform === "tiktok") || (adminConfigured() && (await (await import("@/lib/tiktok/store")).tiktokConnected(createAdminClient()).catch(() => false))));

  // Ad accounts Meta shares with us that no client has yet (server-side bookmark; execs link them)
  const { data: accounts } = me.isExec && adminConfigured() ? await createAdminClient().from("sync_state").select("last_result").eq("source", "meta:accounts").maybeSingle() : { data: null };
  const unlinked = ((accounts?.last_result as { unlinked?: { id: string; name: string; bm?: { id: string; name: string } }[] } | null)?.unlinked ?? []).slice(0, 50);

  const lastSync = (snaps ?? []).map((s) => s.computed_at as string).sort().at(-1) ?? null;
  // A buyer opens on their own accounts: the ones they own and the ones they're a secondary buyer on
  const mine = rows.some((r) => r.ownerId === me.id || r.coBuyers?.some((b) => b.id === me.id));
  // Opened from somewhere about one account (?target=<id>, or ?client=<slug> with an optional &platform=): that card
  // opens on its own tab, with everyone's accounts showing so it's never filtered out
  const want = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const focus =
    rows.find((r) => r.id === want("target")) ??
    rows
      .filter((r) => r.slug === want("client") && (!want("platform") || r.platform === want("platform")))
      .sort((a, b) => ["meta", "google", "tiktok"].indexOf(a.platform) - ["meta", "google", "tiktok"].indexOf(b.platform))[0] ??
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
      tiktokOn={tiktokOn}
      only={team}
    />
  );
}
