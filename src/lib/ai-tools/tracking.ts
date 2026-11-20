import "server-only";
import { clientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stepsText } from "@/lib/tracking-core";
import { str, type AiTool } from "./types";

// The Tracking Engineer, for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   tracking_check    read one client's tracking (conversion events and their numbers, audit findings, watchdog
//                     flags, platform vs store orders, store and CRM connections) and answer with numbered steps
//   tracking_history  the latest checks on a client (asked for, or run on their own on a tracking flag or a CVR drop)
// To talk to the agent itself: open_screen place 'tracking engineer'.

const check: AiTool = {
  name: "tracking_check",
  description:
    "Anyone: the Tracking Engineer reads one client's actual tracking setup and numbers (the conversion event each ad account optimizes to with 3 to 90 day results, audit findings about tracking, open watchdog flags like spend with zero results or a lost store/CRM connection, the weekly review's platform-vs-store orders, the store and CRM connections) and answers with what's likely wrong and numbered steps: what to check or fix, where, what good looks like, and who does it. question: the problem in the person's words (\"Meta shows twice the purchases Shopify does\"), optional. Takes under a minute. To talk it through with the agent, open_screen place 'tracking engineer'.",
  input_schema: { type: "object", properties: { client: { type: "string" }, question: { type: "string" } }, required: ["client"], additionalProperties: false },
  run: async (user: Staff, input, chat) => {
    const db = await createClient();
    let c: { id: string; name: string };
    try {
      c = (await clientNamed(db, str(input.client) ?? "")) as { id: string; name: string };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Which client?" };
    }
    const { checkTracking } = await import("@/lib/tracking-agent");
    const r = await checkTracking(createAdminClient(), c.id, { question: str(input.question), by: user.id });
    if (!r.ok) return r;
    chat?.card({ type: "list", title: `Tracking check: ${c.name}`, items: r.check.steps.map((s) => ({ title: `${s.n}. ${s.do}`, detail: [s.where, s.good && `Good: ${s.good}`, s.who].filter(Boolean).join(" · ") })) });
    return { ok: true, client: c.name, summary: r.check.summary, likely: r.check.causes, steps: r.check.steps, signals: r.check.signals, text: stepsText(r.check), talk: "/settings?tab=agents&role=tracking_engineer#talk" };
  },
};

const history: AiTool = {
  name: "tracking_history",
  description: "The latest Tracking Engineer checks on a client (asked for, or run on their own when a tracking flag opened or the conversion rate dropped), newest first, with their steps.",
  input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"], additionalProperties: false },
  run: async (_user: Staff, input) => {
    const db = await createClient();
    let c: { id: string; name: string };
    try {
      c = (await clientNamed(db, str(input.client) ?? "")) as { id: string; name: string };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Which client?" };
    }
    const { data } = await db.from("tracking_checks").select("created_at, trigger, question, result").eq("client_id", c.id).order("created_at", { ascending: false }).limit(5);
    return { ok: true, client: c.name, checks: (data ?? []).map((x) => ({ at: String(x.created_at).slice(0, 16), why: x.trigger, question: x.question, result: x.result })) };
  },
};

export const tools: AiTool[] = [check, history];
