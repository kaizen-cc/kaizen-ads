import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// The plain parts of client Business Manager tokens, kept apart from the database and Meta so they can be tested:
// encryption at rest, redaction of tokens from any text, which token a Graph call to an ad account uses, and what a
// pasted token must be (Kaizen's app, the right permissions) before it's saved.

// ─── Encryption at rest (AES-256-GCM) ─────────────────────────────────────

export type Sealed = { iv: string; tag: string; ciphertext: string };

/**
 * The 32-byte key from TOKEN_ENCRYPTION_KEY: 64 hex characters or 32 bytes of base64 are used as they are; anything
 * else (a long passphrase) is hashed to 32 bytes. Null when it isn't set.
 */
export function encryptionKey(raw: string | undefined | null): Buffer | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  return createHash("sha256").update(v).digest();
}

export function seal(plain: string, key: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: data.toString("base64") };
}

/** Throws when the key is wrong or anything was changed (the auth tag doesn't match). */
export function unseal(s: Sealed, key: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.ciphertext, "base64")), d.final()]).toString("utf8");
}

export const NO_KEY = "Add TOKEN_ENCRYPTION_KEY in Vercel first: without it a client's token can't be stored safely.";

// ─── Redaction ─────────────────────────────────────────────────────────────

/**
 * Tokens out of any text before it's logged, saved or shown: access_token, input_token and appsecret_proof values in
 * URLs or bodies, and anything shaped like a Meta token (EAA…). Also any exact secrets passed in.
 */
export function redactTokens(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out
    .replace(/((?:access_token|input_token|appsecret_proof|client_secret)(?:=|%3D|"\s*:\s*"|:\s*))[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, "[redacted]");
}

export const last4 = (token: string) => token.trim().slice(-4);

// ─── Which token a call uses ───────────────────────────────────────────────

export const bareAccount = (a: string | null | undefined) => String(a ?? "").replace(/^act_/, "").replace(/\D/g, "");

/** The ad account a Graph path is aimed at, when the path names one (act_123, act_123/ads, …). */
export function accountFromPath(path: string): string | null {
  const m = /^\/?act_(\d+)(?:[/?]|$)/.exec(path);
  return m ? m[1] : null;
}

export type TokenReach = { tokenId: string; account: string; canManage: boolean; status: string; createdAt?: string | null };

/**
 * The client business token for this account, or null for Kaizen's own token. Only active tokens count. A read takes
 * any active token that reaches the account; a write takes only one that can manage it (a token that only reads the
 * account never writes to it). The newest token wins when two reach the same account.
 */
export function pickToken(account: string | null | undefined, reach: TokenReach[], write: boolean): string | null {
  const id = bareAccount(account);
  if (!id) return null;
  const hits = reach
    .filter((r) => r.status === "active" && bareAccount(r.account) === id && (!write || r.canManage))
    .sort((a, b) => Number(b.canManage) - Number(a.canManage) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return hits[0]?.tokenId ?? null;
}

/** A POST that changes something (an insights POST only starts a report, which reading covers). */
export const isWriteCall = (path: string, method: "GET" | "POST") => method === "POST" && !/(^|\/)insights$/.test(path.replace(/\?.*$/, ""));

// ─── What a pasted token must be ───────────────────────────────────────────

export const REQUIRED_SCOPES = ["ads_management", "ads_read", "business_management"] as const;
export const SUGGESTED_SCOPES = ["pages_read_engagement", "pages_show_list"] as const;

export type DebugToken = { app_id?: string; application?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[]; type?: string; user_id?: string; profile_id?: string; error?: { message?: string } };

export type TokenCheck = { ok: true; scopes: string[]; expiresAt: string | null; appId: string; missingSuggested: string[] } | { ok: false; reason: string };

/**
 * Is this token one Kaizen Ads can use? Valid, made by Kaizen's own app (the same app as the default token), and with
 * ads_management, ads_read and business_management. A plain reason when it isn't.
 */
export function checkDebugToken(d: DebugToken | null | undefined, kaizenAppId: string | null): TokenCheck {
  if (!d) return { ok: false, reason: "Meta didn't describe this token. Check it was copied in full." };
  if (d.is_valid === false) return { ok: false, reason: `Meta says this token isn't valid${d.error?.message ? `: ${d.error.message}` : ""}. Generate a new one for the system user.` };
  if (!d.app_id) return { ok: false, reason: "Meta didn't say which app this token belongs to." };
  if (kaizenAppId && String(d.app_id) !== String(kaizenAppId))
    return {
      ok: false,
      reason: `This token was made for another app${d.application ? ` ("${d.application}")` : ""}, not Kaizen's. In the client's Business Manager, generate the system user's token with Kaizen's app selected.`,
    };
  const scopes = [...new Set(d.scopes ?? [])].sort();
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) return { ok: false, reason: `This token is missing ${missing.join(", ")}. Generate it again with ${REQUIRED_SCOPES.join(", ")} ticked.` };
  const exp = Number(d.expires_at ?? 0);
  if (exp > 0 && exp * 1000 < Date.now()) return { ok: false, reason: "This token has already expired. Generate a new one (system user tokens can be set to never expire)." };
  return { ok: true, scopes, expiresAt: exp > 0 ? new Date(exp * 1000).toISOString() : null, appId: String(d.app_id), missingSuggested: SUGGESTED_SCOPES.filter((s) => !scopes.includes(s)) };
}

/** Meta's user_tasks on an ad account: Manage campaigns (ADVERTISE) or full control (MANAGE) can change it. */
export const tasksCanManage = (tasks: string[] | null | undefined) => (tasks ?? []).some((t) => t === "MANAGE" || t === "ADVERTISE");
