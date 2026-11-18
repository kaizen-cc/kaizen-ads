// Which service line a Loom is about, and which agents learn from it. Plain functions with no database or AI in them,
// so the rules are easy to test. The intake (loom-intake.ts) asks the AI to sort each Loom, then uses these to settle
// the platform, pick the agents and decide whether what it files waits for approval.
//
// Lines: the ad platforms (meta, google, both) feed the buying agents as they always have. Email (Klaviyo and other
// email tools) feeds the email agents, and organic social feeds the social agent. What lands in an email or social
// agent's knowledge waits for the head of that line (or an exec) to approve it before the agent reads it.

export type LoomPlatform = "meta" | "google" | "both" | "none" | "email" | "social";
export type LoomKind = "method" | "client" | "both" | "other";

/** What an email Loom is about, so the right email agents get it */
export const EMAIL_TOPICS = ["audit", "calendar", "flow_build", "campaign_strategy", "deliverability", "design", "copy", "build", "other"] as const;
export type EmailTopic = (typeof EMAIL_TOPICS)[number];

export const MEDIA_BUYER = "role:media_buyer";
export const GOOGLE_AUDITOR = "google_auditor";
export const EMAIL_STRATEGIST = "role:email_strategist";
export const EMAIL_CREATIVE = "role:email_creative";
export const EMAIL_BUILDER = "role:email_builder";
export const SOCIAL_STRATEGIST = "role:social_strategist";

const EMAIL_WORDS =
  /\b(e-?mails?|klaviyo|brevo|sendinblue|customer\.?io|omnisend|mailchimp|newsletters?|deliverability|open rates?|click rates?|subject lines?|preview text|welcome (flow|series)|abandon(ed)? (cart|checkout)|post[- ]purchase flow|browse abandon|winback|win-back|sunset(ting)? (flow|policy)|segments?|sms|dmarc|dkim|spf|warm(ing)? up)\b/gi;
const STRONG_EMAIL = /\b(klaviyo|brevo|sendinblue|customer\.?io|omnisend|mailchimp|e-?mails?|newsletters?|deliverability)\b/i;
const SOCIAL_WORDS =
  /\b(organic social|social media|instagram|facebook (page|posts?)|reels?|carousel posts?|content calendar|posting (plan|schedule)|engagement rate|community management|tiktok (organic|content)|hashtags?|stories|followers?|follower growth)\b/gi;
const STRONG_SOCIAL = /\b(organic social|social media (plan|strategy|audit|calendar)|content calendar|posting (plan|schedule)|community management)\b/i;
const ADS_WORDS = /\b(ad account|ad sets?|adsets?|campaigns? budget|roas|cpa|cpm|advantage\+|meta ads|google ads|performance max|pmax|ad spend|lookalike|creative testing)\b/gi;

export type LineSignal = { email: number; social: number; ads: number; strongEmail: boolean; strongSocial: boolean };

/** How much a title (counted double) and the start of a transcript talk about email, organic social and paid ads */
export function lineSignal(title: string | null | undefined, text: string | null | undefined): LineSignal {
  const t = title ?? "";
  const body = (text ?? "").slice(0, 6000);
  const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;
  return {
    email: count(EMAIL_WORDS, t) * 2 + count(EMAIL_WORDS, body),
    social: count(SOCIAL_WORDS, t) * 2 + count(SOCIAL_WORDS, body),
    ads: count(ADS_WORDS, t) * 2 + count(ADS_WORDS, body),
    strongEmail: STRONG_EMAIL.test(t),
    strongSocial: STRONG_SOCIAL.test(t),
  };
}

/**
 * The AI's sort, checked against the words in the title and transcript. The AI decides; this only catches the clear
 * misses: an email audit sorted as "other" or as no platform, or a Klaviyo video filed under an ad platform. A video
 * the AI placed on email or social stays there.
 */
export function settleLine(c: { kind: LoomKind; platform: LoomPlatform }, s: LineSignal): { kind: LoomKind; platform: LoomPlatform } {
  if (c.platform === "email" || c.platform === "social") return c;
  const adsStrong = s.ads >= 6 && s.ads > s.email;
  if (!adsStrong && s.strongEmail && s.email >= 3 && s.email >= s.social) return { kind: c.kind === "other" ? "method" : c.kind, platform: "email" };
  if (!adsStrong && s.strongSocial && s.social >= 3 && s.social > s.email) return { kind: c.kind === "other" ? "method" : c.kind, platform: "social" };
  return c;
}

export const lineOfPlatform = (p: string | null | undefined): "email" | "social" | null => (p === "email" ? "email" : p === "social" ? "social" : null);

/**
 * The agents whose knowledge a method Loom is filed to. Ads: the Media Buyer (and the Google auditor for Google).
 * Email: always the Email Strategist; the Email Creative when it's about design or copy; the Email Builder when it's a
 * build walkthrough. Social: the Social Strategist.
 */
export function agentsFor(platform: LoomPlatform, topics: readonly string[] = []): string[] {
  if (platform === "email") {
    const keys = [EMAIL_STRATEGIST];
    if (topics.some((t) => t === "design" || t === "copy")) keys.push(EMAIL_CREATIVE);
    if (topics.some((t) => t === "build" || t === "flow_build")) keys.push(EMAIL_BUILDER);
    return keys;
  }
  if (platform === "social") return [SOCIAL_STRATEGIST];
  if (platform === "google") return [GOOGLE_AUDITOR];
  if (platform === "both") return [MEDIA_BUYER, GOOGLE_AUDITOR];
  return [MEDIA_BUYER];
}

/** Whether what's filed to this agent waits for approval first (email and social playbooks are checked before they're read) */
export const needsApproval = (agentKey: string): boolean => /^role:(email_|social_)/.test(agentKey);

/** The platform in words, for the sorting prompt and the panel */
export function platformWords(p: LoomPlatform): string {
  return p === "none" ? "no platform" : p === "both" ? "Meta and Google" : p === "google" ? "Google Ads" : p === "email" ? "email marketing (Klaviyo and other email tools)" : p === "social" ? "organic social media" : "Meta";
}

/** Only the topics we know, once each */
export const cleanTopics = (t: readonly string[] | null | undefined): EmailTopic[] => [...new Set((t ?? []).filter((x): x is EmailTopic => (EMAIL_TOPICS as readonly string[]).includes(x)))];

/** Titles that say a Loom is about email (used to find the ones to read again; the same words as the SQL in scripts/requeue-email-looms.sql) */
export const EMAIL_TITLE = /(e-?mail|klaviyo|brevo|sendinblue|customer\.?io|omnisend|mailchimp|newsletter)/i;
