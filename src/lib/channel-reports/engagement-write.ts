// What the writer is told for the engagement email report (a client whose revenue can't be read: Brevo with no store
// connected, Customer.io with no revenue event, Klaviyo with no conversion metric), apart from the revenue report's rules
// (write.ts adds these when the report's template is "engagement"), and the schemas that carry each takeaway's "what
// we'll do next" line. Plain data, so the tests read it.

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const ENGAGEMENT_RULES = `This is the engagement report: this client's revenue and bookings can't be read from their email platform, so the report judges email the way the owner would without a sales number. Never write revenue, sales, orders, bookings, order rates or revenue targets as numbers, never estimate them, and never imply email made money it can't show. Build everything on: people reached, opens and people who clicked, clicks to their website and booking pages (email's traffic contribution), what people clicked (the links by destination in <numbers>, such as the guest list, events, socials, directions), the list (size, growth, unsubscribes), and each number against the period before AND against the account's usual (the trailing average in <numbers>: say "above your usual", "below your usual" or "in line with your usual" exactly as <numbers> gives it). That usual is the over or under performance signal: lead with it. Click to open (of the people who opened, the share who clicked) is how good an email itself was; call it that in plain words, never "CTOR". Never grade against an outside bar or benchmark and never use words like good, fair, poor, score or bar about the numbers.
In the message, the four What happened bullets are exactly the ones in <numbers>; Highlights cover the links people clicked most (by what they are, like "Get on the guest list"), the best and the lowest email by click to open, and the list. When it would help the client see results (and only then), one sentence may suggest connecting sales or booking tracking (for example Brevo's ecommerce connection, or tracking links with UTM tags in their website analytics), phrased for the client as an offer, never as a gap in our work.`;

export const ENGAGEMENT_TAKEAWAY_RULES = `takeaways: exactly three cards for the PDF, read from the numbers. Each: title (a bold claim of 3 to 7 words), text (one or two sentences with the real numbers and what they are compared to: the period before and the usual when <numbers> gives it) and next (one short sentence, at most 14 words, on what we'll do next because of it, in the client's words: taken from the work log, what was said or the Coming up items when they cover it, else a concrete step that follows from the numbers, like leading with the link that drew the most clicks; never a date or a campaign that isn't in the sources, never revenue). Cover clicks and reach against the usual first, then what people clicked, then the best email or the list. Plain and specific: no hype, no exclamation marks, no emojis, no grades. Percent changes to one decimal.`;

const SECTIONS = obj({
  headline: S,
  summary: S,
  did: LIST,
  doing: LIST,
  next: LIST,
  highlights: LIST,
  takeaways: { type: "array", items: obj({ title: S, text: S, next: S }) },
});
export const ENGAGEMENT_DRAFT_SCHEMA = obj({ message: S, sections: SECTIONS });
export const ENGAGEMENT_REVISE_SCHEMA = obj({
  reply: S,
  message: S,
  sections: SECTIONS,
  lesson: S,
});

/** Whether stored metrics are the engagement report's */
export const engagementTemplate = (m: unknown) =>
  (m as { template?: string } | null)?.template === "engagement";
