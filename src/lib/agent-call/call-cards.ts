import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";
import type { Card } from "@/lib/kaizen-ai/types";
import { safeAppPath, safeLink, saidYes } from "@/lib/assistant/core";
import { seesEmailBoard } from "@/lib/roles";
import type { CallCard, CallEvent } from "./core";
import { CARD_TOOLS, type LoopTool } from "./tool-loop";

// Card tools on a call, for the assistant and every agent alike: a brief, a change plan, a launch, copy or a deck is
// made exactly as in Kaizen AI's chat, saved on a Kaizen AI thread for this call (made on first use and kept on the
// call's row, so every turn uses the same one), and shown on the call as a link card to review it there. Nothing is
// sent or changed until it's confirmed on the card. Plus the Email Board request (the email team and execs), which
// makes a ticket in Copy for review after a spoken yes, ending in a link card to the ticket.

export type CardCtx = {
  me: Staff;
  db: SupabaseClient;
  admin: SupabaseClient;
  callId: string;
  /** What the person said on this turn (a gated action runs only on a clear yes) */
  said: string;
  emit: (e: CallEvent) => void;
  /** Whose call it is in the thread's title ("your assistant", "the Creative Director") */
  label: string;
  /** The call's Kaizen AI thread, once made (shared with the assistant's call state) */
  thread: { id: string | null };
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cardId = () => crypto.randomUUID().slice(0, 8);
export const showCard = (ctx: Pick<CardCtx, "emit">, c: Omit<CallCard, "id">) => ctx.emit({ t: "card", card: { id: cardId(), ...c } });
const NO_YES = "Not run: say in one sentence exactly what this will do and ask; run it again with confirmed: true only once they clearly say yes.";
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to this exact action on this turn" };

/** The call's thread: the one already on its row, or a new one */
async function threadOf(ctx: CardCtx): Promise<string> {
  if (ctx.thread.id) return ctx.thread.id;
  const { data: call } = await ctx.admin.from("ai_role_calls").select("thread_id").eq("id", ctx.callId).maybeSingle();
  if (call?.thread_id) return (ctx.thread.id = call.thread_id as string);
  const day = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const { data: t, error } = await ctx.admin.from("ai_threads").insert({ profile_id: ctx.me.id, title: `Call with ${ctx.label} · ${day}`, model: "sonnet" }).select("id").single();
  if (error || !t) throw new Error("Couldn't open a place for it in Kaizen AI.");
  await ctx.admin.from("ai_role_calls").update({ thread_id: t.id }).eq("id", ctx.callId);
  return (ctx.thread.id = t.id as string);
}

/** A message on the call's thread for a card tool to write into */
async function cardMessage(ctx: CardCtx, tctx: ToolCtx, label: string): Promise<string> {
  const thread = await threadOf(ctx);
  await ctx.admin.from("ai_messages").insert({ thread_id: thread, role: "user", content: clip(ctx.said, 4000) || "(on the call)" });
  const { data: m, error } = await ctx.admin.from("ai_messages").insert({ thread_id: thread, role: "assistant", content: `From our call: ${label}.` }).select("id").single();
  if (error || !m) throw new Error("Couldn't save it to Kaizen AI.");
  await ctx.admin.from("ai_threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread);
  tctx.messageId = m.id as string;
  tctx.cards.length = 0;
  return m.id as string;
}

/** A card the chat tool made, as a link card on the call */
export function cardLink(thread: string, c: Card): Omit<CallCard, "id"> {
  const home = `/ai?t=${thread}`;
  const r = c as unknown as Record<string, unknown>;
  if (c.type === "link") {
    const l = safeLink(r.href);
    return { title: clip(r.title, 120), detail: clip(r.detail, 160), href: l?.href ?? home, external: l?.external ?? false, cta: clip(r.cta, 40) || "Open" };
  }
  if (c.type === "brief") return { title: `Brief: ${clip(r.title, 100)}`, detail: "Review it, then brief it to the board", href: safeAppPath(r.href) ?? home, external: false, cta: "Review the brief" };
  if (c.type === "plan") return { title: `Change plan for ${clip(r.client, 60)}`, detail: "Check the exact changes and confirm there", href: home, external: false, cta: "Review the plan" };
  if (c.type === "launch") return { title: `Launch for ${clip(r.client, 60)}`, detail: "The checklist and questions are on the card", href: home, external: false, cta: "Open the launch" };
  return { title: "From our call", detail: "Saved in Kaizen AI", href: home, external: false, cta: "Open" };
}

/** The person's card tools (already narrowed to their rights), working on a call */
export function callCardTools(ctx: CardCtx, tctx: ToolCtx, base: readonly ChatTool[]): LoopTool[] {
  return base
    .filter((t) => CARD_TOOLS.has(t.name))
    .map((t) => ({
      ...t,
      description: `${t.description} On a call: the card is saved to a Kaizen AI thread for this call and shown on the call as a link card to review it; nothing is sent or changed until they confirm it there. Say what you made in a sentence and that the card is on screen.`,
      run: async (input: Record<string, unknown>) => {
        await cardMessage(ctx, tctx, t.status(input, null).replace(/…$/, ""));
        const out = await t.run(input);
        if (tctx.cards.length) {
          await ctx.admin.from("ai_messages").update({ cards: tctx.cards }).eq("id", tctx.messageId);
          for (const c of tctx.cards) showCard(ctx, cardLink(ctx.thread.id ?? "", c));
        }
        return out;
      },
    }));
}

/** The client named, if this person may see it (their own session decides) */
async function clientNamed(db: SupabaseClient, name: unknown): Promise<{ id: string; name: string; slug: string }> {
  const asked = clip(name, 120);
  if (!asked) throw new Error("Which client?");
  const safe = asked.replace(/[%_,()]/g, " ").trim();
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).ilike("name", `%${safe}%`).limit(5);
  const hit = (data ?? []).find((c) => String(c.name).toLowerCase() === asked.toLowerCase()) ?? (data ?? [])[0];
  if (!hit) throw new Error(`No client called "${asked}" that you can see.`);
  return hit as { id: string; name: string; slug: string };
}

/** The Email Board request, for the email team and execs (others don't get it) */
export function emailRequestTool(ctx: CardCtx, after?: () => void): LoopTool[] {
  if (!seesEmailBoard(ctx.me)) return [];
  return [
    {
      name: "create_email_request",
      description:
        "Creates an Email Board ticket for a client as the person (the email team and execs only): the AI writes the brief from the idea, then the ticket starts in Copy for review and a link card to it shows on the call. A campaign batch is up to 5 emails, a flow up to 6 messages (texts allowed). Nothing goes to the client. Ask first, confirmed: true after a yes.",
      input_schema: {
        type: "object",
        properties: { client: { type: "string", description: "The client's name" }, kind: { type: "string", enum: ["batch", "flow"] }, idea: { type: "string" }, count: { type: "integer" }, due: { type: "string", description: "YYYY-MM-DD" }, texts: { type: "boolean" }, priority: { type: "string", enum: ["normal", "high", "urgent"] }, confirmed: CONFIRMED },
        required: ["client", "kind", "idea"],
        additionalProperties: false,
      },
      status: (input) => `Writing the email request for ${clip(input.client, 60) || "the client"}…`,
      run: async (input) => {
        if (input.confirmed !== true || !saidYes(ctx.said)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
        const { writeEmailBrief, createEmailTicket } = await import("@/app/(team)/board/email/new/actions");
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due ?? "")) ? String(input.due) : null;
        const brief = await writeEmailBrief({ clientId: c.id, kind: input.kind === "flow" ? "flow" : "batch", idea: clip(input.idea, 2000), count: Number(input.count) || null, dueOn: due, texts: input.texts === true });
        if (!brief.ok) return { done: false, error: brief.error };
        const t = await createEmailTicket({ clientId: c.id, draft: brief.draft, priority: input.priority === "urgent" || input.priority === "high" ? input.priority : "normal", dueOn: due, suggestionId: null });
        if (!t.ok) return { done: false, error: t.error };
        showCard(ctx, { title: `Email #${t.number}: ${clip(brief.draft.title, 80)}`, detail: `${c.name} · Copy for review`, href: `/board/email?t=${t.number}`, external: false, cta: "Review the ticket" });
        after?.();
        return { created: true, number: t.number, title: brief.draft.title, note: "The ticket's card is on screen. Say it's in Copy for review." };
      },
    },
  ];
}
