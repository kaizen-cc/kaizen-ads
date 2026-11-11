"use server";

import { AiUnavailable, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { missingTable } from "@/lib/ticket-copy-writer";

// Questions about a ticket's brief, asked by the designer or editor before they start: answered by the AI with the
// brief, the client's context and the Brand Bible. Kept on ticket_brief_chat (20261111190000_ticket_stage_views.sql);
// before that's applied the conversation lives in the browser and is sent along with each question.

export type BriefChatMessage = { role: "user" | "assistant"; text: string; at: string; by: string | null };

const SYSTEM = `You answer questions about a creative brief at Kaizen Marketing, a paid social agency. The person asking is the designer or video editor about to make the creative. Answer from the brief, the client's context and their Brand Bible:
- Short and plain, like a senior creative on the team: one to four sentences, or a few bullets when they ask for a list. No emojis.
- Say where the answer comes from when it matters ("the brief's Must says...", "the Brand Bible's voice section...").
- When the brief doesn't settle it, say so plainly, give the best call from the client's context and rules, and say it's worth confirming with the media buyer. Never invent an offer, a price, a claim or an asset.
- Refer to people by their role (the media buyer, the Head of Creative, the client), never by name.`;

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

export async function briefChat(requestId: string): Promise<{ messages: BriefChatMessage[]; stored: boolean }> {
  await requireStaff();
  const { data, error } = await (await createClient()).from("ticket_brief_chat").select("role, body, author_name, created_at").eq("request_id", requestId).order("created_at").limit(100);
  if (missingTable(error)) return { messages: [], stored: false };
  return { messages: (data ?? []).map((m) => ({ role: m.role as "user" | "assistant", text: m.body as string, at: m.created_at as string, by: (m.author_name as string | null) ?? null })), stored: true };
}

/** Ask about the brief. history: the conversation as the browser has it (used when it isn't stored yet). */
export async function askAboutBrief(requestId: string, text: string, history: BriefChatMessage[] = []): Promise<{ ok: true; messages: BriefChatMessage[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  const q = text.trim().slice(0, 2000);
  if (!q) return { ok: false, error: "Ask a question." };
  const db = await createClient();
  const { data: r } = await db.from("board_requests").select("id, number, client_id, title, format, angle_name, audience, brief, sizes, new_count, variation_count, landing_url").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  const ctx = await clientContext(db, r.client_id);
  if (!ctx) return { ok: false, error: "You don't work on this client." };
  const stored = await briefChat(requestId);
  const earlier = (stored.stored ? stored.messages : history).slice(-12);
  try {
    const { sources } = await getAgent("briefing");
    const out = await askJson<{ answer: string }>({
      agent: "briefing",
      label: `brief question #${r.number}`,
      clientId: r.client_id,
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 4000,
      prompt: `${contextBlock(ctx, undefined, sources)}

<creative_ticket>
Title: ${r.title}
Format: ${r.format}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Sizes: ${(r.sizes ?? []).join(", ") || "not set"}
Versions: ${r.new_count} net new, ${r.variation_count} variations
Landing page: ${r.landing_url ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
</creative_ticket>
${earlier.length ? `\n<conversation>\n${earlier.map((m) => `${m.role === "user" ? "Maker" : "You"}: ${m.text}`).join("\n")}\n</conversation>\n` : ""}
The maker asks: ${q}`,
    });
    const now = Date.now();
    const mine: BriefChatMessage = { role: "user", text: q, at: new Date(now).toISOString(), by: me.fullName };
    const reply: BriefChatMessage = { role: "assistant", text: out.answer.trim(), at: new Date(now + 1).toISOString(), by: null };
    if (stored.stored && adminConfigured()) {
      await createAdminClient()
        .from("ticket_brief_chat")
        .insert([
          { request_id: r.id, client_id: r.client_id, role: "user", body: mine.text, author_id: me.id, author_name: me.fullName, created_at: mine.at },
          { request_id: r.id, client_id: r.client_id, role: "assistant", body: reply.text, author_id: null, author_name: null, created_at: reply.at },
        ]);
    }
    return { ok: true, messages: [...(stored.stored ? stored.messages : history), mine, reply] };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't answer that just now." };
  }
}
