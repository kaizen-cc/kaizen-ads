"use server";

import { after } from "next/server";
import { requireExec } from "@/lib/auth";
import { buildTaxonomy, placeNewClients } from "@/lib/verticals";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

/** Execs: work the verticals out again from today's paid ads clients (slugs stay stable; empty ones are set aside). */
export async function rebuildVerticals(): Promise<{ ok: true } | { error: string }> {
  await requireExec();
  if (!adminConfigured()) return { error: "Server key missing" };
  const admin = createAdminClient();
  after(async () => {
    await buildTaxonomy(admin);
    await placeNewClients(admin);
  });
  return { ok: true };
}
