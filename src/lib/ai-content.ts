// Real people's faces and voices, and clients who don't want AI content (the owner's Nov 10 session with the lead
// video editor).
// * Altering or generating a real person's likeness or voice (an AI avatar of a customer, a cloned or pitch-shifted
//   voice, a face swap, a testimonial rebuilt with AI) needs the client's written consent and an on-screen disclaimer.
//   Every brief writer and creative AI reads LIKENESS_RULE; the brief lint warns (soft, with an AI fix) when a brief
//   uses it without a consent line.
// * Some clients reject AI content outright ("no AI generated video or AI narration voices, no AI slop"). The rule is
//   found in client memory, the Brand Bible's dos-and-don'ts log and call notes (aiContentRule); for those clients the
//   writers and Kaizen AI are told, the brief lint holds a brief that uses AI media (a hard conflict a lead can still
//   send anyway), and AI images, video and voiceovers aren't generated for them.
// Pure: tested in tests/ai-content.test.ts.

const AI = String.raw`(?:\bA\.?I\.?(?![a-z0-9])|\bartificial[- ]intelligence\b)`;
const NOUNS = String.raw`videos?|footage|clips?|b-?roll|voices?|voice-?overs?|vos?|narrations?|narrators?|avatars?|actors?|actresses?|presenters?|spokes(?:person|people|model)s?|influencers?|ugc|creators?|hosts?|characters?|people|persons?|humans?|faces?|models?|images?|imagery|visuals?|photos?|photography|pictures?|graphics|art|artwork|renders?|content|creatives?|ads?|slop|stuff|look|clones?|twins?|lip-?sync(?:ed|ing)?|testimonials?|generations?`;
/** Words for AI-made text, which isn't AI media: "AI-generated captions" is fine for anyone */
const TEXT_ONLY = String.raw`(?![\s-]+(?:captions?|subtitles?|transcripts?|copy|text|headlines?|scripts?|summar(?:y|ies)|notes|translations?|research|tools? for (?:copy|research)))`;

/** AI-made media: an AI avatar, AI voice, AI-generated footage or images, a voice clone, a face swap, the AI tools */
const AI_MEDIA = new RegExp(
  [
    String.raw`${AI}[\s-]+(?:generated|made|created|rendered|produced|narrated|voiced|looking|animated|edited)\b${TEXT_ONLY}`,
    String.raw`${AI}[\s-]+(?:${NOUNS})\b`,
    String.raw`\b(?:generated|made|created|rendered|produced)\s+(?:by|with|using|in|through)\s+${AI}`,
    String.raw`\blooks?\s+(?:like\s+)?${AI}`,
    String.raw`\b(?:anything|nothing|everything)\s+${AI}`,
    String.raw`${AI}[\s-]*free\b`,
    String.raw`\bsynthetic\s+(?:voices?|presenters?|avatars?|actors?|footage|media|people|faces?)\b`,
    String.raw`\bvoice[\s-]?clon(?:e|es|ed|ing)\b`,
    String.raw`\bclon(?:e|ed|ing)\s+(?:(?:the|their|his|her|a|an|our)\s+)?(?:[\w']+\s+)?voices?\b`,
    String.raw`\bdeep[\s-]?fakes?\b`,
    String.raw`\bface[\s-]?swap(?:s|ped|ping)?\b`,
    String.raw`\btext[\s-]to[\s-](?:speech|video)\b`,
    String.raw`\bdigital\s+(?:twins?|avatars?|doubles?)\b`,
    String.raw`\b(?:higgsfield|heygen|synthesia|elevenlabs|eleven labs|arcads|hedra|midjourney)\b`,
  ].join("|"),
  "gi",
);

/** Altering or generating a real person's face or voice */
const LIKENESS = new RegExp(
  [
    String.raw`\bvoice[\s-]?clon(?:e|es|ed|ing)\b`,
    String.raw`\bclon(?:e|ed|ing)\s+(?:(?:the|their|his|her|a|an|our)\s+)?(?:[\w']+\s+)?voices?\b`,
    String.raw`\bpitch[\s-]?shift(?:s|ed|ing)?\b`,
    String.raw`\bvoice[\s-]?(?:changer|changed|altered|modified|swap(?:ped)?)\b`,
    String.raw`\b(?:alter|altered|altering|change|changed|changing|modif(?:y|ied|ying)|disguis(?:e|ed|ing)|distort(?:ed|ing)?|re-?voic(?:e|ed|ing))\s+(?:(?:the|their|his|her|a|an|our|its)\s+)?(?:[\w']+\s+){0,2}?(?:voices?|faces?|likeness(?:es)?)\b`,
    String.raw`\bre-?voic(?:e|ed|ing)\b`,
    String.raw`\bdeep[\s-]?fakes?\b`,
    String.raw`\bface[\s-]?swap(?:s|ped|ping)?\b`,
    String.raw`\bdigital\s+(?:twins?|doubles?)\b`,
    String.raw`${AI}[\s-]+(?:generated\s+|made\s+)?(?:avatars?|twins?|clones?|doubles?|versions?|lip-?sync(?:ed|ing)?|testimonials?)\b`,
    String.raw`\b(?:altered|synthetic|fake|rebuilt|recreated)\s+testimonials?\b`,
    String.raw`\bavatars?\s+(?:of|from|based on|built from|made from|modell?ed on)\s+(?:(?:a|an|the|our|their|one of (?:the|their|our))\s+)?(?:real\s+)?(?:customers?|clients?|owners?|founders?|reviewers?|testimonials?|persons?|people|employees?|staff|team members?|patients?|guests?)\b`,
    String.raw`${AI}[\s-]+(?:b-?roll|footage|video|visuals?)\s+(?:of|from|based on|built from|made from)\s+(?:(?:a|an|the|our|their)\s+)?(?:real\s+)?(?:customers?|testimonials?|reviewers?|founders?|owners?)\b`,
  ].join("|"),
  "gi",
);

