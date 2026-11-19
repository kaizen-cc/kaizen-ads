import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { onService } from "@/lib/service-gate";
import { servicesOf } from "@/lib/services";

// The counts beside each tab of the KPI board's switch (Meta 68 · Google Ads 35 · TikTok 12 · Email 36 · Social 21), the
// same on every tab: the ads ones count the board's cards (active KPIs on clients not archived, what the person may
// see), Email and Social count the clients the Email and Social boards show (live clients that buy the service).

export type BoardCounts = { meta: number; google: number; tiktok: number; email: number; social: number };

export async function boardCounts(db: SupabaseClient): Promise<BoardCounts> {
  const [{ data: targets }, { data: clients }] = await Promise.all([
    db.from("kpi_targets").select("platform, clients!inner(archived_at, services, services_extra, services_removed, strategy_only)").eq("active", true).is("clients.archived_at", null),
    db.from("clients").select("services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", [...LIVE]),
  ]);
  // Only the cards of clients that buy that line (src/lib/service-gate.ts), as the board shows them
  const by = (p: string) => (targets ?? []).filter((t) => t.platform === p && onService(t)).length;
  const has = (slug: string) => (clients ?? []).filter((c) => (servicesOf(c) as string[]).includes(slug)).length;
  return { meta: by("meta"), google: by("google"), tiktok: by("tiktok"), email: has("email-marketing"), social: has("social-media") };
}
