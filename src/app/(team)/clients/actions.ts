"use server";

import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { SLOTS, canHold, type SlotRole } from "@/lib/roles";
import { isBuyerRole, setPrimarySeat } from "@/lib/buyer-seats";
import { after } from "next/server";
import { handOff, writeHandoff } from "@/lib/handoff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Execs and leaders: set (or clear) who fills a slot on a client: its primary. A buyer seat's secondaries stay on it;
 * clearing the primary moves the first secondary up. RLS enforces the same rule.
 */
export async function setAssignment(clientId: string, slot: SlotRole, profileId: string | null): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only executives and leaders can assign people." };
  if (!SLOTS.some((s) => s.value === slot)) return { ok: false, error: "Unknown slot." };

  const supabase = await createClient();
  const res = await setPrimarySeat(supabase, clientId, slot, profileId);
  if (!res.ok) return res;
  // A new Meta buyer: the account's work (KPI, open tickets, sprint) moves to them, and their handoff is written
  if (slot === "meta_buyer" && res.to && res.to !== res.from) {
    const admin = createAdminClient();
    const id = await handOff(admin, clientId, res.from, res.to, me.id, "app");
    if (id) after(() => writeHandoff(admin, id));
  }
  // The TikTok card follows its seat: the TikTok buyer, else the Meta buyer
  if ((slot === "tiktok_buyer" || slot === "meta_buyer") && res.to !== res.from) {
    const admin = createAdminClient();
    const owner = await (await import("@/lib/tiktok/store")).tiktokOwner(admin, clientId).catch(() => undefined);
    if (owner !== undefined) await admin.from("kpi_targets").update({ owner_id: owner }).eq("client_id", clientId).eq("platform", "tiktok");
  }
  refresh();
  return { ok: true };
}

/** Execs and leaders: add a secondary buyer to a client's Meta or Google buyer seat (the first one in is the primary) */
export async function addSecondaryBuyer(clientId: string, slot: SlotRole, profileId: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only executives and leaders can assign people." };
  if (!isBuyerRole(slot)) return { ok: false, error: "Only the buyer seats take a secondary." };
  const supabase = await createClient();
  const { data: seat } = await supabase.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", slot);
  if ((seat ?? []).some((s) => s.profile_id === profileId)) return { ok: true };
  const { data: who } = await supabase.from("profiles").select("role, also_buys, is_active").eq("id", profileId).maybeSingle();
  const def = SLOTS.find((s) => s.value === slot)!;
  if (!who?.is_active || !canHold(def, { role: who.role as string, also_buys: who.also_buys as boolean | null })) return { ok: false, error: `They can't be a ${def.label.toLowerCase()}.` };
  const { error } = await supabase.from("client_assignments").insert({ client_id: clientId, role: slot, profile_id: profileId, is_primary: !(seat ?? []).length });
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

/** Execs and leaders: take a secondary buyer off a client (the primary changes with the seat's own picker) */
export async function removeSecondaryBuyer(clientId: string, slot: SlotRole, profileId: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only executives and leaders can assign people." };
  if (!isBuyerRole(slot)) return { ok: false, error: "Only the buyer seats take a secondary." };
  const supabase = await createClient();
  const { error } = await supabase.from("client_assignments").delete().eq("client_id", clientId).eq("role", slot).eq("profile_id", profileId).eq("is_primary", false);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

function refresh() {
  revalidatePath("/clients", "layout");
  revalidatePath("/team");
  revalidatePath("/kpis");
  revalidatePath("/reports");
}