const NEGATION = /\b(?:no|not|never|don'?t|do not|doesn'?t|does not|didn'?t|did not|won'?t|will not|wouldn'?t|shouldn'?t|can'?t|cannot|avoid(?:s|ing)?|against|hates?|hated|dislikes?|disliked|rejects?|rejected|refuses?|refused|bans?|banned|without|zero|nothing|stop|minus|instead of|rather than|isn'?t|aren'?t|anti|nor|skip|ditch|drop)\b/i;
const AFTER_NEGATION = /^[^.;:!?\n]{0,30}?\b(?:is|are|=)?\s*(?:a\s+)?(?:no\b|not (?:allowed|ok|okay|wanted|welcome)|off[- ]limits|banned|forbidden|a hard no|a no-go|unacceptable|out\b)/i;
/** The client opened the door: these win over a negation in the same clause */
const OPENED = /\b(?:open to|fine with|ok(?:ay)? with|happy (?:with|to)|on board with|no (?:problem|issue)s? with|don'?t mind|doesn'?t mind|now (?:allowed|ok|okay|fine)|green[- ]?l(?:it|ight)|(?:is|are) (?:fine|ok|okay|allowed)\b)/i;

const SEPARATORS = [".", ";", "!", "?", "\n", ",", "(", ")"];
const lastSeparator = (s: string) => Math.max(...SEPARATORS.map((x) => s.lastIndexOf(x)), s.toLowerCase().lastIndexOf(" but "));

/** The clause around a match: from the last separator before it to the next after it */
function clauseAround(text: string, at: number, len: number) {
  const before = text.slice(0, at);
  const cut = lastSeparator(before);
  const head = before.slice(cut + 1);
  const tail = text.slice(at + len);
  const end = tail.search(/[.;!?\n,()]|\bbut\b/);
  return { head, tail: end >= 0 ? tail.slice(0, end) : tail, cut };
}

const mediaIn = (s: string) => new RegExp(AI_MEDIA.source, "i").test(s);

/** A match negated in its own clause ("no AI avatars", "AI voices are off-limits"), or in a list a negation opens ("no AI video, AI voices or avatars") */
function negated(text: string, at: number, len: number, window = 60) {
  const { head, tail, cut } = clauseAround(text, at, len);
  if (NEGATION.test(head.slice(-window)) || AFTER_NEGATION.test(tail) || /^[\s-]*free\b/i.test(tail) || /\bslop\b/i.test(text.slice(at, at + len))) return true;
  let end = cut;
  while (end > 0 && text[end] === ",") {
    const prev = text.slice(0, end);
    const c = lastSeparator(prev);
    const seg = prev.slice(c + 1);
    if (!mediaIn(seg)) return false;
    if (NEGATION.test(seg)) return true;
    end = c;
  }
  return false;
}

/** "AI" not followed by anything that makes it media ("no AI.", "real footage only, no AI") */
const BARE_NO_AI = new RegExp(String.raw`\b(?:no|zero|never|without|not)\s+(?:any\s+)?${AI}(?=\s*(?:[.,;:!)\n]|$|\s+(?:at all|ever|please|anything|whatsoever|in (?:the|their|our) (?:ads?|creative|content|videos?))))`, "i");

/** The sentence of a statement that says no to AI content, or null. "avoid" or "don't" items count when they name AI media at all. */
export function noAiRuleIn(text: string, negativeKind = false): string | null {
  const t = (text ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (BARE_NO_AI.test(t)) return t;
  for (const m of t.matchAll(AI_MEDIA)) {
    const at = m.index ?? 0;
    const { head, tail } = clauseAround(t, at, m[0].length);
    if (OPENED.test(`${head}${m[0]}${tail}`) && !/\bslop\b/i.test(m[0])) continue;
    if (negativeKind || negated(t, at, m[0].length) || /^[\s-]*free\b/i.test(t.slice(at + m[0].length)) || /\bfree\b/i.test(m[0])) return t;
  }
  return null;
}

export type AiRuleSources = {
  /** Client memory (active): "avoid" items count when they name AI media at all */
  memory?: { kind: string; body: string }[] | null;
  /** The Brand Bible's dos-and-don'ts log: a lifted rule about AI means the client opened the door */
  rules?: { rule: string; polarity: string; status: string }[] | null;
  /** What the client said on calls (and the briefing's "avoid" list) */
  notes?: string[] | null;
};
export type AiRule = { allowed: boolean; rule: string | null; source: "memory" | "bible" | "call" | null };

const ALLOWED: AiRule = { allowed: true, rule: null, source: null };
const short = (s: string) => (s.length > 220 ? `${s.slice(0, 217).trimEnd()}...` : s);

/** Whether a client takes AI content, and the statement that says they don't */
export function aiContentRule(s: AiRuleSources): AiRule {
  // A lifted rule about AI content: the client opened the door since
  if ((s.rules ?? []).some((r) => r.status === "lifted" && mediaIn(r.rule))) return ALLOWED;
  for (const r of s.rules ?? []) {
    if (r.status === "lifted") continue;
    const hit = noAiRuleIn(r.rule, r.polarity === "dont");
    if (hit) return { allowed: false, rule: short(hit), source: "bible" };
  }
  for (const m of s.memory ?? []) {
    const hit = noAiRuleIn(m.body, m.kind === "avoid");
    if (hit) return { allowed: false, rule: short(hit), source: "memory" };
  }
  for (const n of s.notes ?? []) {
    // Notes are long: read them sentence by sentence
    for (const sentence of (n ?? "").split(/(?<=[.!?])\s+|\n+/)) {
      const hit = noAiRuleIn(sentence);
      if (hit) return { allowed: false, rule: short(hit), source: "call" };
    }
  }
  return ALLOWED;
}

/** True unless the client said no to AI content */
export const aiContentAllowed = (s: AiRuleSources) => aiContentRule(s).allowed;

// ─── Reading a brief ────────────────────────────────────────────────────────

/** The brief's lines that ask for something: a Don't section (and "Don't:" lines) only says what not to do */
function askingLines(text: string) {
  const out: { line: string; offset: number }[] = [];
  let inDont = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const heading = /^\s*([A-Z][A-Za-z' ]{1,30}):/.exec(line);
    if (heading) inDont = /^(?:don'?t|donts|avoid|never)$/i.test(heading[1].trim());
    if (!inDont) out.push({ line, offset });
    offset += line.length + 1;
  }
  return out;
}

function firstAsked(text: string, re: RegExp) {
  for (const { line } of askingLines((text ?? "").replace(/[‘’]/g, "'"))) {
    for (const m of line.matchAll(new RegExp(re.source, "gi"))) {
      if (!negated(line, m.index ?? 0, m[0].length, 50)) return m[0].trim();
    }
  }
  return null;
}

/** The first AI media the brief asks for (an AI avatar, an AI voice, AI footage, a Higgsfield clip), or null */
export const aiMediaIn = (text: string) => firstAsked(text, AI_MEDIA);

/** The first place the brief alters or generates a real person's face or voice, or null */
export const likenessIn = (text: string) => firstAsked(text, LIKENESS);

/** A consent line: "Get the client's written consent for ...", a signed release */
export const hasConsentLine = (text: string) => /\bconsent\b|\b(?:signed|model|talent|likeness) release\b|\brelease form\b/i.test(text ?? "");

/** An on-screen disclaimer line */
export const hasDisclaimerLine = (text: string) => /\bdisclaimer\b|\bdisclos(?:e|ed|es|ure)\b/i.test(text ?? "");

// ─── For the prompts ────────────────────────────────────────────────────────

/** Every brief writer and creative AI reads this */
export const LIKENESS_RULE = `REAL PEOPLE'S FACES AND VOICES: altering or generating a real person's likeness or voice (an AI avatar of a customer, the owner or staff, a cloned or pitch-shifted voice, a face swap, a testimonial re-voiced or rebuilt with AI) needs the client's written consent and an on-screen disclaimer. Never suggest it without saying so. When a brief includes it, add "Get the client's written consent for <who>'s likeness/voice" under Confirm with client (who the person is, e.g. "the customer in the March testimonial"), and a Constraints line "Disclaimer: <the on-screen line, e.g. AI-generated likeness, used with permission; or Voice altered>". A stock AI presenter who isn't a real person needs neither: say it's a stock avatar.`;

/** What the writers read for a client who said no to AI content */
export function noAiContentRule(rule: string) {
  return `NO AI CONTENT FOR THIS CLIENT. They told us: "${rule}". Never suggest or write an AI avatar, an AI, cloned or synthetic voice, AI narration, AI-generated video, footage, B-roll or images, or a Higgsfield or ElevenLabs generation for them. Use real footage, real photos, real people (with consent) and a real voiceover. When it matters to the brief, put "No AI-generated video, images or voices (client rule)" under Don't.`;
}

/** The note on the AI media panels for that client */
export const NO_AI_MEDIA_NOTE = "This client doesn't want AI-generated video, images or voices, so AI media isn't made for them. Use real footage, photos and a real voiceover.";
