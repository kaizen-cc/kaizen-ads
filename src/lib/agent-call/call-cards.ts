import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";
import type { Card } from "@/lib/kaizen-ai/types";
import { safeAppPath, safeLink } from "@/lib/assistant/core";
import type { CallCard, CallEvent } from "./core";
import { CARD_TOOLS, type LoopTool } from "./tool-loop";

// Card tools on a call, for the assistant and every agent alike: a brief, a change plan, a launch, copy or a deck is
// made exactly as in Kaizen AI's chat, saved on a Kaizen AI thread for this call (made on first use and kept on the
// call's row, so every turn uses the same one), and shown on the call as a link card to review it there. Nothing is
// sent or changed until it's confirmed on the card. Email requests are the deliverable flow's (src/lib/deliverables).

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
