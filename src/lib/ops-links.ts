import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// One-click actions in emails (mark fixed, stop alerting, have Claude fix it). The link itself
// is the permission: signed, tied to one error and one action, and expiring after 14 days.
export type OpsAction = "resolve" | "mute" | "fix";
const SITE = "https://ads.kaizenmarketing.agency";
const DAYS = 14;

const key = () => {
  const k = process.env.OPS_LINK_SECRET || process.env.CRON_SECRET;
  if (!k) throw new Error("OPS_LINK_SECRET or CRON_SECRET must be set to sign email action links");
  return k;
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

export function opsLink(action: OpsAction, fingerprint: string): string {
  const payload = b64(JSON.stringify({ a: action, f: fingerprint, exp: Date.now() + DAYS * 86_400_000 }));
  return `${SITE}/api/ops-action?t=${payload}.${sign(payload)}`;
}

export function readOpsToken(token: string | null): { action: OpsAction; fingerprint: string } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { a: OpsAction; f: string; exp: number };
    if (!v.exp || v.exp < Date.now() || !["resolve", "mute", "fix"].includes(v.a) || !v.f) return null;
    return { action: v.a, fingerprint: v.f };
  } catch {
    return null;
  }
}

