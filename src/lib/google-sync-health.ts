import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleAdsConfigured, googleAdsMissing } from "@/lib/context/google-ads";
import { googleClientHealth, googleStateRank, type GoogleClientHealth } from "@/lib/google-health";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";

// Google Ads sync health for Settings › Sync health and the client's Team & setup: every client that runs Google (the
// google-ads service, or a Google KPI target), its customer IDs from the KPI board (where the client page and the KPI
// sync read them), and each account's last sync and error as the KPI sync recorded them (sync_state "kpi:<digits>").

export type GoogleRosterRow = GoogleClientHealth & { id: string; name: string; slug: string };

/** Every live client that runs Google, worst first; or one client (any status) when `clientId` is given */
export async function googleRoster(admin: SupabaseClient, clientId?: string): Promise<GoogleRosterRow[]> {
  let q = admin.from("clients").select("id, name, slug, services, services_extra, services_removed").order("name");
  q = clientId ? q.eq("id", clientId) : q.is("archived_at", null).in("status", LIVE);
  let t = admin.from("kpi_targets").select("client_id, ad_account_id, active").eq("platform", "google");
  if (clientId) t = t.eq("client_id", clientId);
  const [{ data: clients }, { data: targets }] = await Promise.all([q, t]);
  const byClient = new Map<string, { id: string | null; active: boolean }[]>();
  for (const r of targets ?? []) byClient.set(r.client_id as string, [...(byClient.get(r.client_id as string) ?? []), { id: (r.ad_account_id as string | null) ?? null, active: Boolean(r.active) }]);
  const digits = [...new Set((targets ?? []).map((r) => String(r.ad_account_id ?? "").replace(/\D/g, "")).filter((d) => d.length === 10))];
  const { data: state } = digits.length ? await admin.from("sync_state").select("source, last_run_at, last_result").in("source", digits.map((d) => `kpi:${d}`)) : { data: [] };
  const runs = new Map(
    (state ?? []).map((s) => {
      const res = s.last_result as { error?: string | null } | null;
      return [String(s.source).slice(4), { at: (s.last_run_at as string | null) ?? null, error: res?.error ?? null }] as const;
    }),
  );
  const setupError = googleAdsConfigured() ? null : `Google Ads isn't connected yet (missing ${googleAdsMissing().join("; ")})`;
  const rows: GoogleRosterRow[] = [];
  for (const c of clients ?? []) {
    const accounts = byClient.get(c.id as string) ?? [];
    const removed = ((c.services_removed as string[] | null) ?? []).includes("google-ads");
    const runsGoogle = !removed && (servicesOf(c).includes("google-ads") || accounts.some((a) => a.active));
    if (!runsGoogle) continue;
    rows.push({ id: c.id as string, name: c.name as string, slug: c.slug as string, ...googleClientHealth({ accounts, runs, setupError }) });
  }
  return rows.sort((a, b) => googleStateRank(a.state) - googleStateRank(b.state) || a.name.localeCompare(b.name));
}

/** One client's Google Ads, for Team & setup: null when they don't run Google */
export async function clientGoogleHealth(admin: SupabaseClient, clientId: string): Promise<GoogleRosterRow | null> {
  return (await googleRoster(admin, clientId))[0] ?? null;
}
