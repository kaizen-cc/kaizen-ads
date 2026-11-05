import { createHmac, timingSafeEqual } from "node:crypto";

// Replies to notice emails come in through Resend Receiving: a webhook (signed the Svix way) with the email's
// metadata, the body fetched after. Pure helpers, so they're tested.

/**
 * Whether a webhook really came from Resend: HMAC-SHA256 of "id.timestamp.body" with the endpoint's secret
 * (whsec_<base64>), matching one of the v1 signatures in svix-signature, sent within five minutes.
 */
export function verifySvix(secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()) {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest("base64"));
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** What someone wrote in a reply, without the email it quotes or their signature */
export function replyText(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const two = `${l} ${lines[i + 1] ?? ""}`;
    // The quoted original starts here: "On … wrote:" (sometimes over two lines), Outlook's headers, "> " lines
    if (/^On .{4,200} wrote:\s*$/.test(l) || /^On .{4,200} wrote:\s*$/.test(two.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] ?? "") || /^_{10,}$/.test(l.trim())) break;
    if (/^>/.test(l)) continue;
    // A signature
    if (/^-- ?$/.test(l) || /^Sent from my /.test(l)) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
