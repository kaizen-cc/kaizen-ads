import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientBuyers } from "@/lib/buyer-seats";
import { assembleCc, ccProfileIds } from "./cc-core";

// The Cc line of every report email, read from the database: the report's owner and the client's buyers on the
// platforms it covers, and the staff an exec set to be copied on every report (Settings > Team, app_settings
// "report_cc"). Inactive profiles are skipped.

export const REPORT_CC_KEY = "report_cc";

/** The profiles always copied on a report email (ids), as set in Settings */
export async function alwaysCopiedIds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("app_settings").select("value").eq("key", REPORT_CC_KEY).maybeSingle();
  if (error) return [];
  const ids = (data?.value as { profileIds?: unknown } | null)?.profileIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

/** Who is copied on a client's report email: the buyers on those platforms (and the owners) plus the always-copied staff */
export async function reportCc(admin: SupabaseClient, p: { clientId: string; platforms: (string | null | undefined)[]; owners: (string | null | undefined)[]; to: string[] }): Promise<string[]> {
  const platforms = [...new Set(p.platforms.filter((x): x is string => Boolean(x)))];
  const [buyerLists, always] = await Promise.all([Promise.all((platforms.length ? platforms : [null]).map((pl) => clientBuyers(admin, p.clientId, pl).catch(() => [] as string[]))), alwaysCopiedIds(admin)]);
  const ids = ccProfileIds({ owners: p.owners, buyers: buyerLists.flat(), always });
  const all = [...ids.buyers, ...ids.always];
  if (!all.length) return [];
  const { data } = await admin.from("profiles").select("id, email, is_active").in("id", all);
  const email = new Map(((data ?? []) as { id: string; email: string | null; is_active: boolean | null }[]).filter((x) => x.is_active !== false && x.email).map((x) => [x.id, x.email!]));
  return assembleCc({ to: p.to, buyers: ids.buyers.map((id) => email.get(id)), always: ids.always.map((id) => email.get(id)) });
}
