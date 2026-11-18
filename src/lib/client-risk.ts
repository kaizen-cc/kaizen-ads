// A client someone said is probably leaving ("they're probably gonna be canceling", "I think they're churning"): kept
// as a dated note in the client's memory (never archived: dated, so it reads as background later) and used as a
// retention-risk flag, so the Overview and the daily recap put that client's work first for a while. Pure: no keys.

/** Every risk note starts with this, so the flag is read back from the client's memory without a new column */
export const RISK_PREFIX = "At risk";

/** How long a risk note keeps the client at the top of the day (after that it's background in their memory) */
export const RISK_DAYS = 60;

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The note kept in the client's memory: "At risk (said Nov 18, 2026): probably canceling. <context>" */
export function riskNote(why: string, dayIso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dayIso) ? new Date(`${dayIso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : dayIso;
  const w = clip(why, 700).replace(/[.\s]+$/, "") || "may cancel";
  return `${RISK_PREFIX} (said ${d}): ${w}.`;
}

/** Whether a client memory note is a retention-risk flag */
export const isRiskNote = (body: string | null | undefined) => String(body ?? "").startsWith(`${RISK_PREFIX} (said`);

/** The clients flagged at risk lately, from their memory notes (only notes from the last RISK_DAYS count) */
export function atRiskClients(notes: readonly { client_id: string; body: string; created_at: string }[], now = Date.now()): Set<string> {
  const since = now - RISK_DAYS * 86_400_000;
  return new Set(notes.filter((n) => isRiskNote(n.body) && Date.parse(n.created_at) >= since).map((n) => n.client_id));
}

/** Words that say a client is probably leaving (for a hint to the assistant; the model decides) */
const CHURN = /\b(cancel(?:l?ing|l?ed|s)?|cancellation|churn(?:ing|ed)?|leav(?:e|ing) us|walk(?:ing)? away|pull(?:ing)? (?:out|the plug)|not (?:going to |gonna )?renew(?:ing)?|won'?t renew|end(?:ing)? (?:the|their) (?:contract|retainer)|terminat\w+|fire us|firing us|moving (?:to|on to) (?:another|a new) agency|done with us|last month with us)\b/i;

/** Whether what someone said sounds like a client may leave */
export const soundsLikeChurn = (text: string | null | undefined) => CHURN.test(String(text ?? ""));
