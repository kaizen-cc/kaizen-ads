// Email providers in Kaizen Ads: Klaviyo, Brevo and Customer.io are three SOURCES feeding the same email tables, so the
// plain parts every source shares live here (no network, no database, tested alone): the provider names, the pasted key
// checks for the two newer ones, redaction, plain-word errors per provider and a client's state. Klaviyo keeps its own
// parsing in ../klaviyo/core; this only adds what the others need.

import { plainKlaviyoError, klaviyoClientState, KLAVIYO_BEHIND_MS, KLAVIYO_SCOPE_NAMES, type KlaviyoClientState, type KlaviyoPlainError } from "../klaviyo/core";

export const EMAIL_PROVIDERS = ["klaviyo", "brevo", "customerio"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const PROVIDER_NAME: Record<EmailProvider, string> = { klaviyo: "Klaviyo", brevo: "Brevo", customerio: "Customer.io" };
export const providerName = (p: EmailProvider | string | null | undefined): string => PROVIDER_NAME[(p ?? "klaviyo") as EmailProvider] ?? "Klaviyo";
export const isEmailProvider = (v: unknown): v is EmailProvider => typeof v === "string" && (EMAIL_PROVIDERS as readonly string[]).includes(v);

/** The connection table each provider keeps its sealed key in */
export const CONNECTION_TABLE: Record<EmailProvider, string> = { klaviyo: "klaviyo_connections", brevo: "brevo_connections", customerio: "customerio_connections" };

/** A provider with no read of revenue of its own says so on its connection (revenue_read false or null): see revenueMeasured */
export const revenueMeasured = (provider: EmailProvider, conn: { revenue_read?: boolean | null } | null | undefined): boolean => provider === "klaviyo" || conn?.revenue_read === true;

/** Whether the provider's API lists automations (flows): Brevo's public API v3 has no endpoint for its workflows */
export const providerHasFlows = (p: EmailProvider): boolean => p !== "brevo";

/** Whether the provider can show an email's HTML for the hover preview */
export const providerHasPreviews = (p: EmailProvider): boolean => p !== "customerio";

// ─── The keys ──────────────────────────────────────────────────────────────

/** What to paste and where to find it, per provider, for every connect field */
export const KEY_HELP: Record<EmailProvider, { placeholder: string; label: string; help: string }> = {
  klaviyo: { placeholder: "pk_…", label: "Klaviyo private API key", help: `A read-only private key with Read access to ${KLAVIYO_SCOPE_NAMES}.` },
  brevo: { placeholder: "xkeysib-…", label: "Brevo API key", help: "An API key from Brevo > SMTP & API > API keys (it starts with xkeysib-). Revenue is read from Brevo's ecommerce attribution when their store is connected to Brevo." },
  customerio: { placeholder: "App API key", label: "Customer.io App API key", help: "An App API key from Customer.io > Settings > Account settings > API credentials. Customer.io reports no revenue: name their purchase event to count its value." },
};

/** A pasted secret: trimmed, quotes and a "Bearer " or "api-key:" prefix taken off */
export function cleanSecret(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(Bearer|api-key:?)\s+/i, "")
    .trim();
}

/** Brevo: an API v3 key (xkeysib-...) from SMTP & API settings; the SMTP password (xsmtpsib-...) is a different thing */
export function brevoKeyProblem(raw: string): string | null {
  const k = cleanSecret(raw);
  if (!k) return "Paste the Brevo API key.";
  if (/^xsmtpsib-/i.test(k)) return "That's an SMTP key. Paste an API key: Brevo > SMTP & API > API keys, it starts with xkeysib-.";
  if (/\s/.test(k) || k.length < 24) return "That doesn't look like a whole Brevo API key. Copy it again from Brevo (it starts with xkeysib-).";
  if (!/^xkeysib-/i.test(k)) return "A Brevo API key starts with xkeysib-.";
  return null;
}

/** Customer.io: an App API key (a service account token or the older App API key), sent as a Bearer token */
export function customerioKeyProblem(raw: string): string | null {
  const k = cleanSecret(raw);
  if (!k) return "Paste the Customer.io App API key.";
  if (/\s/.test(k) || k.length < 16) return "That doesn't look like a whole Customer.io App API key. Copy it again from Customer.io (Settings > Account settings > API credentials > App API keys).";
  return null;
}

export const secretLast4 = (raw: string) => cleanSecret(raw).slice(-4);

