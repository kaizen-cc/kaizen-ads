import type { SupabaseClient } from "@supabase/supabase-js";

// The change log of an ad account (who changed what, when), as kept from Meta's activity log and Google's change
// history. Accounts are keyed the way the sync stores them: Meta without "act_", Google as its 10 digits.

export type AccountChange = { at: string; who: string | null; what: string; object: string | null; objectType: string | null };

export const changeKey = (platform: string, accountId: string) => (platform === "google" ? accountId.replace(/\D/g, "") : accountId.replace(/^act_/, ""));

/** The latest `per` changes of each account, newest first. */
export async function loadChanges(db: SupabaseClient, keys: string[], per: number): Promise<Map<string, AccountChange[]>> {
  const out = new Map<string, AccountChange[]>();
  const ids = [...new Set(keys.filter(Boolean))];
  if (!ids.length) return out;
  const { data } = await db.from("ad_account_changes").select("ad_account_id, at, who, what, object, object_type").in("ad_account_id", ids).order("at", { ascending: false }).limit(Math.min(8000, ids.length * per * 4));
  for (const r of data ?? []) {
    const list = out.get(r.ad_account_id) ?? [];
    if (list.length < per) list.push({ at: r.at, who: r.who, what: r.what, object: r.object, objectType: r.object_type });
    out.set(r.ad_account_id, list);
  }
  return out;
}
