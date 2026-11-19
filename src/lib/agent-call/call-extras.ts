import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { canSeeReports } from "@/lib/roles";
import { contextPrompt, looksLikeLook, type CallContext, type ContextFacts } from "./call-context";
import type { CallEvent } from "./core";
import type { LoopTool } from "./tool-loop";

// What a call adds to the agent's turn beyond its playbook: where the person called from (the client, the report, the
// Kaizen AI thread, read through their own session so it's only what they can see), "take a look" (a tool the agent
// calls when it needs to see their screen, and the screenshot itself when one comes with the turn).

/** The context block for the prompt: the client, report and chat the person called from (empty when there's none) */
export async function contextBlock(db: SupabaseClient, ctx: CallContext | null | undefined, me: Pick<Staff, "role" | "isExec">): Promise<string> {
  if (!ctx) return "";
  const facts: ContextFacts = { screen: ctx.screen };
  const [client, report, thread] = await Promise.all([
    ctx.clientId ? db.from("clients").select("name").eq("id", ctx.clientId).maybeSingle() : null,
    // Reports are for those who may open them (executives, media buyers, the email and social teams), never the makers
    ctx.reportId && canSeeReports(me) ? db.from("reports").select("kind, platform, status, period_start, period_end, message, sections, qa, clients(name)").eq("id", ctx.reportId).maybeSingle() : null,
    ctx.threadId ? db.from("ai_threads").select("id, title, clients(name)").eq("id", ctx.threadId).maybeSingle() : null,
  ]);
  if (client?.data?.name) facts.client = { name: String(client.data.name) };
  const r = report?.data as { kind: string; platform: string; status: string; period_start: string; period_end: string; message: string | null; sections: unknown; qa: { flags?: unknown[] } | null; clients: { name: string } | { name: string }[] | null } | null | undefined;
  if (r) {
    const c = Array.isArray(r.clients) ? r.clients[0] : r.clients;
    facts.report = {
      client: c?.name ?? null,
      platform: r.platform === "klaviyo" ? "email" : r.platform,
      kind: r.kind,
      period: `${r.period_start} to ${r.period_end}`,
      status: r.status,
      message: String(r.message ?? ""),
      sections: r.sections ? JSON.stringify(r.sections) : "",
      checks: Array.isArray(r.qa?.flags) ? r.qa.flags.length : 0,
    };
    if (!facts.client && c?.name) facts.client = { name: c.name };
  }
  const t = thread?.data as { id: string; title: string | null; clients: { name: string } | { name: string }[] | null } | null | undefined;
  if (t) {
    const { data: rows } = await db.from("ai_messages").select("role, content").eq("thread_id", t.id).order("created_at", { ascending: false }).limit(12);
    const c = Array.isArray(t.clients) ? t.clients[0] : t.clients;
    facts.thread = {
      title: String(t.title ?? "A chat"),
      client: c?.name ?? null,
      turns: ((rows ?? []) as { role: string; content: string | null }[])
        .reverse()
        .filter((m) => (m.content ?? "").trim())
        .map((m) => ({ who: m.role === "user" ? ("them" as const) : ("ai" as const), text: String(m.content) })),
    };
    if (!facts.client && c?.name) facts.client = { name: c.name };
  }
  return contextPrompt(facts);
}

/** The tool an agent calls when it needs to see the person's screen */
export function lookTool(emit: (e: CallEvent) => void): LoopTool {
  let asked = false;
  return {
    name: "look_at_screen",
    description:
      "See what's on their screen right now: a screenshot of the screen they share on a computer, or one they upload on a phone. Use it when they ask you to look at, check or see something on their screen, or when what they ask only makes sense if you can see it. Not for looking up numbers (use your other tools for that). After calling it, say one short line like 'Let me take a look.' and stop: the screenshot comes to you as their next message.",
    input_schema: { type: "object", properties: { what: { type: "string", description: "What you want to see, in a few words" } }, additionalProperties: false },
    run: async () => {
      if (!asked) emit({ t: "look" });
      asked = true;
      return "Asked for their screen. Say one short line like 'Let me take a look.' and stop. Don't describe anything you haven't seen yet. If they're on a computer and not sharing yet, the call asks them to pick a tab, window or screen to share.";
    },
  };
}

/** The hint for a turn that sounds like a look, so the agent reaches for the tool (it still decides) */
export const lookHint = (text: string, hasFrame: boolean) =>
  !hasFrame && looksLikeLook(text) ? "<hint>They may want you to see their screen. If so, call look_at_screen; if they mean data you can look up, use your other tools.</hint>" : "";

export type Frame = { mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string };

/** The screenshot that came with this turn: only one of this call's own, under the person's folder, a few MB at most */
export async function loadFrame(admin: SupabaseClient, me: Staff, callId: string, path: unknown): Promise<Frame | null> {
  if (typeof path !== "string" || !path.startsWith(`${me.id}/call-${callId}/`) || path.includes("..")) return null;
  const mediaType = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : /\.jpe?g$/i.test(path) ? "image/jpeg" : null;
  if (!mediaType) return null;
  const { data } = await admin.storage.from(AI_BUCKET).download(path);
  if (!data || data.size > 4_500_000) return null;
  return { mediaType, data: Buffer.from(await data.arrayBuffer()).toString("base64") };
}

/** A turn's content for the model: the screenshot first (when there is one), then the words */
export function withFrame(text: string, frame: Frame | null): string | unknown[] {
  if (!frame) return text;
  return [
    { type: "image", source: { type: "base64", media_type: frame.mediaType, data: frame.data } },
    { type: "text", text: `${text}\n\n<their_screen>The picture above is their screen right now. Answer what they asked about it, in a few spoken sentences: what you see that matters, not a description of everything.</their_screen>` },
  ];
}
