"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { connectKlaviyo, removeKlaviyo, syncKlaviyo } from "@/lib/klaviyo/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Klaviyo on the client page: a lead or exec pastes the account's read-only private API key (checked, encrypted, never
// shown again but its last 4), replaces or removes it; anyone on the client can sync it now. Read only in Klaviyo.

type Result = { ok: true; account?: string | null } | { ok: false; error: string };

async function mine(clientId: string, manage: boolean) {
  const me = await requireStaff();
  if (manage && !isExecOrLead(me)) return { error: "Only a lead or an exec can connect Klaviyo." } as const;
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { me, slug: data.slug as string, admin: createAdminClient() } as const;
}

export async function connectKlaviyoKey(clientId: string, key: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await connectKlaviyo(l.admin, clientId, key, l.me.id);
  if (!r.ok) return r;
  // The first pull (90 days back) right after the answer
  const admin = l.admin;
  after(() => syncKlaviyo(admin, clientId).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  // Connected from Settings › Sync health too: its Klaviyo card shows it
  revalidatePath("/settings");
  return { ok: true, account: r.account };
}

export async function removeKlaviyoKey(clientId: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await removeKlaviyo(l.admin, clientId);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}

export async function syncKlaviyoNow(clientId: string): Promise<Result> {
  const l = await mine(clientId, false);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await syncKlaviyo(l.admin, clientId);
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return r.ok ? { ok: true } : { ok: false, error: (r.error ?? "The sync failed.").slice(0, 240) };
}
