import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailScore } from "@/lib/email-score";
import { loadEmailScore } from "@/lib/email-score-load";

// The one place the email ops code reads an account's score. The score board's loader (src/lib/email-score-load.ts)
// returns the EmailScore with its inputs; this takes the EmailScore out of whatever wrapper it comes in, so an audit, a
// sprint and the chat all judge an account by exactly the number the board shows.

const isScore = (v: unknown): v is EmailScore => Boolean(v) && typeof v === "object" && typeof (v as EmailScore).score === "number" && Array.isArray((v as EmailScore).checks);

/** The client's email score now, or null when there is nothing to score (no Klaviyo numbers) */
export async function emailScoreOf(admin: SupabaseClient, clientId: string): Promise<EmailScore | null> {
  const r: unknown = await loadEmailScore(admin, clientId);
  if (isScore(r)) return r;
  const inner = (r as { score?: unknown } | null)?.score;
  return isScore(inner) ? inner : null;
}
