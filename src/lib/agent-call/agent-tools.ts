import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { chatTools, type ChatTool, type ToolCtx } from "@/lib/kaizen-ai/tools";
import { askTools } from "./ask-tools";
import { callCardTools, emailRequestTool } from "./call-cards";
import type { CallEvent } from "./core";
import { gateTools } from "./tool-loop";

// The lookups and asks an agent gets on a call and in its own chat: Kaizen AI's tools for this person (their rights,
// their line, exactly as the main chat narrows them), read-only ones as they are, anything that makes, sends or spends
// needing their yes, plus a reminder for them or a task for a teammate when asked. On a call, the card tools (a brief,
// a change plan, copy, a deck) and the Email Board request work too: made on the call's Kaizen AI thread and shown as
// a link card to review. In the agent's own chat (no call) card tools are left out: it proposes playbook edits there.

export async function agentTools(input: {
  me: Staff;
  db: SupabaseClient;
  admin: SupabaseClient;
  roleKey: string;
  label: string;
  callId: string | null;
  /** On a call: shows link cards on it */
  emit?: (e: CallEvent) => void;
  /** What the person said on this turn (reminders only when asked; gated actions only on a yes) */
  said?: string | null;
}): Promise<ChatTool[]> {
  const ctx: ToolCtx = { me: input.me, db: input.db, admin: input.admin, clientId: null, messageId: crypto.randomUUID(), cards: [], files: [] };
  const base = await chatTools(ctx).catch((e) => {
    console.error("[agent tools]", e instanceof Error ? e.message : e);
    return [] as ChatTool[];
  });
  const gated = gateTools([...base, ...askTools(ctx, { roleKey: input.roleKey, label: input.label, callId: input.callId, said: input.said ?? null })]);
  if (!input.callId || !input.emit) return gated;
  const cctx = { me: input.me, db: input.db, admin: input.admin, callId: input.callId, said: input.said ?? "", emit: input.emit, label: `the ${input.label}`, thread: { id: null as string | null } };
  const status = (name: string) => (i: Record<string, unknown>, c: string | null) => base.find((t) => t.name === name)?.status(i, c) ?? "Working on it…";
  const cards = [...callCardTools(cctx, ctx, base), ...emailRequestTool(cctx)].map((t) => ({ ...t, status: t.status ?? status(t.name) }));
  return [...gated, ...cards];
}

/** What every agent is told about its tools (on a call and in its chat) */
export const TOOLS_RULE = `You can look up the agency's live data with your tools: clients, their ad accounts, email, organic social, what changed, rankings of clients, emails, ads and posts, the client's package tier, and the team's Loom recordings (search_looms, read_loom: audits and walkthroughs, by client or topic). When asked about a client's numbers, a ranking or "who's doing best", use the tools and answer; never say you don't have the numbers in front of you, and never send the question to a person. You only see what the person you're talking with may see.
Pull the numbers first, then answer from them. Don't tag answers with "that's my general read" or "not backed by a client's own data": when the data is in the tools, read it and say what it shows. Only flag a gap when your playbook has no written Kaizen standard for the question, or the data is truly missing for that client, and then say it once, in a few words, and move on.
Ideas for a client (creative, campaigns, emails): start from the client's own winners, then what's working for similar clients (top_ads, top_emails, rank_clients, winners_and_fatigue), then the market (search_market_ads, client_swipe_file) when you have them. On a call you can draft a brief (create_brief) or an Email Board request (create_email_request) when asked: it ends in a link card to review.
Tools that make, send or spend something need a clear yes first. Reminders and tasks only when the person asks for one in so many words: remind_me for them (related things on one call go on ONE checklist), ask_teammate to make sure something gets done on a client, then say who you asked. Never make a reminder out of your own uncertainty: ask instead. Nothing ever goes to a client from here.`;
