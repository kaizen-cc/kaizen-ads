import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// The plain parts of Business Manager tokens, kept apart from the database and Meta so they can be tested:
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

export const NO_KEY = "Add TOKEN_ENCRYPTION_KEY in Vercel first: without it a Business Manager's token can't be stored safely.";

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

/** A Business Manager's token reaching an ad account (from meta_business_token_accounts). */
export type TokenReach = { tokenId: string; account: string; canManage: boolean };

export type BmStatus = "not_connected" | "active" | "invalid" | "revoked";

/** A Business Manager as routing sees it: usable when it isn't Kaizen's, is active and has a token. */
export type BmState = { id: string; isDefault: boolean; status: BmStatus; hasToken: boolean };

export type RouteCtx = {
  /** Ad account (bare) → the Business Manager its client picked (null: Kaizen's). Only accounts a client owns. */
  owners: Map<string, string | null>;
  bms: Map<string, BmState>;
  reach: TokenReach[];
};

/**
 * Which Business Manager's token a call to this ad account uses. tokenId null: Kaizen's own. owned: a client owns the
 * account (its KPI targets or Details ID), so its choice of Business Manager decides; an account no client owns uses
 * Kaizen's (and a read Kaizen can't see may still be tried with the other tokens). A Business Manager that isn't
 * connected or stopped working falls back to Kaizen's. A write goes through the chosen token unless what it reaches
 * says it can only view the account; an account its last check didn't list is left for Meta to decide.
 */
export function routeToken(account: string | null | undefined, write: boolean, ctx: RouteCtx): { tokenId: string | null; owned: boolean } {
  const id = bareAccount(account);
  if (!id) return { tokenId: null, owned: false };
  if (!ctx.owners.has(id)) return { tokenId: null, owned: false };
  const sel = ctx.owners.get(id) ?? null;
  const bm = sel ? ctx.bms.get(sel) : null;
  if (!bm || bm.isDefault || bm.status !== "active" || !bm.hasToken) return { tokenId: null, owned: true };
  if (write) {
    const known = ctx.reach.find((r) => r.tokenId === bm.id && bareAccount(r.account) === id);
    if (known && !known.canManage) return { tokenId: null, owned: true };
  }
  return { tokenId: bm.id, owned: true };
}

/**
 * Ad account → its client's Business Manager. One account on two clients: a chosen (non-default) Business Manager
 * wins over Kaizen's, so an account isn't pulled back to Kaizen by a stale duplicate.
 */
export function ownersFrom(rows: { account: string | null | undefined; bm: string | null | undefined }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    const id = bareAccount(r.account);
    if (!id) continue;
    if (!out.has(id) || (!out.get(id) && r.bm)) out.set(id, r.bm ?? null);
  }
  return out;
}

/** What Team & setup says about one of the client's accounts and the chosen Business Manager's token. */
export function reachLine(account: string, bm: { name: string; isDefault: boolean; status: BmStatus; checked: boolean }, reach: { canManage: boolean } | null): { ok: boolean; text: string } {
  const act = `act_${bareAccount(account)}`;
  if (bm.isDefault) return { ok: true, text: "Through Kaizen's system user" };
  if (bm.status !== "active") return { ok: false, text: `${bm.name} isn't connected, so Kaizen's own token is used` };
  if (reach) return reach.canManage ? { ok: true, text: `Reached via ${bm.name} · can change` } : { ok: false, text: `Reached via ${bm.name} · view only: give the system user Manage campaigns on ${act} in ${bm.name}'s Business Manager` };
  if (!bm.checked) return { ok: true, text: `Via ${bm.name} · not checked yet` };
  return { ok: false, text: `${bm.name}'s token can't see ${act}: assign it to the system user in ${bm.name}'s Business Manager` };
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
      reason: `This token was made for another app${d.application ? ` ("${d.application}")` : ""}, not Kaizen's. In that Business Manager, generate the system user's token with Kaizen's app selected.`,
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
