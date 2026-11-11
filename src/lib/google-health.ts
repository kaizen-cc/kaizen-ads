// Google Ads sync health, the plain parts (no network, no database) so they can be tested: what a Google Ads failure
// means in plain words with the fix, and where each client that runs Google stands (synced, behind, failing, waiting for
// its first sync, or not connected because no customer ID is on file). Read by Settings › Sync health and the client's
// Team & setup.

export type PlainError = { message: string; fix: string };

/** A message as a sentence: one full stop at the end */
export const sentence = (s: string) => `${s.replace(/[.\s]+$/, "")}.`;

/** Google shows customer IDs as 123-456-7890 */
export const dashedId = (id: string) => id.replace(/\D/g, "").replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");

/** A pasted customer ID as Google writes it (123-456-7890), or why it can't be one */
export function parseCustomerId(raw: string): { ok: true; id: string } | { ok: false; error: string } {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return { ok: false, error: "Paste the Google Ads customer ID (top right in Google Ads)." };
  if (d.length !== 10) return { ok: false, error: "A Google Ads customer ID has 10 digits, like 123-456-7890." };
  return { ok: true, id: dashedId(d) };
}

/**
 * What a Google Ads sync failure means, in plain words, and what fixes it. Reads both Google's own codes and the
 * sentences the Google Ads client already wrote (explain() in context/google-ads), so old and new errors read alike.
 */
export function plainGoogleError(raw: string | null | undefined, account?: string | null): PlainError {
  const text = String(raw ?? "").trim();
  const id = account ? dashedId(account) : "this account";
  if (/can't see this account|USER_PERMISSION_DENIED|isn't linked|not linked/i.test(text))
    return { message: `Kaizen's manager account can't reach ${id}`, fix: "Link it in Google Ads: send a manager link request from Kaizen's MCC and have the client accept it, or check the ID is right." };
  if (/CUSTOMER_NOT_ENABLED|isn't enabled|cancelled or suspended|suspended|canceled/i.test(text))
    return { message: `${id} is cancelled or suspended in Google Ads`, fix: "Ask the client to reactivate it (usually billing), or replace the ID if they moved to a new account." };
  if (/INVALID_CUSTOMER_ID|CUSTOMER_NOT_FOUND|customer.{0,20}(not found|invalid|doesn't exist)/i.test(text))
    return { message: `${id} isn't a Google Ads account`, fix: "Check the 10-digit customer ID (top right in Google Ads) and correct it." };
  if (/isn't connected yet|missing GOOGLE_ADS|GOOGLE_ADS_LOGIN_CUSTOMER_ID/i.test(text))
    return { message: "Kaizen's Google Ads sign-in isn't set up", fix: `Add the missing settings in Vercel${/missing (.+)\)/.exec(text)?.[1] ? `: ${/missing (.+)\)/.exec(text)![1]}` : ""}.` };
  if (/invalid_grant|sign-in failed|expired or revoked|Token has been expired/i.test(text))
    return { message: "Kaizen's Google sign-in stopped working", fix: "Renew GOOGLE_ADS_REFRESH_TOKEN in Vercel, or check the service account's sign-in." };
  if (/Test access|DEVELOPER_TOKEN_NOT_APPROVED|Explorer access/i.test(text))
    return { message: "Kaizen's Google Ads API access is Test only", fix: "Apply for Explorer access on the Google Ads API Overview page in Google Cloud Console." };
  if (/Turn on the Google Ads API|SERVICE_DISABLED|has not been used|is disabled/i.test(text))
    return { message: "The Google Ads API is off in Kaizen's Cloud project", fix: "Turn it on in Google Cloud Console for the project the sign-in belongs to." };
  if (/domain-wide delegation|unauthorized_client/i.test(text))
    return { message: "Kaizen's service account can't sign in to Google Ads", fix: "Add the adwords scope to its domain-wide delegation in Google Admin." };
  if (/GOOGLE_ADS_API_VERSION|isn't available/i.test(text))
    return { message: "Google retired the API version Kaizen uses", fix: "Set GOOGLE_ADS_API_VERSION in Vercel to a current version." };
  if (/RESOURCE_EXHAUSTED|quota|rate limit|too many requests/i.test(text))
    return { message: "Google's daily API limit was reached", fix: "Nothing to do: it tries again on the next run." };
  if (/fetch failed|ETIMEDOUT|ECONNRESET|timed? ?out|didn't answer|UNAVAILABLE|INTERNAL|\b50\d\b/i.test(text))
    return { message: "Google Ads didn't answer", fix: "Nothing to do: it tries again on the next run." };
  const said = text.replace(/^Google Ads:\s*/i, "").slice(0, 200);
  return { message: said || "The last sync failed", fix: "Sync it again; if it keeps failing, open the account in Google Ads and check Kaizen's access." };
}

export type GoogleAccountState = "synced" | "behind" | "failing" | "pending";
export type GoogleClientState = GoogleAccountState | "missing";
export type GoogleAccountHealth = { id: string; state: GoogleAccountState; lastSync: string | null; error: PlainError | null; active: boolean };
export type GoogleClientHealth = { state: GoogleClientState; accounts: GoogleAccountHealth[]; lastSync: string | null; error: PlainError | null };

/** A day and a bit with no successful sync is behind (the same line Sync health uses everywhere) */
export const BEHIND_MS = 26 * 3_600_000;

const RANK: Record<GoogleClientState, number> = { failing: 0, missing: 1, behind: 2, pending: 3, synced: 4 };
export const googleStateRank = (s: GoogleClientState) => RANK[s];

/**
 * Where one client's Google Ads stands. `accounts` are its Google KPI targets (an empty or missing ID counts as not
 * there); `runs` is each account's last sync (sync_state "kpi:<digits>": when, and the error it recorded).
 * `setupError` is set when Kaizen's own Google Ads sign-in isn't configured: every account fails with it.
 */
export function googleClientHealth(input: {
  accounts: { id: string | null; active: boolean }[];
  runs: Map<string, { at: string | null; error: string | null }>;
  setupError?: string | null;
  now?: number;
}): GoogleClientHealth {
  const now = input.now ?? Date.now();
  const seen = new Set<string>();
  const accounts: GoogleAccountHealth[] = [];
  for (const a of input.accounts) {
    const digits = String(a.id ?? "").replace(/\D/g, "");
    if (digits.length !== 10 || seen.has(digits)) continue;
    seen.add(digits);
    const run = input.runs.get(digits) ?? null;
    const raw = input.setupError ?? run?.error ?? null;
    const state: GoogleAccountState = raw ? "failing" : !run?.at ? "pending" : now - Date.parse(run.at) > BEHIND_MS ? "behind" : "synced";
    accounts.push({ id: dashedId(digits), state, lastSync: run?.at ?? null, error: raw ? plainGoogleError(raw, digits) : null, active: a.active });
  }
  const live = accounts.filter((a) => a.active);
  if (!live.length) return { state: "missing", accounts, lastSync: null, error: null };
  const worst = live.reduce((w, a) => (RANK[a.state] < RANK[w.state] ? a : w), live[0]);
  const lastSync = live.map((a) => a.lastSync).filter(Boolean).sort().at(-1) ?? null;
  return { state: worst.state, accounts, lastSync, error: worst.error };
}
