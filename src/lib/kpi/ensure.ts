import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { orderSeats, type SeatRow } from "@/lib/buyer-seats";
import { servicesOf } from "@/lib/services";

// Every client running ads has a real KPI card: a client with the Meta (facebook-ads) or Google (google-ads) service
// and no active KPI on that platform gets one, with no target or budget yet and marked needs_target, owned by the
// primary buyer on the seat. The database does this itself when a client gains a service (migration
// 20261110120000_kpi_needs_target.sql); this is the same rule from the app, for the paths that change services, so the
// card is there (and synced) straight away even before that migration is applied. TikTok cards come from linking the
// advertiser (src/lib/tiktok/store.ts).

export const SERVICE_PLATFORM = { "facebook-ads": "meta", "google-ads": "google" } as const;
type CardPlatform = (typeof SERVICE_PLATFORM)[keyof typeof SERVICE_PLATFORM];

export type EnsureClient = {
  id: string;
  status: string;
  archived_at: string | null;
  meta_ad_account_id?: string | null;
  services?: string[] | null;
  services_extra?: string[] | null;
  services_removed?: string[] | null;
};
export type EnsureTarget = { platform: string; active: boolean; ad_account_id: string | null; updated_at?: string | null };
export type NewCard = { client_id: string; platform: CardPlatform; ad_account_id: string | null; conversion: "campaign_goal"; target: null; monthly_budget: null; owner_id: string | null; source: "strategy" };

const digits = (x: string | null | undefined) => (x ?? "").replace(/\D/g, "") || null;

/**
 * The KPI cards a client is missing (pure, for the app and the tests): one per ad platform it buys, while it's active
 * or onboarding and not archived, with no active KPI there. Meta takes the client's ad account; Google an account an
 * old KPI already knew, else none yet. The owner is the seat's primary buyer.
 */
export function missingKpiCards(c: EnsureClient, targets: readonly EnsureTarget[], seats: readonly SeatRow[]): NewCard[] {
  if (c.archived_at || !["active", "onboarding"].includes(c.status)) return [];
  const services = servicesOf(c);
  const out: NewCard[] = [];
  for (const [service, platform] of Object.entries(SERVICE_PLATFORM) as [keyof typeof SERVICE_PLATFORM, CardPlatform][]) {
    if (!services.includes(service)) continue;
    if (targets.some((t) => t.platform === platform && t.active)) continue;
    const known =
      platform === "meta"
        ? digits(c.meta_ad_account_id)
        : ([...targets].filter((t) => t.platform === "google" && digits(t.ad_account_id)).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0]?.ad_account_id ?? null);
    const role = platform === "google" ? "google_buyer" : "meta_buyer";
    const owner = orderSeats(seats.filter((s) => s.role === role && (s.client_id == null || s.client_id === c.id)))[0]?.profile_id ?? null;
    out.push({ client_id: c.id, platform, ad_account_id: known, conversion: "campaign_goal", target: null, monthly_budget: null, owner_id: owner, source: "strategy" });
  }
  return out;
}

/** Makes a client's missing KPI cards and syncs them, so they show every number on the board. Returns how many. */
export async function ensureKpiCards(admin: SupabaseClient, clientId: string): Promise<number> {
  const [{ data: c }, { data: targets }, { data: seats }] = await Promise.all([
    admin.from("clients").select("id, status, archived_at, meta_ad_account_id, services, services_extra, services_removed").eq("id", clientId).maybeSingle(),
    admin.from("kpi_targets").select("platform, active, ad_account_id, updated_at").eq("client_id", clientId),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
  ]);
  if (!c) return 0;
  const cards = missingKpiCards(c as EnsureClient, (targets ?? []) as EnsureTarget[], (seats ?? []) as SeatRow[]);
  if (!cards.length) return 0;
  let { error } = await admin.from("kpi_targets").insert(cards.map((x) => ({ ...x, needs_target: true })));
  // Before the migration adds needs_target, the cards are made without it (target null says the same)
  if (error && /needs_target/.test(error.message)) ({ error } = await admin.from("kpi_targets").insert(cards));
  if (error) {
    console.error("[kpi cards]", error.message);
    return 0;
  }
  await (await import("./sync")).refreshClientKpis(admin, clientId).catch((e) => console.error("[kpi cards] refresh", e instanceof Error ? e.message : e));
  return cards.length;
}
