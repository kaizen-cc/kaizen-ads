// What the AI costs: Anthropic's list prices and how each call's tokens turn into dollars, the activities the app's AI
// work falls into, and how switching an agent's model or effort moves its cost. Shared by the Expenses page and the
// model picker, so both price the same way. Prices from platform.claude.com/docs/en/about-claude/pricing (Oct 2026).

export type ModelKey = "opus" | "sonnet" | "haiku";
export type Effort = "low" | "medium" | "high";

/** Dollars per million tokens: input, output, 5-minute cache write, cache read */
export const PRICES: Record<ModelKey, { in: number; out: number; cacheW: number; cacheR: number }> = {
  opus: { in: 4, out: 20, cacheW: 5, cacheR: 0.2 },
  sonnet: { in: 2, out: 10, cacheW: 2.5, cacheR: 0.1 },
  haiku: { in: 0.1, out: 0.5, cacheW: 0.125, cacheR: 0.01 },
};
/** Web search: $10 per 1,000 searches (web fetch has no fee beyond its tokens) */
export const SEARCH_PRICE = 0.01;

export type Usage = { runs: number; failed: number; input: number; output: number; cacheW: number; cacheR: number; searches: number };
export const emptyUsage = (): Usage => ({ runs: 0, failed: 0, input: 0, output: 0, cacheW: 0, cacheR: 0, searches: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  runs: a.runs + b.runs,
  failed: a.failed + b.failed,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheW: a.cacheW + b.cacheW,
  cacheR: a.cacheR + b.cacheR,
  searches: a.searches + b.searches,
});
const modelOf = (m: string | null | undefined): ModelKey => (m === "haiku" || m === "sonnet" ? m : "opus");

/** What these tokens cost on this model (Haiku's long-prompt tier aside) */
export function costOf(model: string | null | undefined, u: Usage) {
  const p = PRICES[modelOf(model)];
  return (u.input * p.in + u.output * p.out + u.cacheW * p.cacheW + u.cacheR * p.cacheR) / 1e6 + u.searches * SEARCH_PRICE;
}
/** What reading from the cache saved against paying full input price for those tokens */
export const cacheSaved = (model: string | null | undefined, u: Usage) => (u.cacheR * (PRICES[modelOf(model)].in - PRICES[modelOf(model)].cacheR)) / 1e6;

/**
 * How effort moves the answer's length (thinking counts as output). A starting estimate from how these models
 * behave, not a measured figure: low writes about half as much as medium, high about half as much again.
 */
export const EFFORT_OUTPUT: Record<Effort, number> = { low: 0.55, medium: 1, high: 1.5 };

/** The same work on another model or effort: tokens repriced, output scaled by the effort change */
export function costIf(byModel: Partial<Record<ModelKey, Usage>>, from: Effort, to: { model: ModelKey; effort: Effort }) {
  const scale = EFFORT_OUTPUT[to.effort] / EFFORT_OUTPUT[from];
  let total = 0;
  for (const u of Object.values(byModel)) if (u) total += costOf(to.model, { ...u, output: u.output * scale });
  return total;
}

// What the AI work is, by activity (whatever agent does it)
export const ACTIVITIES = [
  { key: "bibles", label: "Brand Bibles & strategies", about: "Building each client's Brand Bible and go-to-market strategy: web research, then the document" },
  { key: "audits", label: "Account audits & sprints", about: "Meta and Google audits, and the sprint check-ins that follow them" },
  { key: "reading", label: "Reading calls, docs & messages", about: "Call notes, Drive docs and shared files read for each client; unanswered messages and promises" },
  { key: "briefings", label: "Briefings & recaps", about: "Client briefings and the daily recap" },
  { key: "market", label: "Market & winners research", about: "Competitor ads from Motion, winners and Hall of Fame, vertical benchmarks and playbooks" },
  { key: "creative", label: "Creative planning", about: "Suggested briefs, refreshes for tiring ads, scripts and the monthly allotment" },
  { key: "review", label: "Copy & creative review", about: "Ad copy, the AI review of designs and videos, delivery checks" },
  { key: "reports", label: "Client reports", about: "Report drafts and their number checks" },
  { key: "launches", label: "Launches", about: "Placing and naming ads at launch" },
  { key: "conversations", label: "Conversations", about: "The client desk, Ads Lab, and the agent and skill training chats" },
  { key: "other", label: "Other", about: "Smaller jobs" },
] as const;
export type Activity = (typeof ACTIVITIES)[number]["key"];

/** The activity an AI call belongs to, from the skill that ran it and what its label says it was */
export function activityOf(agentKey: string | null, kind: string | null): Activity {
  const k = (kind ?? "").toLowerCase();
  if (/^(client desk|agent chat|coach|lab round table|copy chat|ask )/.test(k)) return "conversations";
  switch (agentKey) {
    case "brandbible":
    case "gtm":
      return "bibles";
    case "auditor":
    case "google_auditor":
      return "audits";
    case "calls":
      return "reading";
    case "briefing":
      return "briefings";
    case "market":
    case "winners":
    case "verticals":
    case "industry":
      return "market";
    case "strategist":
    case "suggest":
    case "scripts":
      return "creative";
    case "copy":
    case "review":
    case "creativereview":
    case "creativecheck":
      return "review";
    case "reporter":
    case "google_reporter":
    case "report_qa":
      return "reports";
    case "launcher":
    case "google_launcher":
    case "fatigue":
      return "launches";
    case "coach":
    case "lab":
      return "conversations";
    default:
      return "other";
  }
}

/** What moving a skill to this model or effort means for the work, in plain words */
export const TRADEOFFS: Record<ModelKey, { good: string; watch: string }> = {
  opus: { good: "The strongest judgment: strategy, audits, Brand Bibles, anything a client reads.", watch: "The most expensive, and slower." },
  sonnet: { good: "Close to Opus on most writing and analysis at half the price, and quicker.", watch: "Weaker on long, many-step judgment: deep audits and strategy can get shallower." },
  haiku: { good: "About a fortieth of Opus's price and very fast: sorting, labelling, short summaries.", watch: "Misses nuance: not for strategy, client-facing writing or anything with many rules to follow." },
};
export const EFFORT_TRADEOFFS: Record<Effort, { good: string; watch: string }> = {
  low: { good: "Shortest answers, lowest cost, fastest.", watch: "Thinks less before answering: more misses on tricky cases." },
  medium: { good: "The balance: thinks when it needs to.", watch: "" },
  high: { good: "Thinks hardest: best on complex, multi-part jobs.", watch: "Longer, slower answers; output (the expensive part) grows." },
};
