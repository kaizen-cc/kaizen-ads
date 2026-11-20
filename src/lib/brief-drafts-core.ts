// The brief drafts' pure rules (src/lib/brief-drafts.ts), tested in tests/brief-drafts.test.ts.

/** The biggest form kept whole */
export const MAX_DRAFT_BYTES = 450_000;

/**
 * The form as it's kept: whole when it fits; past the limit the AI's working notes (its suggestions, the review, a
 * split's queue) are dropped and the request itself is kept; null when even that is too big.
 */
export function fitPayload(payload: Record<string, unknown>, max = MAX_DRAFT_BYTES): Record<string, unknown> | null {
  if (JSON.stringify(payload).length <= max) return payload;
  const rest = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "ai" && k !== "review" && k !== "queue"));
  return JSON.stringify(rest).length <= max ? rest : null;
}
