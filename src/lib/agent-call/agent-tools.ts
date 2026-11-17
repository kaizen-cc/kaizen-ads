import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { chatTools, type ChatTool, type ToolCtx } from "@/lib/kaizen-ai/tools";
import { askTools } from "./ask-tools";
import { gateTools } from "./tool-loop";

// The lookups and asks an agent gets on a call and in its own chat: Kaizen AI's tools for this person (their rights,
// their line, exactly as the main chat narrows them), read-only ones as they are, card-only ones left out, anything
// that makes, sends or spends needing their yes, plus a reminder for them or a task for a teammate when asked.

export async function agentTools(input: { me: Staff; db: SupabaseClient; admin: SupabaseClient; roleKey: string; label: string; callId: string | null }): Promise<ChatTool[]> {
  const ctx: ToolCtx = { me: input.me, db: input.db, admin: input.admin, clientId: null, messageId: crypto.randomUUID(), cards: [], files: [] };
  const base = await chatTools(ctx).catch((e) => {
    console.error("[agent tools]", e instanceof Error ? e.message : e);
    return [] as ChatTool[];
  });
  return gateTools([...base, ...askTools(ctx, { roleKey: input.roleKey, label: input.label, callId: input.callId })]);
}

/** What every agent is told about its tools (on a call and in its chat) */
export const TOOLS_RULE = `You can look up the agency's live data with your tools: clients, their ad accounts, email, organic social, what changed, rankings of clients, emails, ads and posts. When asked about a client's numbers, a ranking or "who's doing best", use the tools and answer; never say you don't have the numbers in front of you, and never send the question to a person. You only see what the person you're talking with may see. Tools that make, send or spend something need a clear yes first. When the person asks you to remind them, use remind_me; when they ask you to make sure something gets done on a client, use ask_teammate, then say who you asked. Nothing ever goes to a client from here.`;
