import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// A brief talked through with the strategist isn't stored anywhere until it's sent, so the server signs the fingerprint
// of what the strategist wrote (src/lib/brief-fingerprint.ts) for this client. Sending it without the AI review is only
// accepted when the request as sent still has that fingerprint and the signature is the server's own.

const secret = () => process.env.BRIEF_SEAL_SECRET || process.env.NOTICE_LINK_SECRET || process.env.OPS_LINK_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sign = (key: string, clientId: string, fingerprint: string) => createHmac("sha256", key).update(`brief-seal:${clientId}:${fingerprint}`).digest("base64url");

/** The seal for a brief the strategist wrote for this client, or null when there's no secret to sign with (then it's reviewed) */
export function sealBrief(clientId: string, fingerprint: string): string | null {
  const key = secret();
  return key ? sign(key, clientId, fingerprint) : null;
}

/** Whether the seal is the server's own for this client and fingerprint */
export function checkSeal(clientId: string, fingerprint: string, seal: string | null | undefined): boolean {
  const key = secret();
  if (!key || !seal) return false;
  const a = Buffer.from(sign(key, clientId, fingerprint));
  const b = Buffer.from(seal);
  return a.length === b.length && timingSafeEqual(a, b);
}
