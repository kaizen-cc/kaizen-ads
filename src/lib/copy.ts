// Kaizen's copy standard: every angle gets 5 ads, 3 short-form and 2 long-form, each with a headline, link
// description and an official Meta CTA button. The limits are hard limits; copy review can't approve past them.

export const CTA_BUTTONS = [
  "Learn More",
  "Shop Now",
  "Book Now",
  "Sign Up",
  "Get Quote",
  "Get Offer",
  "Apply Now",
  "Contact Us",
  "Order Now",
  "Buy Now",
  "Subscribe",
  "Download",
  "Send Message",
  "Call Now",
  "Get Directions",
  "See Menu",
] as const;

export type Ad = {
  kind: "short" | "long";
  formula: string;
  angle: string;
  primaryText: string;
  headline: string;
  linkDescription: string;
  cta: string;
};

export const LIMITS = {
  visible: 125, // characters shown before "See more"
  shortMax: 300, // short-form primary text, hard cap
  longMinWords: 300,
  longMaxWords: 800,
  headline: 40,
  linkDescription: 30,
} as const;

export const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export type Meter = { label: string; value: number; max: number; min?: number; unit: "chars" | "words"; tone: "ok" | "warn" | "bad" };

/** The counters copy review sees on one ad, with a tone: ok, warn (allowed but worth a look) or bad (blocks approval). */
export function meters(ad: Ad): { primary: Meter; hook: Meter; headline: Meter; description: Meter } {
  const len = ad.primaryText.length;
  const firstLine = ad.primaryText.split("\n")[0] ?? "";
  const primary: Meter =
    ad.kind === "short"
      ? { label: "Primary text", value: len, max: LIMITS.shortMax, unit: "chars", tone: len > LIMITS.shortMax ? "bad" : len > LIMITS.visible ? "warn" : len === 0 ? "bad" : "ok" }
      : (() => {
          const w = words(ad.primaryText);
          return { label: "Primary text", value: w, min: LIMITS.longMinWords, max: LIMITS.longMaxWords, unit: "words", tone: w < LIMITS.longMinWords || w > LIMITS.longMaxWords ? "bad" : "ok" };
        })();
  // The hook must land before "See more"
  const hookLen = Math.min(firstLine.length, len);
  const hook: Meter = { label: "Before “See more”", value: hookLen, max: LIMITS.visible, unit: "chars", tone: hookLen > LIMITS.visible ? "warn" : "ok" };
  const h = ad.headline.length;
  const d = ad.linkDescription.length;
  return {
    primary,
    hook,
    headline: { label: "Headline", value: h, max: LIMITS.headline, unit: "chars", tone: h === 0 || h > LIMITS.headline ? "bad" : h > 30 ? "warn" : "ok" },
    description: { label: "Link description", value: d, max: LIMITS.linkDescription, unit: "chars", tone: d > LIMITS.linkDescription ? "bad" : "ok" },
  };
}

/** What blocks approval, in plain words. Empty = ready. */
export function problems(ads: Ad[]): string[] {
  const out: string[] = [];
  if (ads.length !== 5) out.push(`The set needs 5 ads (3 short, 2 long); it has ${ads.length}.`);
  ads.forEach((ad, i) => {
    const m = meters(ad);
    const n = `Ad ${i + 1}`;
    if (m.primary.tone === "bad")
      out.push(
        ad.kind === "short"
          ? `${n}: primary text is ${m.primary.value} characters (max ${LIMITS.shortMax}).`
          : `${n}: long-form is ${m.primary.value} words (${LIMITS.longMinWords}-${LIMITS.longMaxWords}).`,
      );
    if (m.headline.tone === "bad") out.push(`${n}: headline is ${m.headline.value} characters (max ${LIMITS.headline}).`);
    if (m.description.tone === "bad") out.push(`${n}: link description is ${m.description.value} characters (max ${LIMITS.linkDescription}).`);
    if (!CTA_BUTTONS.includes(ad.cta as (typeof CTA_BUTTONS)[number])) out.push(`${n}: pick a Meta CTA button.`);
    if (/https?:\/\/|www\./i.test(ad.primaryText)) out.push(`${n}: no links in primary text.`);
  });
  return out;
}