/** Any key out of a text before it's saved, logged or shown: the exact key, and anything shaped like a Brevo one */
export function redactSecret(text: string, key?: string | null): string {
  let out = String(text ?? "");
  if (key && key.length >= 8) out = out.split(key).join("[redacted]");
  return out.replace(/\bx(?:key|smtp)sib-[A-Za-z0-9-]{8,}/g, "xkeysib-[redacted]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [redacted]");
}

export type CioRegion = "us" | "eu";
export const isCioRegion = (v: unknown): v is CioRegion => v === "us" || v === "eu";
/** The App API's host per region (https://docs.customer.io/integrations/api/app/ lists both servers) */
export const cioBase = (r: CioRegion) => (r === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io");

// ─── Plain errors ──────────────────────────────────────────────────────────

/** What a Brevo or Customer.io failure means in plain words, with the fix; Klaviyo's keep their own wording */
export function plainEmailError(provider: EmailProvider, raw: string | null | undefined, status?: string | null): KlaviyoPlainError | null {
  if (provider === "klaviyo") return plainKlaviyoError(raw, status);
  const name = PROVIDER_NAME[provider];
  const text = String(raw ?? "").trim();
  const keyWhere = provider === "brevo" ? "Brevo > SMTP & API > API keys" : "Customer.io > Settings > Account settings > API credentials";
  if (status === "invalid" || new RegExp(`${name.replace(".", "\\.")} refused`, "i").test(text)) return { message: `${name} refused the key: it was revoked or deleted`, fix: `Create a new key in their ${keyWhere} and paste it here.`, severity: "bad" };
  if (!text) return null;
  if (/key can't be read|can't be decrypted|TOKEN_ENCRYPTION_KEY/i.test(text)) return { message: "The saved key can't be unlocked", fix: "Paste the key again (the encryption key in Vercel changed since it was saved).", severity: "bad" };
  if (/no ecommerce|revenue.*(unavailable|not read)/i.test(text)) return { message: "Revenue can't be read for this account", fix: provider === "brevo" ? "Connect their store to Brevo (ecommerce attribution) to see revenue. Campaigns and lists still sync." : "Name the purchase event on the Customer.io card to count its value as revenue. Campaigns and automations still sync.", severity: "warn" };
  if (/rate limit|\b429\b/i.test(text)) return { message: `${name} is rate limiting this account`, fix: "Nothing to do: it tries again on the next run.", severity: "bad" };
  if (/didn't answer|fetch failed|timed? ?out|ECONNRESET|answered 5\d\d/i.test(text)) return { message: `${name} didn't answer`, fix: "Nothing to do: it tries again on the next run.", severity: "bad" };
  if (/^Saving klaviyo_/i.test(text)) return { message: "The numbers were read but couldn't be saved", fix: "It tries again on the next run. If it keeps failing, the email providers migration may be missing.", severity: "bad" };
  if (/can't read|\b403\b|permission/i.test(text)) return { message: "The key lacks access to something Kaizen reads", fix: `Create a new key with read access in their ${keyWhere} and paste it here.`, severity: "bad" };
  return { message: text.slice(0, 200), fix: "Sync it again; if it keeps failing, replace the key.", severity: "bad" };
}

/** Where one client's email provider stands, from its connection (null when there is none) */
export function emailClientState(provider: EmailProvider, conn: { status: string; lastSyncedAt: string | null; error: string | null } | null, now = Date.now()): { state: KlaviyoClientState; error: KlaviyoPlainError | null } {
  if (provider === "klaviyo") return klaviyoClientState(conn, now);
  if (!conn) return { state: "missing", error: null };
  const error = plainEmailError(provider, conn.error, conn.status);
  if (error?.severity === "bad") return { state: "failing", error };
  if (!conn.lastSyncedAt) return { state: "pending", error };
  return { state: now - Date.parse(conn.lastSyncedAt) > KLAVIYO_BEHIND_MS ? "behind" : "connected", error };
}

// ─── Reading the numbers ───────────────────────────────────────────────────

/** Prompt text that names Klaviyo, naming the client's provider instead */
export const forProvider = (text: string, name: string) => (name === "Klaviyo" ? text : text.split("Klaviyo").join(name));

/** A day's shift, YYYY-MM-DD */
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Chunks of a list, for providers that take a bounded list of ids per call */
export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** A ratio of two counts, or null when there is nothing to divide by */
export const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** An answer a provider's API refused or couldn't give (status null: no answer at all). The text never holds a key. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
  }
}
