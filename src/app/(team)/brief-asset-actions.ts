"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addWaiver, removeWaiver } from "@/lib/asset-waivers";
import type { Waiver } from "@/lib/asset-waivers-core";

// An asset a brief asks for, marked waived or not available for the client: it's never asked for again (the asset
// check shows it as such, and the brief writer is told). Anyone who can see the client can mark it, or take it back.

export async function waiveBriefAsset(clientId: string, label: string, how: Waiver["how"]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!data) return { ok: false, error: "You can't see that client." };
  return addWaiver(createAdminClient(), me.id, { clientId, label, how: how === "unavailable" ? "unavailable" : "waived" });
}

export async function unwaiveBriefAsset(clientId: string, label: string) {
  const me = await requireStaff();
  if (me.viewAs) return;
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (data) await removeWaiver(createAdminClient(), clientId, label);
}
