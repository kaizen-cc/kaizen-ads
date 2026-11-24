"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { mayEditSetup, SETUP_REFUSAL } from "@/lib/setup-access";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Store card on the client page: when they started with Kaizen (the line their before-and-after splits on), and
// reading a store again now.

type Result = { ok: true } | { ok: false; error: string };

async function mine(clientId: string, change: boolean) {
  const me = await requireStaff();
  if (change && (!mayEditSetup(me) || me.viewAs)) return { error: SETUP_REFUSAL } as const;
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { slug: data.slug as string, admin: createAdminClient() } as const;
}

export async function setKaizenStart(clientId: string, date: string | null): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Pick a date." };
  const { error } = await l.admin.from("clients").update({ kaizen_started_on: date || null }).eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true };
}

export async function readStoreNow(clientId: string, id: string): Promise<Result> {
  const l = await mine(clientId, false);
  if ("error" in l) return { ok: false, error: l.error! };
  const { data } = await l.admin.from("client_integrations").select("id").eq("id", id).eq("client_id", clientId).eq("kind", "shopify").maybeSingle();
  if (!data) return { ok: false, error: "Not found." };
  const r = await (await import("@/lib/shopify/store")).syncShopify(l.admin, id, Date.now() + 90_000);
  revalidatePath(`/clients/${l.slug}`);
  return "error" in r && r.error ? { ok: false, error: String(r.error).slice(0, 200) } : { ok: true };
}

/** A store that installed the app from Shopify's side, linked to this client */
export async function linkWaitingStore(clientId: string, shop: string): Promise<Result> {
  const me = await requireStaff();
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const { linkPending, syncShopify } = await import("@/lib/shopify/store");
  const r = await linkPending(l.admin, clientId, shop, me.id);
  if (!r.ok) return r;
  await syncShopify(l.admin, r.id, Date.now() + 60_000).catch(() => undefined);
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true };
}
