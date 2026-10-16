"use server";

import { headers } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { buildPlaybook, shareToken } from "@/lib/playbooks";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

/** The name-free link to this playbook, for sales. */
export async function sharePlaybook(subId: string): Promise<{ url: string } | { error: string }> {
  await requireStaff();
  if (!adminConfigured()) return { error: "Sharing needs the server key" };
  const token = await shareToken(createAdminClient(), subId);
  const h = await headers();
  return { url: `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}/p/${token}` };
}

/** Rebuild now, instead of waiting for the hourly run. */
export async function rebuildPlaybook(subId: string): Promise<{ ok: true } | { error: string }> {
  const me = await requireStaff();
  if (!me.isExec && !me.isLead) return { error: "Leads and execs only" };
  if (!adminConfigured()) return { error: "Needs the server key" };
  try {
    const out = await buildPlaybook(createAdminClient(), subId);
    return out ? { ok: true } : { error: "Nothing to build from yet" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
