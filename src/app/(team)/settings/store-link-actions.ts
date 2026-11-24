"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { mayEditSetup, SETUP_REFUSAL } from "@/lib/setup-access";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connections › Client stores: a store that installed the Kaizen OS app from Shopify's side, linked to the
// client it belongs to (execs and team leads), then its history starts reading.

export async function linkWaiting(shop: string, clientId: string): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!mayEditSetup(me) || me.viewAs) return { ok: false, error: SETUP_REFUSAL };
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const admin = createAdminClient();
  const { data: c } = await admin.from("clients").select("slug").eq("id", clientId).is("archived_at", null).maybeSingle();
  if (!c) return { ok: false, error: "Pick a client." };
  const { linkPending, syncShopify } = await import("@/lib/shopify/store");
  const r = await linkPending(admin, clientId, shop, me.id);
  if (!r.ok) return r;
  await syncShopify(admin, r.id, Date.now() + 60_000).catch(() => undefined);
  revalidatePath("/settings");
  revalidatePath(`/clients/${c.slug}`);
  return { ok: true, slug: c.slug as string };
}
