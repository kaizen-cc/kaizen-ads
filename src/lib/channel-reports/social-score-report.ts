import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSocialScores } from "@/lib/social-score-load";
import { reportScoreOf, type SocialReportScore } from "./social-report";

/** The client's social score over the 30 days to a report's last day, as the report keeps it (null when nothing is scored; never throws) */
export async function socialReportScore(admin: SupabaseClient, clientId: string, end: string): Promise<SocialReportScore | null> {
  try {
    const got = (await loadSocialScores(admin, [clientId], end)).get(clientId);
    return got ? reportScoreOf(got) : null;
  } catch {
    return null;
  }
}
