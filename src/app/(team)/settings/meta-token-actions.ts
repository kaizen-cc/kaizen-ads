"use server";

import { revalidatePath } from "next/cache";
import { requireExec, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { NO_KEY } from "@/lib/meta-token-core";

// The Business Managers Kaizen works through (Kaizen, ZenChange, Get Me Friends, Blue Cherry Group) and each client's
// pick. Tokens go in once, through connectBusinessManager (execs), and never come back out: every answer here carries
// names, status, the last 4 characters, scopes, expiry and accounts.

export type BusinessManagerView = import("@/lib/meta-tokens").BusinessManagerView;
export type ClientBusinessManager = import("@/lib/meta-tokens").ClientBusinessManager;

export type BusinessManagersResult = { ok: true; encryption: boolean; managers: BusinessManagerView[] } | { ok: false; error: string };

const NOT_SET_UP = "Business Managers aren't set up yet: the database migration for them hasn't been applied.";

/** Execs: every Business Manager, its token's status and what it reaches, and the clients on it. */
export async function loadBusinessManagers(): Promise<BusinessManagersResult> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const { listBusinessManagers, tokenEncryptionConfigured } = await import("@/lib/meta-tokens");
  const managers = await listBusinessManagers(createAdminClient());
  if (!managers) return { ok: false, error: NOT_SET_UP };
  return { ok: true, encryption: tokenEncryptionConfigured(), managers };
}

type Done = { ok: true } | { ok: false; error: string };

/** Execs: paste a partner Business Manager's system user token (new or a replacement): checked with Meta, encrypted, saved. */
export async function connectBusinessManager(input: { bmId: string; token: string }): Promise<Done> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { saveBusinessToken, tokenEncryptionConfigured } = await import("@/lib/meta-tokens");
  if (!tokenEncryptionConfigured()) return { ok: false, error: NO_KEY };
  const r = await saveBusinessToken(createAdminClient(), { bmId: input.bmId, token: input.token ?? "", by: me.id });
  revalidate();
  return r;
}

/** Execs: ask Meta about a Business Manager's token again (validity, permissions, the accounts it reaches). */
export async function recheckBusinessManager(id: string): Promise<Done> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const { checkBusinessToken } = await import("@/lib/meta-tokens");
  const r = await checkBusinessToken(createAdminClient(), id);
  revalidate();
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Meta refused it." };
}

/** Execs: remove a partner's token. Its clients go back to Kaizen's own token until it's connected again. */
export async function removeBusinessManagerToken(id: string): Promise<Done> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { removeBusinessToken } = await import("@/lib/meta-tokens");
  const r = await removeBusinessToken(createAdminClient(), id);
  revalidate();
  return r;
}

/** Everyone on the team: which Business Manager a client runs through, and whether its token reaches their accounts. */
export async function loadClientBusinessManager(clientId: string): Promise<{ ok: true; data: ClientBusinessManager } | { ok: false; error: string }> {
  await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  // Only a client this person can see (the database's own rules decide)
  const { createClient } = await import("@/lib/supabase/server");
  const { data: visible } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!visible) return { ok: false, error: "Client not found." };
  const { clientBusinessManager } = await import("@/lib/meta-tokens");
  const data = await clientBusinessManager(createAdminClient(), clientId);
  return data ? { ok: true, data } : { ok: false, error: NOT_SET_UP };
}

/** Execs: pick the client's Business Manager (null: Kaizen, the default). Saved on change. */
export async function setClientBusinessManagerAction(clientId: string, bmId: string | null, slug?: string | null): Promise<Done> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { setClientBusinessManager } = await import("@/lib/meta-tokens");
  const r = await setClientBusinessManager(createAdminClient(), clientId, bmId);
  revalidate(slug);
  return r;
}

function revalidate(slug?: string | null) {
  revalidatePath("/settings");
  if (slug) revalidatePath(`/clients/${slug}`);
}
