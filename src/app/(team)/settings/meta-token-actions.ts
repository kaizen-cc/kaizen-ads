"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { NO_KEY } from "@/lib/meta-token-core";

// Client Business Manager connections (execs only). The token goes in once, through saveClientBusinessToken, and
// never comes back out: every answer here carries the business, the last 4 characters, scopes, expiry and accounts.

export type BusinessTokenView = import("@/lib/meta-tokens").BusinessTokenView;

export type BusinessTokensResult = { ok: true; encryption: boolean; tokens: BusinessTokenView[]; kpiAccounts: string[] } | { ok: false; error: string };

/** Every client business connection (or the ones reaching this client's KPI accounts, plus any made from its page). */
export async function loadBusinessTokens(clientId?: string): Promise<BusinessTokensResult> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const admin = createAdminClient();
  const { listBusinessTokens, tokenEncryptionConfigured } = await import("@/lib/meta-tokens");
  const all = await listBusinessTokens(admin);
  if (!clientId) return { ok: true, encryption: tokenEncryptionConfigured(), tokens: all, kpiAccounts: [] };
  const { clientWriteAccounts } = await import("@/lib/meta-write");
  const kpiAccounts = (await clientWriteAccounts(admin, clientId, "meta")).map((a) => a.account);
  const tokens = all.filter((t) => t.clientId === clientId || t.accounts.some((a) => kpiAccounts.includes(a.account)));
  return { ok: true, encryption: tokenEncryptionConfigured(), tokens, kpiAccounts };
}

type Done = { ok: true } | { ok: false; error: string };

/** Paste a client business's system user token: checked with Meta, encrypted and saved. replaceId: the one it replaces. */
export async function saveClientBusinessToken(input: { clientId: string | null; token: string; label?: string | null; replaceId?: string | null; slug?: string | null }): Promise<Done> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { saveBusinessToken, tokenEncryptionConfigured } = await import("@/lib/meta-tokens");
  if (!tokenEncryptionConfigured()) return { ok: false, error: NO_KEY };
  const r = await saveBusinessToken(createAdminClient(), { token: input.token ?? "", label: input.label ?? null, clientId: input.clientId, by: me.id, replaceId: input.replaceId ?? null });
  revalidate(input.slug);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Ask Meta about a saved connection again (validity, permissions, the accounts it reaches). */
export async function recheckClientBusinessToken(id: string, slug?: string | null): Promise<Done> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const { checkBusinessToken } = await import("@/lib/meta-tokens");
  const r = await checkBusinessToken(createAdminClient(), id);
  revalidate(slug);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Meta refused it." };
}

/** Remove a connection: marked revoked, the encrypted token deleted. Its accounts go back to Kaizen's own token. */
export async function removeClientBusinessToken(id: string, slug?: string | null): Promise<Done> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { removeBusinessToken } = await import("@/lib/meta-tokens");
  const r = await removeBusinessToken(createAdminClient(), id);
  revalidate(slug);
  return r;
}

function revalidate(slug?: string | null) {
  revalidatePath("/settings");
  if (slug) revalidatePath(`/clients/${slug}`);
}
