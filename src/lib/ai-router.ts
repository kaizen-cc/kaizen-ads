import "server-only";
import { askJson, type Effort, type ModelKey } from "@/lib/ai";

// How much AI a chat message deserves. A quick read of the message (the fast model, about a second) sorts it:
// quick (a fact or a summary), standard (advice on one account), or deep (strategy, the market, across clients), and
// whether it needs fresh outside research. The level picks the model and effort, never above what the agent is set
// to in Settings (its ceiling); "Go deep" asks for the ceiling outright. The models already think adaptively within
// that effort, so a quick question at a high ceiling still comes back fast.

export type Level = "quick" | "standard" | "deep";
export type Route = { level: Level; research: boolean; why: string; model: ModelKey; effort: Effort };

const LEVEL: Record<Level, { model: ModelKey; effort: Effort }> = {
  quick: { model: "sonnet", effort: "low" },
  standard: { model: "opus", effort: "medium" },
  deep: { model: "opus", effort: "high" },
};
const MODEL_RANK: Record<ModelKey, number> = { haiku: 0, sonnet: 1, opus: 2 };
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/** The level's model and effort, held under the agent's own setting. */
export function within(level: Level, ceiling: { model: ModelKey; effort: Effort }) {
  const want = LEVEL[level];
  return {
    model: MODEL_RANK[want.model] > MODEL_RANK[ceiling.model] ? ceiling.model : want.model,
    effort: EFFORT_RANK[want.effort] > EFFORT_RANK[ceiling.effort] ? ceiling.effort : want.effort,
  };
}

const SYSTEM = `You sort one message sent to an AI teammate at a paid social agency, to decide how much thinking it needs.
quick: a fact, a lookup or a summary of what's known ("what's their KPI", "what did the client say last week", "summarize this account", "who's the buyer"), or small talk.
standard: advice or a judgement on one account or one piece of work ("should we pause this campaign", "what should we test next", "is this brief any good").
deep: strategy, the market, trends, comparisons across clients or industries, new ideas with real stakes ("what market gap in restaurants will boom our business", "how should we restructure all our ecommerce accounts", "plan Q1 for our med spas").
research: true only when a good answer needs current information from outside what the agency already holds (market trends, what competitors are doing now, recent platform changes, news); false for anything about our own clients and data.
why: a few words.`;

const SCHEMA = { type: "object", properties: { level: { type: "string", enum: ["quick", "standard", "deep"] }, research: { type: "boolean" }, why: { type: "string" } }, required: ["level", "research", "why"], additionalProperties: false };

/** Words that mark a big question, for when the quick read isn't available. */
const DEEP = /\b(market|trend|gap|opportunit|industry|strategy|strategi|across (all|our)|every client|q[1-4]|quarter|plan (the|our|for)|boom|scale (our|the) (agency|business))/i;

/** Sorts the message and picks its model and effort under the agent's ceiling. deep: the person asked to go deep. */
export async function routeMessage(message: string, ceiling: { model: ModelKey; effort: Effort }, deep = false): Promise<Route> {
  if (deep) return { level: "deep", research: DEEP.test(message), why: "asked to go deep", ...ceiling };
  let r: { level: Level; research: boolean; why: string };
  try {
    r = await askJson({ agent: "briefing", label: "route a chat message", system: SYSTEM, schema: SCHEMA, maxTokens: 1500, prompt: message.slice(0, 3000), override: { model: "haiku", effort: "low" }, bare: true });
  } catch {
    r = DEEP.test(message) ? { level: "deep", research: /market|trend|competitor|news|right now|lately/i.test(message), why: "big question" } : message.length < 140 ? { level: "quick", research: false, why: "short question" } : { level: "standard", research: false, why: "advice" };
  }
  return { ...r, ...within(r.level, ceiling) };
}

/** What the person sees on the answer. */
export const LEVEL_LABEL: Record<Level, string> = { quick: "Quick answer", standard: "Considered", deep: "Thought it through" };
