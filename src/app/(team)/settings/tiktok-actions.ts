"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { tiktokConfigured, tiktokMissing } from "@/lib/tiktok/core";

// Settings › Sync health › TikTok (execs): the connection's state, the ad accounts it reaches and the client each one
// belongs to. The token never comes back out: only its status and last 4 characters.

export type TikTokView = import("@/lib/tiktok/store").TikTokView;
type Done = { ok: true } | { ok: false; error: string };

export async function loadTikTok(): Promise<TikTokView> {
  await requireExec();
  if (!tiktokConfigured()) return { state: "waiting", missing: tiktokMissing() };
  if (!adminConfigured()) return { state: "not_ready", error: "Server key missing." };
  const { tiktokView } = await import("@/lib/tiktok/store");
  return tiktokView(createAdminClient());
}

/** Link a TikTok ad account to a client (null unlinks it). Linking gives the client a TikTok KPI card. */
export async function linkTikTokAccount(advertiserId: string, clientId: string | null): Promise<Done> {
  const me = await requireExec();
  if (!tiktokConfigured() || !adminConfigured()) return { ok: false, error: "TikTok isn't set up yet." };
  const { linkAdvertiser } = await import("@/lib/tiktok/store");
  const admin = createAdminClient();
  const r = await linkAdvertiser(admin, advertiserId, clientId, me.id);
  if (r.ok && clientId) {
    // The first 90 days, now, so the card has numbers
    const { refreshClientKpis } = await import("@/lib/kpi/sync");
    await refreshClientKpis(admin, clientId, true).catch(() => null);
  }
  revalidatePath("/settings");
  revalidatePath("/kpis");
  return r;
}

/** Disconnect a TikTok grant: its token is deleted; the numbers already pulled stay */
export async function disconnectTikTokAction(connectionId: string): Promise<Done> {
  await requireExec();
  if (!tiktokConfigured() || !adminConfigured()) return { ok: false, error: "TikTok isn't set up yet." };
  const { disconnectTikTok } = await import("@/lib/tiktok/store");
  const r = await disconnectTikTok(createAdminClient(), connectionId);
  revalidatePath("/settings");
  return r;
}

/** Pull TikTok now (advertisers, ads, and every TikTok KPI card) instead of waiting for the schedule */
export async function syncTikTokNow(): Promise<Done> {
  await requireExec();
  if (!tiktokConfigured() || !adminConfigured()) return { ok: false, error: "TikTok isn't set up yet." };
  const admin = createAdminClient();
  const { syncAllTikTok } = await import("@/lib/tiktok/store");
  const r = await syncAllTikTok(admin, 240_000);
  const { data: targets } = await admin.from("kpi_targets").select("client_id").eq("platform", "tiktok").eq("active", true);
  const { refreshClientKpis } = await import("@/lib/kpi/sync");
  for (const c of new Set((targets ?? []).map((t) => t.client_id as string))) await refreshClientKpis(admin, c, true).catch(() => null);
  revalidatePath("/settings");
  revalidatePath("/kpis");
  const errors = "errors" in r ? (r.errors ?? []) : [];
  return errors.length ? { ok: false, error: errors.slice(0, 2).join(" · ") } : { ok: true };
}
