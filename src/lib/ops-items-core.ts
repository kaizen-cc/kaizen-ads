// Pure rules for items the OS makes from operations signals (Nov 27 2026): hours over allotment from Kaizen Track,
// and ad-platform support emails that need a reply. Tested in tests/ops-items.test.ts.

/** One item at ~80%, one at 100% and over (updated as it climbs) */
export const allotmentBucket = (level: number): "80" | "100" => (level >= 100 ? "100" : "80");

export function allotmentTitle(o: { client: string; team: string; level: number; month: string }): string {
  const name = new Date(`${o.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return o.level >= 100 ? `${o.client}: ${o.team} hours past ${o.level}% of ${name}'s allotment: decide more hours or hold work` : `${o.client}: ${o.team} hours at ${o.level}% of ${name}'s allotment`;
}

/** Ad-platform support senders (Meta, Google Ads, TikTok) */
export const SUPPORT_SENDER = /@(support\.facebook\.com|fb\.com|facebookmail\.com|business\.facebook\.com|meta\.com)\b|ads-support@google\.com|noreply-ads-support@google\.com|@tiktok\.com\b/i;

/** A support email asking for something back (not a receipt, a survey or a newsletter) */
export function supportNeedsReply(subject: string, body: string): boolean {
  const t = `${subject}\n${body}`;
  if (/\b(survey|how did we do|rate your|newsletter|webinar|receipt|invoice|payment (received|confirmation))\b/i.test(t)) return false;
  return /\b(we need|need (more|additional) (information|details)|please (reply|respond|provide|send|share|confirm)|reply to this (email|message)|action (is )?required|respond within|awaiting your (reply|response)|requires your (attention|response))\b/i.test(t) && /\b(case|ticket|appeal|review|request)\b/i.test(t);
}

/** The case or ticket number in a support email, if it has one */
export const supportCase = (text: string): string | null => /\b(?:case|ticket)(?:\s*(?:#|no\.?|number|id))?[:\s]*([0-9]{6,20})\b/i.exec(text)?.[1] ?? null;
