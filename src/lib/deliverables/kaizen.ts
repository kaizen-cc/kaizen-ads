import "server-only";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";
import { deliverableTools } from "./tools";
import { chatCardOf } from "./kaizen-core";

// The deliverable flow's tools in Kaizen AI chat: the assistant's own tools (deliverable, create_copy_doc,
// approve_copy_doc, and per line the request and its fixes), run on the thread. The thread is the flow's "call".
// Cards they show land on the message.

export const DELIVERABLE_TOOL_NAMES = ["deliverable", "create_copy_doc", "approve_copy_doc", "add_copy_to_google_doc", "create_email_request", "update_email_request", "create_creative_request", "update_creative_request", "create_social_request", "update_social_request"];

export async function deliverableChatTools(ctx: ToolCtx): Promise<ChatTool[]> {
  if (!ctx.threadId) return [];
  return deliverableTools({
    me: ctx.me,
    db: ctx.db,
    admin: ctx.admin,
    callId: ctx.threadId,
    said: () => ctx.said ?? "",
    roleKey: ctx.agent ?? "strategist",
    persona: true,
    emit: (e) => {
      if (e.t === "card") ctx.cards.push(chatCardOf(e.card));
    },
  }).map((t) => ({ ...t, status: t.status ?? (() => "Working on it…") }) as ChatTool);
}
