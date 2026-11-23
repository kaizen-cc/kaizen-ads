import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { chatTools, type ChatTool, type ToolCtx } from "@/lib/kaizen-ai/tools";
import { askTools } from "./ask-tools";
import { callCardTools } from "./call-cards";
import { deliverableTools } from "@/lib/deliverables/tools";
import type { CallEvent } from "./core";
import { gateTools } from "./tool-loop";
import { commsTools } from "@/lib/assistant/comms-tools";

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
  /** The screen they're on (a path), where they called from, and the client the call is about */
  path?: string | null;
  screen?: string | null;
  clientId?: string | null;
}): Promise<ChatTool[]> {
  const ctx: ToolCtx = { me: input.me, db: input.db, admin: input.admin, clientId: null, messageId: crypto.randomUUID(), cards: [], files: [], said: input.said ?? undefined, emit: input.emit, agent: input.roleKey };
  const base = await chatTools(ctx).catch((e) => {
    console.error("[agent tools]", e instanceof Error ? e.message : e);
    return [] as ChatTool[];
  });
  // The team and their messages, feedback and a client at risk: the same tools the assistant has
  const comms = commsTools({ me: input.me, db: input.db, admin: input.admin, callId: input.callId, said: () => input.said ?? "", emit: input.emit, roleKey: input.roleKey, label: input.label, path: input.path ?? null, screen: input.screen ?? null, clientId: input.clientId ?? null });
  const gated = gateTools([...base, ...askTools(ctx, { roleKey: input.roleKey, label: input.label, callId: input.callId, said: input.said ?? null }), ...comms]);
  // The deliverable flow (strategist leads, writer drafts, requests on a yes): they check the person's yes themselves
  const flow = deliverableTools({ me: input.me, db: input.db, admin: input.admin, callId: input.callId, said: () => input.said ?? "", emit: input.emit, roleKey: input.roleKey }).map((t) => ({ ...t, status: t.status ?? (() => "Working on it…") }));
  if (!input.callId || !input.emit) return [...gated, ...flow];
  const cctx = { me: input.me, db: input.db, admin: input.admin, callId: input.callId, said: input.said ?? "", emit: input.emit, label: `the ${input.label}`, thread: { id: null as string | null } };
  const status = (name: string) => (i: Record<string, unknown>, c: string | null) => base.find((t) => t.name === name)?.status(i, c) ?? "Working on it…";
  const cards = callCardTools(cctx, ctx, base).map((t) => ({ ...t, status: t.status ?? status(t.name) }));
  return [...gated, ...cards, ...flow];
}

/** What every agent is told about its tools (on a call and in its chat) */
export const TOOLS_RULE = `You can look up the agency's live data with your tools: clients, their ad accounts, email, organic social, what changed, rankings of clients, emails, ads and posts, the client's package tier, and the team's Loom recordings (search_looms, read_loom: audits and walkthroughs, by client or topic). When asked about a client's numbers, a ranking or "who's doing best", use the tools and answer; never say you don't have the numbers in front of you, and never send the question to a person. You only see what the person you're talking with may see.
Pull the numbers first, then answer from them. Don't tag answers with "that's my general read" or "not backed by a client's own data": when the data is in the tools, read it and say what it shows. Only flag a gap when your playbook has no written Kaizen standard for the question, or the data is truly missing for that client, and then say it once, in a few words, and move on.
Ideas for a client (creative, campaigns, emails): start from the client's own winners, then what's working for similar clients (top_ads, top_emails, rank_clients, winners_and_fatigue), then the market (search_market_ads, client_swipe_file) when you have them. On a call you can draft a brief (create_brief) or an Email Board request (create_email_request) when asked: it ends in a link card to review.
Tools that make, send or spend something need a clear yes first, and one yes is enough: if it fails on our side, run it again without asking again. Reminders and tasks when the person asks, however they put it: remind_me for them (related things on one call go on ONE checklist); ask_teammate to make sure something gets done on a client, or send_to_teammate for anyone by name or role, then say who you asked. A yes to a hand-off you proposed, or a correction of who it goes to ("it should be on the Meta buyer"), IS the ask: send what you'd drafted. Offered two options and they say "yes": take the one they named, or ask once in a few words. Never ask them to repeat a phrase, and never say the system needs a clearer ask. On a client, hand off and offer hand-offs only to roles on lines the client buys (client_team shows its lines and seats); "the buyer" or "the strategist" means your own line's seat. Never make a reminder out of your own uncertainty: ask instead. "Submit feedback", "report a bug", "I have an idea" is submit_feedback; a client probably leaving is flag_client_risk (say so in a few words). Nothing ever goes to a client from here, except a message drafted as the person (draft_message) and sent on their yes (send_message). "Put it in my Gmail drafts" or "I'll send it myself" is save_draft (their own Gmail drafts, or their Slack self-DM), no yes needed since nothing leaves. 
Getting a task done (a client email, a recap, an SOW, a proposal): do everything you can with what you have before asking anything. Look things up yourself first (find_email_address for every person named, their Gmail and Drive, the client's documents and handoff doc, client_wins and package_details for the numbers and the tiers); never ask the person for something a tool can find. Where a detail is missing, use a sensible default and label it ("starting on Basic, Silver once the milestones are met"). Then ask everything that's still open ONCE, together, at the end. When they answer, finish the whole thing in one go: apply every value they confirmed to every piece you're making (the PDF drawn again with confirmed_prices, the email redrafted with it attached, saved to their drafts when they said so) without asking "want me to…" again. Read what they asked for: an SOW "to pitch" ongoing work is a pitch proposal, not a record of a signed scope.`;
