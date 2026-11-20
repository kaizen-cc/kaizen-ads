import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normAsset, type Waiver } from "@/lib/asset-waivers-core";

// Per client, the assets that were waived or confirmed unavailable (client_asset_waivers): read by the asset check
// and the brief writer, so a brief never asks for them again.

export async function loadWaivers(db: SupabaseClient, clientId: string): Promise<Waiver[]> {
  const { data, error } = await db.from("client_asset_waivers").select("label, how").eq("client_id", clientId).order("created_at").limit(100);
  if (error) return [];
  return (data ?? []).map((r) => ({ label: r.label as string, how: r.how === "unavailable" ? "unavailable" : "waived" }));
}

export async function addWaiver(admin: SupabaseClient, by: string, input: { clientId: string; label: string; how: Waiver["how"]; note?: string | null }) {
  const label = input.label.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!label) return { ok: false as const, error: "Which asset?" };
  const { error } = await admin.from("client_asset_waivers").upsert({ client_id: input.clientId, label, norm: normAsset(label), how: input.how, note: input.note?.slice(0, 300) ?? null, created_by: by }, { onConflict: "client_id,norm" });
  return error ? { ok: false as const, error: "It didn't save. Try again." } : { ok: true as const };
}

export async function removeWaiver(admin: SupabaseClient, clientId: string, label: string) {
  await admin.from("client_asset_waivers").delete().eq("client_id", clientId).eq("norm", normAsset(label));
}
