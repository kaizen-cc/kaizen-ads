// What makes a call, Slack message or email worth teaching the organic social agents (owner, Nov 19 2026): the social
// team is moving into Kaizen OS, so its agents learn from what clients and the team already said about each account.
// Pure (no database or AI), so the criteria are easy to test (tests/social-training.test.ts). The harvester
// (src/lib/social-training.ts) uses these to pick what the AI reads; the AI then distills the lessons.

export type SocialTopic = "calendar" | "pillars" | "reels_stories" | "engagement" | "community" | "boosting" | "platforms" | "post_feedback";

/** Each criterion and the words that mark it. A message has to touch the social work itself, not just say "post". */
export const SOCIAL_CRITERIA: readonly { topic: SocialTopic; label: string; re: RegExp }[] = [
  { topic: "calendar", label: "Posting calendar", re: /\b(content calendar|posting (calendar|schedule|plan|cadence|frequency)|social calendar|posts? (a|per) (week|month)|schedul(e|ed|ing) (the )?posts?|post(ing)? (days|times)|monthly calendar|calendar (approval|review))\b/i },
  { topic: "pillars", label: "Content pillars and themes", re: /\b(content pillars?|pillars?|content (themes?|mix|buckets?|strategy|plan)|themes? for (the )?(month|posts?)|ugc|user[- ]generated|behind the scenes|bts|testimonial posts?|educational posts?)\b/i },
  { topic: "reels_stories", label: "Reels, stories and formats", re: /\b(reels?|ig stor(y|ies)|instagram stor(y|ies)|stor(y|ies) (posts?|highlights?)|highlights?|carousels?|static (posts?|graphics?)|tiktoks?|short[- ]form video|trending audio|trends?)\b/i },
  { topic: "engagement", label: "Engagement and growth", re: /\b(engagement( rate)?|followers?|follower growth|reach|impressions|saves|shares|likes|comments? on (the )?posts?|organic (reach|growth|performance)|insights|analytics)\b/i },
  { topic: "community", label: "Community management", re: /\b(community manag(e|ement|er)|respond(ing)? to (comments|dms|messages|reviews)|dms?|direct messages?|reply to comments|comment replies|inbox|reviews? (on|from) (google|facebook|yelp)|negative comments?)\b/i },
  { topic: "boosting", label: "Boosting posts", re: /\b(boost(ed|ing|s)?( (a |the |this |that )?posts?)?|promote(d)? (a |the )?posts?|paid promotions?|post boost)\b/i },
  { topic: "platforms", label: "Platform-specific asks", re: /\b(instagram|facebook (page|posts?)|tiktok|linkedin|google (business|my business)|gmb|pinterest|threads|youtube shorts|bio link|link in bio|handle|hashtags?|tag (us|them|the)|collab(oration)? posts?)\b/i },
  { topic: "post_feedback", label: "Client feedback on posts", re: /\b((love|like|hate|dislike)d? (the|this|that|these) (posts?|reels?|stor(y|ies)|graphics?|captions?|carousels?)|caption|captions|(change|edit|fix|revise|update) (the |this |that )?(post|caption|graphic|reel)|(approve|approved|approval) (the |of the )?(posts?|calendar|content)|don'?t post|stop posting|please post|can (you|we) post|repost)\b/i },
];

/** Words that say it's organic social work at all (one of these, or two criteria, is needed) */
const STRONG = /\b(organic social|social media|social team|social posts?|content calendar|instagram|reels?|ig stor(y|ies)|community management|boost(ed|ing)? (a |the |this )?post)\b/i;

/** Automated mail and notifications: never a lesson */
const AUTOMATED = /\b(no-?reply|noreply|notifications?@|do-?not-?reply|mailer-daemon|facebookmail|business-updates|newsletter|digest|receipt|invoice|unsubscribe)\b/i;

export type SocialItem = { source: string; title: string | null; body: string | null; author: string | null };

/** The criteria a message touches */
export function socialTopics(text: string): SocialTopic[] {
  return SOCIAL_CRITERIA.filter((c) => c.re.test(text)).map((c) => c.topic);
}

/**
 * Whether a message is worth the AI's read for the social agents: not automated, and either plainly about organic social
 * (a strong word) with one criterion, or touching two criteria. Calls need the same (most calls are about ads).
 */
export function isSocialCandidate(item: SocialItem): { ok: boolean; topics: SocialTopic[] } {
  const text = `${item.title ?? ""}\n${item.body ?? ""}`;
  if (item.source === "gmail" && (AUTOMATED.test(item.author ?? "") || AUTOMATED.test(item.title ?? ""))) return { ok: false, topics: [] };
  if (text.trim().length < 40) return { ok: false, topics: [] };
  const topics = socialTopics(text);
  const strong = STRONG.test(text);
  return { ok: (strong && topics.length >= 1) || topics.length >= 2, topics };
}

/**
 * The part of a long text the AI reads: the passages around the social words (a call's transcript is mostly other
 * things), up to `max` characters, in order.
 */
export function socialExcerpt(text: string, max = 1800): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const hits: [number, number][] = [];
  const all = new RegExp([STRONG, ...SOCIAL_CRITERIA.map((c) => c.re)].map((r) => r.source).join("|"), "gi");
  for (const m of t.matchAll(all)) {
    const a = Math.max(0, (m.index ?? 0) - 220);
    const b = Math.min(t.length, (m.index ?? 0) + 320);
    const last = hits.at(-1);
    if (last && a <= last[1]) last[1] = b;
    else hits.push([a, b]);
  }
  if (!hits.length) return t.slice(0, max);
  let out = "";
  for (const [a, b] of hits) {
    const piece = `${a > 0 ? "… " : ""}${t.slice(a, b)}`;
    if (out.length + piece.length > max) {
      out += piece.slice(0, Math.max(0, max - out.length));
      break;
    }
    out += piece;
  }
  return out;
}

export type HarvestLesson = { topic: SocialTopic; kind: "prefer" | "avoid" | "note"; text: string; when: string };

/** The AI's lessons, made safe: known topics and kinds, trimmed, no empties, no duplicates, at most `max` */
export function cleanLessons(xs: unknown, max = 8): HarvestLesson[] {
  const topics = new Set(SOCIAL_CRITERIA.map((c) => c.topic));
  const seen = new Set<string>();
  const out: HarvestLesson[] = [];
  for (const x of Array.isArray(xs) ? xs : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (text.length < 12) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const topic = topics.has(o.topic as SocialTopic) ? (o.topic as SocialTopic) : "post_feedback";
    const kind = o.kind === "prefer" || o.kind === "avoid" ? o.kind : "note";
    out.push({ topic, kind, text, when: String(o.when ?? "").replace(/\s+/g, " ").trim().slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

export const topicLabel = (t: SocialTopic) => SOCIAL_CRITERIA.find((c) => c.topic === t)?.label ?? t;
