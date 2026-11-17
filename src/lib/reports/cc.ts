import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientBuyers } from "@/lib/buyer-seats";
import { assembleCc, ccProfileIds } from "./cc-core";

// The Cc line of every report email, read from the database: the report's owner, the people on that line (reportCc
// below), and the staff an exec set to be copied on every report (Settings > Team, app_settings "report_cc").
// Inactive profiles are skipped.

export const REPORT_CC_KEY = "report_cc";

/** The profiles always copied on a report email (ids), as set in Settings */
export async function alwaysCopiedIds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("app_settings").select("value").eq("key", REPORT_CC_KEY).maybeSingle();
  if (error) return [];
  const ids = (data?.value as { profileIds?: unknown } | null)?.profileIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

/** Each line's own seat on the client (the ad platforms read their buyer seats) and its head */
const LINE_SEAT: Record<string, string> = { klaviyo: "email_strategist", email: "email_strategist", social: "social_manager" };
const LINE_HEAD: Record<string, string> = { meta: "head_of_meta", google: "head_of_google", klaviyo: "head_of_email", email: "head_of_email", social: "head_of_social" };

/**
 * Who is copied on a client's report email, only the people on that line: Meta and Google, the client's buyers on the
 * platform and that line's head; Email, the client's email strategist and the Head of Email; Social, the social manager
 * and the Head of Social. Plus the report's owner and the always-copied staff (Settings). Each address once, so a head
 * who sends the report themselves isn't copied twice, and never anyone already in To.
 */
export async function reportCc(admin: SupabaseClient, p: { clientId: string; platforms: (string | null | undefined)[]; owners: (string | null | undefined)[]; to: string[] }): Promise<string[]> {
  const platforms = [...new Set(p.platforms.filter((x): x is string => Boolean(x)))];
  const seatOf = async (pl: string) => {
    const role = LINE_SEAT[pl];
    if (!role) return clientBuyers(admin, p.clientId, pl).catch(() => [] as string[]);
    const { data } = await admin.from("client_assignments").select("profile_id").eq("client_id", p.clientId).eq("role", role);
    return (data ?? []).map((r) => r.profile_id as string);
  };
  const heads = [...new Set(platforms.map((pl) => LINE_HEAD[pl]).filter(Boolean))];
  const [seatLists, always, { data: headRows }] = await Promise.all([
    Promise.all(platforms.map(seatOf)),
    alwaysCopiedIds(admin),
    heads.length ? admin.from("profiles").select("id").eq("is_active", true).in("role", heads) : Promise.resolve({ data: [] as { id: string }[] }),
  ]);
  const ids = ccProfileIds({ owners: p.owners, buyers: [...seatLists.flat(), ...(headRows ?? []).map((h) => h.id as string)], always });
  const all = [...ids.buyers, ...ids.always];
  if (!all.length) return [];
  const { data } = await admin.from("profiles").select("id, email, is_active").in("id", all);
  const email = new Map(((data ?? []) as { id: string; email: string | null; is_active: boolean | null }[]).filter((x) => x.is_active !== false && x.email).map((x) => [x.id, x.email!]));
  return assembleCc({ to: p.to, buyers: ids.buyers.map((id) => email.get(id)), always: ids.always.map((id) => email.get(id)) });
}
