import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ENGAGEMENT_BAR } from "@/lib/social-score";
import { loadSocialScores } from "@/lib/social-score-load";

/**
 * The engagement target a client's report holds its rates to (its own when it has one, else Kaizen's 5%). The score itself
 * is read here only to find that target and is never kept on a report: it is internal. Never throws.
 */
export async function socialEngagementTarget(admin: SupabaseClient, clientId: string, end: string): Promise<number> {
  try {
    const got = (await loadSocialScores(admin, [clientId], end)).get(clientId);
    return got?.checks.find((c) => c.key === "engagement")?.bar ?? DEFAULT_ENGAGEMENT_BAR;
  } catch {
    return DEFAULT_ENGAGEMENT_BAR;
  }
}
