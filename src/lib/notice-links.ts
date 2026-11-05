import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// "It's handled" and "Add context" in a promise or owed-reply email. The link is the permission: signed, tied to one
// item and the one person the email went to, and expiring after two weeks. Opening it only shows the page (mail
// scanners open links on their own); the person acts from there.

export type NoticeKind = "said" | "owed";
export type NoticeToken = { kind: NoticeKind; id: string; profileId: string };
const DAYS = 14;

const secret = () => {
  const k = process.env.NOTICE_LINK_SECRET || process.env.OPS_LINK_SECRET || process.env.CRON_SECRET;
  if (!k) throw new Error("NOTICE_LINK_SECRET (or OPS_LINK_SECRET or CRON_SECRET) must be set to sign notice links");
  return k;
};
const sign = (payload: string) => createHmac("sha256", secret()).update(`notice:${payload}`).digest("base64url");

/** A notification key ("said2:<id>", "owed-lead:<id>") as the item it's about; null for any other notice */
export function noticeItem(key: string | null | undefined): { kind: NoticeKind; id: string } | null {
  const m = /^(said|owed)(?:2|-lead)?:([0-9a-f-]{36})$/.exec(key ?? "");
  return m ? { kind: m[1] as NoticeKind, id: m[2] } : null;
}

export function noticeToken(t: NoticeToken, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ k: t.kind, i: t.id, p: t.profileId, exp: now + DAYS * 86_400_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readNoticeToken(token: string | null | undefined, now = Date.now()): NoticeToken | null {
  if (!token || token.split(".").length !== 2) return null;
  const [payload, sig] = token.split(".");
  try {
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { k: NoticeKind; i: string; p: string; exp: number };
    if (!v.exp || v.exp < now || !["said", "owed"].includes(v.k) || !v.i || !v.p) return null;
    return { kind: v.k, id: v.i, profileId: v.p };
  } catch {
    return null;
  }
}

// ─── Replying to the email ──────────────────────────────────────────────────
// A reply goes to reply+<code>@<inbound domain>. The code fits an address (64 characters at most before the @, and
// mail servers may lowercase it): the kind, the item's id as hex and a short signature, all lowercase. Who replied is
// read from the sender, who must be someone the notice went to.

const replySig = (kind: NoticeKind, hex: string) => createHmac("sha256", secret()).update(`reply:${kind}:${hex}`).digest("hex").slice(0, 16);

export function replyCode(kind: NoticeKind, id: string) {
  const hex = id.replace(/-/g, "").toLowerCase();
  return `${kind === "said" ? "s" : "o"}${hex}${replySig(kind, hex)}`;
}

/** The address a notice email's Reply-To points at; null when receiving isn't set up */
export function replyAddress(kind: NoticeKind, id: string) {
  const domain = process.env.RESEND_INBOUND_DOMAIN || "contact.kaizenmarketing.agency";
  if (!process.env.RESEND_WEBHOOK_SECRET) return null;
  return `reply+${replyCode(kind, id)}@${domain}`;
}

/** The item a reply was sent to, from any of the addresses it went to; null when none carries a valid code */
export function readReplyAddress(addresses: string[]): { kind: NoticeKind; id: string } | null {
  for (const a of addresses) {
    const m = /reply\+([so])([0-9a-f]{32})([0-9a-f]{16})@/i.exec(a);
    if (!m) continue;
    const kind: NoticeKind = m[1].toLowerCase() === "s" ? "said" : "owed";
    const hex = m[2].toLowerCase();
    const given = Buffer.from(m[3].toLowerCase());
    const expected = Buffer.from(replySig(kind, hex));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
    return { kind, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
  }
  return null;
}

/** The page's address for one email recipient: "done" opens on It's handled, "context" on Add context */
export function noticeLink(base: string, t: NoticeToken, mode: "done" | "context") {
  return `${base}/handled?t=${noticeToken(t)}&do=${mode}`;
}
