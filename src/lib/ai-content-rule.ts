import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiContentRule, type AiRule, type AiRuleSources } from "@/lib/ai-content";

// Whether a client takes AI content, read from what they told us: client memory, the Brand Bible's dos-and-don'ts log
// (a lifted rule opens the door again) and what they said on calls. Three small reads; the brief check, the AI media
// panels and Kaizen AI ask it per client. The rule itself is src/lib/ai-content.ts.

/** Every string in a call's summary (what the client said, decisions, the summary), whatever its shape */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

export async function aiRuleSources(db: SupabaseClient, clientId: string): Promise<AiRuleSources> {
  const [{ data: memory }, { data: rules }, { data: calls }] = await Promise.all([
    db.from("client_memory").select("kind, body").eq("client_id", clientId).eq("status", "active").limit(300),
    db.from("client_bible_rules").select("rule, polarity, status").eq("client_id", clientId).limit(200),
    db.from("call_mentions").select("summary").eq("client_id", clientId).limit(60),
  ]);
  return {
    memory: (memory ?? []) as AiRuleSources["memory"],
    rules: (rules ?? []) as AiRuleSources["rules"],
    notes: (calls ?? []).flatMap((c) => stringsOf(c.summary)),
  };
}

/** The client's AI content rule (allowed, or the statement that says no). Never throws: unreadable means allowed. */
export async function loadAiRule(db: SupabaseClient, clientId: string): Promise<AiRule> {
  try {
    return aiContentRule(await aiRuleSources(db, clientId));
  } catch {
    return { allowed: true, rule: null, source: null };
  }
}
