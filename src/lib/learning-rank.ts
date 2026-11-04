// Which of the team's learnings a call should see, and when a learning may widen beyond one client. Pure logic, so
// it's tested on its own (tests/learnings.test.ts); src/lib/learnings.ts reads and writes them.

export type LearningScope = "client" | "vertical" | "model" | "everyone";
export type LearningKind = "exception" | "lesson";

export type Learning = {
  id: string;
  agentKey: string;
  scope: LearningScope;
  clientId: string | null;
  model: string | null;
  verticalId: string | null;
  kind: LearningKind;
  condition: string | null;
  lesson: string;
  confidence: number;
  evidence: number;
  evidenceClients: string[];
  lastSeen: string;
};

/** The call a learning might apply to: whose work it is, what kind of business, and the task's own words */
export type CallContext = { clientId: string | null; model: string | null; also?: string | null; verticalId: string | null; task?: string | null };

/** A client's place, for deciding how far a lesson reaches */
export type ClientPlace = { clientId: string; model: string | null; also?: string | null; verticalId: string | null };

const SPECIFIC: Record<LearningScope, number> = { client: 4, vertical: 3, model: 2, everyone: 1 };
const ORDER: LearningScope[] = ["client", "vertical", "model", "everyone"];
/** Independent clients a lesson needs before it reaches past the one it came from */
export const WIDEN_AT = 3;
/** How many learnings one call reads at most */
export const TOP_K = 8;

/** Whether a learning is about this call at all */
export function applies(l: Learning, ctx: CallContext) {
  // A one-off exception is only ever true for the client it happened with
  if (l.kind === "exception") return Boolean(ctx.clientId) && l.clientId === ctx.clientId;
  if (l.scope === "client") return Boolean(ctx.clientId) && l.clientId === ctx.clientId;
  if (l.scope === "vertical") return Boolean(l.verticalId) && l.verticalId === ctx.verticalId;
  if (l.scope === "model") return Boolean(l.model) && (l.model === ctx.model || l.model === (ctx.also ?? null));
  return true;
}

const STOP = new Set(["the", "a", "an", "and", "or", "for", "of", "to", "in", "on", "with", "when", "only", "is", "are", "it", "this", "that", "their", "they", "be", "as", "at", "by", "if", "not", "from", "client", "clients"]);
export const words = (s: string | null | undefined) => new Set((s ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/** How well a learning's condition matches the task: words it shares (capped), or a small doubt when it shares none */
export function conditionFit(condition: string | null, task: string | null | undefined) {
  if (!condition?.trim() || !task?.trim()) return 0;
  const c = words(condition);
  if (!c.size) return 0;
  const t = words(task);
  let hits = 0;
  for (const w of c) if (t.has(w)) hits++;
  return hits ? Math.min(3, hits) * 3 : -2;
}

/** One learning's weight for a call: the more specific, proven, sure, recent and on-topic, the higher */
export function score(l: Learning, ctx: CallContext, now = Date.now()) {
  const days = Math.max(0, (now - Date.parse(l.lastSeen)) / 86_400_000);
  const recency = 5 * Math.max(0, 1 - days / 180);
  return SPECIFIC[l.scope] * 10 + Math.log2(Math.max(1, l.evidence) + 1) * 4 + Math.max(0, Math.min(1, l.confidence)) * 4 + recency + conditionFit(l.condition, ctx.task);
}

/** The few learnings a call reads: only those about it, best first, at most k */
export function rankLearnings(list: Learning[], ctx: CallContext, k = TOP_K, now = Date.now()) {
  return list
    .filter((l) => applies(l, ctx))
    .map((l) => ({ l, s: score(l, ctx, now) }))
    .sort((a, b) => b.s - a.s || b.l.evidence - a.l.evidence)
    .slice(0, k)
    .map((x) => x.l);
}

/**
 * How far a lesson reaches, from the clients that independently back it: a one-off exception, or anything with fewer
 * than three clients behind it, stays with its client. With three or more it reaches the narrowest group they all share
 * (their sub-vertical, then their business model), never past the scope the classifier proposed, and "everyone" only
 * when proposed and nothing narrower covers them.
 */
export function widenScope(evidence: ClientPlace[], proposed: LearningScope, kind: LearningKind): { scope: LearningScope; model: string | null; verticalId: string | null } {
  const stay = { scope: "client" as const, model: null, verticalId: null };
  const clients = [...new Map(evidence.map((e) => [e.clientId, e])).values()];
  if (kind === "exception" || clients.length < WIDEN_AT || proposed === "client") return stay;
  const allowed = (s: LearningScope) => ORDER.indexOf(s) <= ORDER.indexOf(proposed);
  const v = clients[0].verticalId;
  if (v && clients.every((c) => c.verticalId === v) && allowed("vertical")) return { scope: "vertical", model: null, verticalId: v };
  const models = clients.map((c) => new Set([c.model, c.also ?? null].filter((x): x is string => Boolean(x))));
  const shared = [...models[0]].find((m) => models.every((s) => s.has(m)));
  if (shared && allowed("model")) return { scope: "model", model: shared, verticalId: null };
  if (proposed === "everyone") return { scope: "everyone", model: null, verticalId: null };
  return stay;
}

/** The label a scope reads as, for the prompt and Settings */
export function scopeLabel(l: Pick<Learning, "scope" | "kind">) {
  if (l.kind === "exception") return "this client, one-off";
  return l.scope === "client" ? "this client" : l.scope === "vertical" ? "their sub-vertical" : l.scope === "model" ? "their kind of business" : "every client";
}

/**
 * Two learnings that contradict: the one that's newer, has more evidence and holds under a narrower condition wins.
 * When they pull different ways (newer but less proven, say), nobody wins and an exec decides.
 */
export function pickWinner(a: Learning, b: Learning): "a" | "b" | null {
  const narrower = (x: Learning) => (x.condition?.trim() ? 1 : 0) + (x.kind === "exception" ? 1 : 0);
  const ahead = (x: Learning, y: Learning) => [Date.parse(x.lastSeen) > Date.parse(y.lastSeen), x.evidence > y.evidence, narrower(x) > narrower(y)].filter(Boolean).length;
  const forA = ahead(a, b);
  const forB = ahead(b, a);
  // A clear winner: ahead on something and behind on nothing
  if (forA > 0 && forB === 0) return "a";
  if (forB > 0 && forA === 0) return "b";
  return null;
}
