import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasLine } from "@/lib/service-gate";
import { healthOf, sortHealth, type Health, type Reading } from "./core";

// Every client's connections, read in one pass (admin client: the callers check who's asking). Ad platforms from the
// KPI sync's own record of each account (kpi_snapshots: computed_at and its error) plus Meta's activity read; TikTok's
// advertisers; the email platforms' connections; stores and CRMs (client_integrations); Motion's shared connection for
// every client that uses Motion. Only what the client buys (the services gate) or has connected.

export type ClientHealth = { clientId: string; client: string; slug: string; items: Health[] };

export async function integrationHealth(admin: SupabaseClient, opts: { clientIds?: string[] } = {}, now = new Date()): Promise<ClientHealth[]> {
  let cq = admin.from("clients").select("id, name, slug, services, services_extra, services_removed, motion_workspace_id").is("archived_at", null).in("status", ["active", "onboarding"]);
  if (opts.clientIds?.length) cq = cq.in("id", opts.clientIds);
  const { data: clients } = await cq.limit(2000);
  const list = (clients ?? []) as { id: string; name: string; slug: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; motion_workspace_id: string | null }[];
  if (!list.length) return [];
  const ids = list.map((c) => c.id);
  const [{ data: targets }, { data: activity }, { data: tiktok }, { data: klaviyo }, { data: brevo }, { data: cio }, { data: integ }, { data: motion }] = await Promise.all([
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, kpi_snapshots(computed_at, error)").eq("active", true).in("client_id", ids).not("ad_account_id", "is", null),
    admin.from("ad_account_activity").select("ad_account_id, error, checked_at"),
    admin.from("tiktok_advertisers").select("client_id, name, status, error, last_synced_at").in("client_id", ids),
    admin.from("klaviyo_connections").select("client_id, status, last_error, last_synced_at").in("client_id", ids),
    admin.from("brevo_connections").select("client_id, status, last_error, last_synced_at").in("client_id", ids),
    admin.from("customerio_connections").select("client_id, status, last_error, last_synced_at").in("client_id", ids),
    admin.from("client_integrations").select("client_id, kind, label, status, last_error, last_synced_at").in("client_id", ids),
    admin.from("motion_connection").select("expires_at, refresh_token, last_sync_at, error").limit(1).maybeSingle(),
  ]);
  const act = new Map(((activity ?? []) as { ad_account_id: string; error: string | null; checked_at: string | null }[]).map((a) => [a.ad_account_id.replace(/^act_/, ""), a]));
  const out: ClientHealth[] = [];
  for (const c of list) {
    const readings: Reading[] = [];
    for (const t of ((targets ?? []) as unknown as { client_id: string; platform: string; ad_account_id: string; kpi_snapshots: { computed_at: string | null; error: string | null } | { computed_at: string | null; error: string | null }[] | null }[]).filter((x) => x.client_id === c.id)) {
      const line = t.platform === "google" ? "google" : t.platform === "tiktok" ? "tiktok" : t.platform === "meta" ? "meta" : null;
      if (!line || !hasLine(c, line)) continue;
      const snap = Array.isArray(t.kpi_snapshots) ? t.kpi_snapshots[0] : t.kpi_snapshots;
      const a = line === "meta" ? act.get(t.ad_account_id.replace(/^act_/, "")) : undefined;
      readings.push({ kind: line, label: `${line === "meta" ? "Meta" : line === "google" ? "Google" : "TikTok"} ad account ${t.ad_account_id.replace(/^act_/, "")}`, connected: true, error: snap?.error || a?.error || null, lastAt: snap?.computed_at ?? null });
    }
    if (hasLine(c, "tiktok"))
      for (const t of ((tiktok ?? []) as { client_id: string; name: string | null; status: string | null; error: string | null; last_synced_at: string | null }[]).filter((x) => x.client_id === c.id))
        readings.push({ kind: "tiktok", label: `TikTok ${t.name ?? "advertiser"}`, connected: !/disabled|revoked|removed/i.test(t.status ?? ""), status: t.status, error: t.error, lastAt: t.last_synced_at });
    if (hasLine(c, "email")) {
      for (const [kind, rows] of [["klaviyo", klaviyo], ["brevo", brevo], ["customerio", cio]] as const)
        for (const r of ((rows ?? []) as { client_id: string; status: string | null; last_error: string | null; last_synced_at: string | null }[]).filter((x) => x.client_id === c.id))
          readings.push({ kind, connected: true, status: r.status, error: r.last_error, lastAt: r.last_synced_at });
    }
    for (const i of ((integ ?? []) as { client_id: string; kind: string; label: string | null; status: string | null; last_error: string | null; last_synced_at: string | null }[]).filter((x) => x.client_id === c.id))
      readings.push({ kind: /shopify|woo/i.test(i.kind) ? "shopify" : "crm", label: i.label ?? (/gohighlevel|ghl/i.test(i.kind) ? "GoHighLevel" : i.kind.replace(/^./, (x) => x.toUpperCase())), connected: true, status: i.status, error: i.last_error, lastAt: i.last_synced_at });
    if (c.motion_workspace_id && motion)
      readings.push({ kind: "motion", connected: true, error: (motion.error as string | null) ?? null, expiresAt: (motion.expires_at as string | null) ?? null, refreshes: Boolean(motion.refresh_token), lastAt: (motion.last_sync_at as string | null) ?? null });
    if (c.motion_workspace_id && !motion) readings.push({ kind: "motion", connected: false });
    out.push({ clientId: c.id, client: c.name, slug: c.slug, items: sortHealth(readings.map((r) => healthOf(r, now))) });
  }
  return out;
}
