import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio signs every webhook it sends us; the phone callbacks (src/app/api/phone/[step]/route.ts) answer only signed ones.

/**
 * X-Twilio-Signature: base64 HMAC-SHA1, keyed with the auth token, of the full URL Twilio called followed by every
 * POST parameter's name and value in name order. https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function validTwilioSignature(authToken: string | undefined, signature: string | null, url: string, params: Record<string, string>): boolean {
  if (!authToken || !signature) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

