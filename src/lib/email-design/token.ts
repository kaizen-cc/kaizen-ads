import { createHmac, timingSafeEqual } from "node:crypto";

// The public preview link for one version of an email design (for Figma's html.to.design import, which fetches the
// page from outside the app): signed by the server, tied to that design and version, and expiring after a week.

export const PREVIEW_LINK_DAYS = 7;

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`email-design:${payload}`).digest("base64url");

export function previewToken(secret: string, t: { id: string; version: number }, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ i: t.id, v: t.version, exp: now + PREVIEW_LINK_DAYS * 86_400_000 })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function readPreviewToken(secret: string, token: string | null | undefined, now = Date.now()): { id: string; version: number } | null {
  if (!secret || !token || token.split(".").length !== 2) return null;
  const [payload, sig] = token.split(".");
  try {
    const a = Buffer.from(sign(secret, payload));
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { i?: string; v?: number; exp?: number };
    if (!v.i || !/^[0-9a-f-]{36}$/i.test(v.i) || !Number.isInteger(v.v) || !v.exp || v.exp < now) return null;
    return { id: v.i, version: v.v! };
  } catch {
    return null;
  }
}

/** The key the links are signed with (the app's other link secrets, in order) */
export const previewSecret = () => process.env.NOTICE_LINK_SECRET || process.env.OPS_LINK_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
