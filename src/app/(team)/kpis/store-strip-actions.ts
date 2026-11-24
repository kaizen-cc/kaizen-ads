"use server";

import { requireStaff } from "@/lib/auth";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The KPI card's "Their store" line: Shopify's revenue and MER over the last 30 days against the 30 before, so a
// buyer sees whether the platform's numbers show up in the store.

export type StoreStrip = { revenue: number; prior: number; orders: number; mer: number | null; priorMer: number | null; adSpend: number; currency: string | null; slug: string } | null;

export async function storeStrip(clientId: string): Promise<StoreStrip> {
  const me = await requireStaff();
  if (!seesAccountNumbers(me) || !adminConfigured()) return null;
  const db = await createClient();
  const { data: c } = await db.from("clients").select("slug").eq("id", clientId).maybeSingle();
  if (!c) return null;
  const { storeOverview } = await import("@/lib/shopify/store");
  const o = await storeOverview(db, createAdminClient(), clientId).catch(() => null);
  if (!o) return null;
  return { revenue: o.last30.revenue, prior: o.prior30.revenue, orders: o.last30.orders, mer: o.last30.mer, priorMer: o.prior30.mer, adSpend: o.last30.adSpend, currency: o.currency, slug: c.slug as string };
}
