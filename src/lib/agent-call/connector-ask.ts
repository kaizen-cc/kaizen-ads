// A connected service's action asked for on a call ("reply to Crust's email saying we're on it"): the plain part of how
// a spoken yes switches it on. The agent asks first (the ask is kept on the call); on the next turn, and only when what
// the person said is a clear yes, that one tool on that one service is switched on for that turn. Anything else drops
// the ask. Pure, so it's tested without the API.

export type ConnectorAsk = { id: string; key: string; name: string; tool: string; input: string; summary: string; at: string };

/** How long an ask waits for its yes */
export const ASK_TTL_MS = 10 * 60_000;

/**
 * The ask kept on the call, if it's still good: well formed, recent, on a service that's connected now, and made
 * before this turn started (`turnStart`), so a yes said in the same breath as the ask never counts for it.
 */
export function liveAsk(raw: unknown, readyKeys: readonly string[], now = Date.now(), turnStart = now): ConnectorAsk | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<ConnectorAsk>;
  if (typeof a.key !== "string" || typeof a.tool !== "string" || typeof a.summary !== "string" || typeof a.at !== "string") return null;
  const at = Date.parse(a.at);
  if (!Number.isFinite(at) || now - at > ASK_TTL_MS || at >= turnStart) return null;
  if (!readyKeys.includes(a.key)) return null;
  return { id: String(a.id ?? ""), key: a.key, name: String(a.name ?? a.key), tool: a.tool, input: String(a.input ?? "{}"), summary: a.summary, at: a.at };
}

/** What the agent is told about an ask waiting on this turn: run it (on a spoken yes) or let it go */
export function askLine(ask: ConnectorAsk, yes: boolean): string {
  return yes
    ? `They just said yes to: ${ask.summary} (${ask.name}, tool ${ask.tool}, input ${ask.input}). Run that tool now, once, with exactly that input, then say in a sentence what happened. Never run it twice.`
    : `You asked about: ${ask.summary} (${ask.name}). What they just said isn't a clear yes, so it hasn't run and it's dropped. If they still want it, ask again with confirm_connector_action.`;
}
