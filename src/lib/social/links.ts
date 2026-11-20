import type { SupabaseClient } from "@supabase/supabase-js";
import { linkKey, type LinkedAccount, type LinkPlatform } from "./links-core";

// Every social account linked to a client (social_links: the primary Page and Instagram plus every other location's),
// read through the caller's client (a person's session or the server's). Never throws: before the migration it reads
// the primary from social_accounts alone.

const toAccount = (r: Record<string, unknown>): LinkedAccount => ({
  id: r.id as string,
  platform: r.platform as LinkPlatform,
  accountId: r.account_id as string,
  name: (r.name as string | null) ?? null,
  location: (r.location as string | null) ?? null,
  pageId: (r.page_id as string | null) ?? null,
  source: (r.source as LinkedAccount["source"]) ?? "manual",
});

/** Each client's linked accounts, the primary first, then by platform and location */
export async function linkedAccounts(db: SupabaseClient, clientIds: string[]): Promise<Map<string, LinkedAccount[]>> {
  const out = new Map<string, LinkedAccount[]>();
  if (!clientIds.length) return out;
  const { data, error } = await db.from("social_links").select("id, client_id, platform, account_id, name, location, page_id, source").in("client_id", clientIds).is("removed_at", null);
  if (error) {
    // Before the migration: the primary alone
    const { data: prim } = await db.from("social_accounts").select("client_id, page_id, page_name, ig_id, ig_username").in("client_id", clientIds);
    for (const p of prim ?? []) {
      const list: LinkedAccount[] = [];
      if (p.page_id) list.push({ id: `fb:${p.page_id}`, platform: "facebook", accountId: p.page_id as string, name: (p.page_name as string | null) ?? null, location: null, pageId: null, source: "primary" });
      if (p.ig_id) list.push({ id: `ig:${p.ig_id}`, platform: "instagram", accountId: p.ig_id as string, name: (p.ig_username as string | null) ?? null, location: null, pageId: (p.page_id as string | null) ?? null, source: "primary" });
      out.set(p.client_id as string, list);
    }
    return out;
  }
  const rank = (a: LinkedAccount) => (a.source === "primary" ? 0 : 1);
  for (const r of data ?? []) {
    const k = r.client_id as string;
    out.set(k, [...(out.get(k) ?? []), toAccount(r)]);
  }
  for (const [k, list] of out) out.set(k, list.sort((a, b) => rank(a) - rank(b) || a.platform.localeCompare(b.platform) || (a.location ?? "").localeCompare(b.location ?? "")));
  return out;
}

/** Each client's linked accounts as "platform:account" keys, for keeping only the linked accounts' rows */
export async function linkedKeys(db: SupabaseClient, clientIds: string[]): Promise<Map<string, Set<string>>> {
  const all = await linkedAccounts(db, clientIds);
  return new Map([...all].map(([k, list]) => [k, new Set(list.map((a) => linkKey(a.platform, a.accountId)))]));
}

/** Whether a row (a day or a post) is from one of the client's linked accounts; other platforms (TikTok) carry their own and count */
export const isLinkedRow = (keys: Set<string> | undefined, r: { platform?: unknown; account_id?: unknown }) =>
  r.platform !== "facebook" && r.platform !== "instagram" ? true : Boolean(keys?.has(linkKey(String(r.platform), String(r.account_id ?? ""))));
