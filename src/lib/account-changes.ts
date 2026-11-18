import type { SupabaseClient } from "@supabase/supabase-js";
import { isKaizenEmail, matchActor, type Person } from "@/lib/account-watch/core";

// The change log of an ad account (who changed what, when), as kept from Meta's activity log and Google's change
// history. Accounts are keyed the way the sync stores them: Meta without "act_", Google as its 10 digits.

export type AccountChange = { at: string; who: string | null; what: string; object: string | null; objectType: string | null; raw?: string | null; team?: boolean };

export const changeKey = (platform: string, accountId: string) => (platform === "google" ? accountId.replace(/\D/g, "") : accountId.replace(/^act_/, ""));

/**
 * Change-history names as the team member they are (an alias on their profile, their name or email, accents and case
 * aside): "Luriel Rt" shows as the buyer's own name. Unmatched names stay as the platform shows them.
 */
export async function teamNamer(db: SupabaseClient) {
  const { data } = await db.from("profiles").select("id, full_name, display_name, email, platform_aliases");
  const people = (data ?? []) as Person[];
  const cache = new Map<string, { name: string; team: boolean }>();
  return (who: string | null) => {
    if (!who) return { name: who, team: false };
    if (!cache.has(who)) {
      const p = matchActor(who, people);
      cache.set(who, p ? { name: p.display_name || p.full_name, team: true } : { name: who, team: isKaizenEmail(who) });
    }
    return cache.get(who)!;
  };
}

/** The latest `per` changes of each account, newest first, each name shown as the team member it is. */
export async function loadChanges(db: SupabaseClient, keys: string[], per: number): Promise<Map<string, AccountChange[]>> {
  const out = new Map<string, AccountChange[]>();
  const ids = [...new Set(keys.filter(Boolean))];
  if (!ids.length) return out;
  const [{ data }, name] = await Promise.all([db.from("ad_account_changes").select("ad_account_id, at, who, what, object, object_type").in("ad_account_id", ids).order("at", { ascending: false }).limit(Math.min(8000, ids.length * per * 4)), teamNamer(db)]);
  for (const r of data ?? []) {
    const list = out.get(r.ad_account_id) ?? [];
    const n = name(r.who);
    if (list.length < per) list.push({ at: r.at, who: n.name, what: r.what, object: r.object, objectType: r.object_type, raw: r.who, team: n.team });
    out.set(r.ad_account_id, list);
  }
  return out;
}
