// What the writer is told for an organic social report's PDF cards, apart from email's (write.ts picks these for the
// social line): three or four insight cards, each with a "what we'll do next" line the PDF prints under it, and the
// schemas that let the model return that line. Plain data, so the tests read it.

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const SOCIAL_TAKEAWAY_RULES = `takeaways: three or four insight cards for the PDF (three unless a fourth says something genuinely different). Each: title (a bold claim of 3 to 7 words), text (one or two sentences with the real numbers and what they are compared to, engagement always against the target given in <numbers>, Kaizen's 5% when the client has none) and next (one short sentence, at most 14 words, on what we'll do next because of it, in the client's words: taken from the work log, what was said or the Coming up items when they cover it, else a concrete step that follows from the numbers, like leaning into the format that engaged best; never a date, a post or a campaign that isn't in the sources). Cover the account's direction first (followers and reach), then engagement against the target, then the best post and why it likely worked. Plain and specific: no hype, no exclamation marks, no emojis, no adjectives the numbers don't earn. Percent changes to one decimal.`;

const SOCIAL_SECTIONS = obj({ headline: S, summary: S, did: LIST, doing: LIST, next: LIST, highlights: LIST, takeaways: { type: "array", items: obj({ title: S, text: S, next: S }) } });
export const SOCIAL_DRAFT_SCHEMA = obj({ message: S, sections: SOCIAL_SECTIONS });
export const SOCIAL_REVISE_SCHEMA = obj({ reply: S, message: S, sections: SOCIAL_SECTIONS, lesson: S });
