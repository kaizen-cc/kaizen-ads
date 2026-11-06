import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleAdsConfigured } from "@/lib/context/google-ads";
import { metaConfigured } from "@/lib/context/meta";
import { liveAccounts, metaWriteSetting } from "@/lib/meta-write";
import { bareAccount, decideWrite, type WritePlatform, type WriteStatus } from "@/lib/write-status-core";

export type { WriteStatus } from "@/lib/write-status-core";

type Who = { clientId?: string | null; account?: string | null };

/**
 * Can a change actually be written to this client's (or this account's) Meta or Google Ads right now? Read the same
 * way the write gates read it, so a button can say so before it's pressed instead of failing after.
 * Give the client, the account, or both (the account wins for the gate; the client gives the name).
 */
export async function writeStatus(admin: SupabaseClient, who: Who | string, platform: WritePlatform): Promise<WriteStatus> {
  const w: Who = typeof who === "string" ? { clientId: who } : who;
  let account = w.account ? bareAccount(w.account) : null;
  let clientId = w.clientId ?? null;
  // The account's client, or the client's account on this platform
  if (!clientId && account) {
    const { data } = await admin.from("kpi_targets").select("client_id, ad_account_id").eq("platform", platform);
    clientId = ((data ?? []).find((t) => bareAccount(t.ad_account_id as string | null) === account)?.client_id as string | undefined) ?? null;
  }
  if (clientId && !account) {
    const { data } = await admin.from("kpi_targets").select("ad_account_id").eq("client_id", clientId).eq("platform", platform).not("ad_account_id", "is", null).limit(1);
    account = bareAccount((data?.[0]?.ad_account_id as string | undefined) ?? null) || null;
  }
  const [{ data: c }, live, setting, google] = await Promise.all([
    clientId ? admin.from("clients").select("id, name, slug, live_ad_writes").eq("id", clientId).maybeSingle() : Promise.resolve({ data: null }),
    liveAccounts(admin, platform),
    platform === "meta" ? metaWriteSetting(admin) : Promise.resolve(null),
    platform === "google" ? admin.from("app_settings").select("value").eq("key", "google_write").maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const client = c ? { id: c.id as string, name: c.name as string, slug: c.slug as string } : null;
  return decideWrite({
    platform,
    account,
    client,
    configured: platform === "meta" ? metaConfigured() : googleAdsConfigured(),
    sandbox: setting?.sandbox,
    sandboxAccount: setting?.sandboxAccount ?? null,
    googleGlobal: (google.data?.value as { enabled?: boolean } | null)?.enabled === true,
    // The gate reads it by account (any live client that owns it); with no account yet, the client's own switch
    clientLive: account ? live.has(account) : c?.live_ad_writes === true,
  });
}
