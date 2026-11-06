"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { DEFAULT_URL_TAGS, metaWriteSetting, writeAccess } from "@/lib/meta-write";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings → Sync health: the sandbox switch for every write to Meta, and a check of write access on an account.

/** Execs: sandbox on (only Kaizen's own ad account can be written to) or off (any account the system user manages). */
export async function setMetaSandbox(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const admin = createAdminClient();
  const cur = await metaWriteSetting(admin);
  const { error } = await admin.from("app_settings").upsert({ key: "meta_write", value: { ...cur, sandbox: on }, updated_by: me.id, updated_at: new Date().toISOString() });
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: Kaizen's UTM template for every launched ad (empty: back to Meta's auto-fill tags). */
export async function setUrlTags(tags: string): Promise<{ ok: true; tags: string } | { ok: false; error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const clean = tags.trim().replace(/^\?/, "");
  if (/\s/.test(clean)) return { ok: false, error: "No spaces: parameters are joined with &, like utm_source=facebook&utm_medium=paid." };
  const admin = createAdminClient();
  const cur = await metaWriteSetting(admin);
  const { error } = await admin.from("app_settings").upsert({ key: "meta_write", value: { ...cur, urlTags: clean || DEFAULT_URL_TAGS }, updated_by: me.id, updated_at: new Date().toISOString() });
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true, tags: clean || DEFAULT_URL_TAGS };
}

export type GoogleAccessResult = { ok: true; rows: (import("@/lib/context/google-ads").GoogleAccess & { label: string | null })[]; checkedAt: string } | { ok: false; error: string };

/**
 * Google Ads access for changes on one client's Google Ads accounts (the ones its live switch opens, read the way the
 * gate reads them): under our manager account, readable, and a dry run of a change. Nothing is created.
 */
export async function checkGoogleAccess(clientId: string): Promise<GoogleAccessResult> {
  const { requireStaff } = await import("@/lib/auth");
  await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const { googleAdsConfigured, googleAccess, managedAccounts } = await import("@/lib/context/google-ads");
  if (!googleAdsConfigured()) return { ok: false, error: "Google Ads isn't connected." };
  const { clientWriteAccounts } = await import("@/lib/meta-write");
  const accounts = await clientWriteAccounts(createAdminClient(), clientId, "google");
  if (!accounts.length) return { ok: true, rows: [], checkedAt: new Date().toISOString() };
  const managed = await managedAccounts().catch(() => []);
  const rows = await Promise.all(accounts.map(async (a) => ({ ...(await googleAccess(a.account, managed)), label: a.label })));
  return { ok: true, rows, checkedAt: new Date().toISOString() };
}

/** Execs: can Kaizen Ads write to this ad account? A dry run with Meta; nothing is created. */
export async function checkMetaWrite(account: string): Promise<{ ok: boolean; detail: string }> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, detail: "Can't check here." };
  const id = account.replace(/^act_/, "").replace(/\D/g, "");
  if (!id) return { ok: false, detail: "Enter an ad account ID." };
  return writeAccess(createAdminClient(), id);
}

export type TermsRow = import("@/lib/meta-write").AudienceTerms & { client: string | null; slug: string | null; live: boolean };

export type TermsResult = { ok: true; rows: TermsRow[]; tokenMissing: string[]; business: { id: string; name: string } | null; checkedAt: string } | { ok: false; error: string };

/**
 * Meta access for changes on one client's Meta ad accounts, or (no client) every active client's: each with the one
 * group it belongs in (status), worst first. Every count and list on screen is read from these rows.
 */
export async function checkAudienceTerms(clientId?: string): Promise<TermsResult> {
  const { requireStaff } = await import("@/lib/auth");
  await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Can't check here." };
  const { audienceTerms } = await import("@/lib/meta-write");
  const { metaConfigured } = await import("@/lib/context/meta");
  if (!metaConfigured()) return { ok: false, error: "Meta isn't connected." };
  const admin = createAdminClient();
  let cq = admin.from("clients").select("id, name, slug, live_ad_writes").is("archived_at", null);
  if (clientId) cq = cq.eq("id", clientId);
  const { data: clients } = await cq;
  const byId = new Map((clients ?? []).map((c) => [c.id as string, c]));
  if (!byId.size) return { ok: true, rows: [], tokenMissing: [], business: null, checkedAt: new Date().toISOString() };
  const { data: t } = await admin.from("kpi_targets").select("client_id, ad_account_id").eq("platform", "meta").in("client_id", [...byId.keys()]);
  const owner = new Map<string, string>();
  for (const x of t ?? []) {
    const a = String(x.ad_account_id ?? "").replace(/^act_/, "").replace(/\D/g, "");
    if (a && !owner.has(a)) owner.set(a, x.client_id as string);
  }
  const { tokenScopes, kaizenBusiness } = await import("@/lib/meta-write");
  const [terms, scopes, business] = await Promise.all([audienceTerms([...owner.keys()]), tokenScopes(), kaizenBusiness().catch(() => null)]);
  const rows: TermsRow[] = terms.map((r) => {
    const c = byId.get(owner.get(r.account) ?? "");
    return { ...r, client: (c?.name as string) ?? null, slug: (c?.slug as string) ?? null, live: c?.live_ad_writes === true };
  });
  // Worst first: not assigned, view-only, customer-list terms missing, ready
  const rank = { none: 0, view: 1, terms: 2, ready: 3 } as const;
  rows.sort((a, b) => rank[a.status] - rank[b.status] || Number(b.live) - Number(a.live) || (a.client ?? "").localeCompare(b.client ?? ""));
  return { ok: true, rows, tokenMissing: scopes.missing, business: business ? { id: business.id, name: business.name } : null, checkedAt: new Date().toISOString() };
}
