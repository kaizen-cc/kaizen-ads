// Kaizen's copy standard: every angle gets 5 ads, 3 short-form and 2 long-form, each with a headline, link
// description and an official Meta CTA button. The limits are the standard to aim for, not a gate: copy a little over or
// under them can still be approved (copy review decides). What blocks approval is copy that's missing, or that goes
// against something the client told us (checked against client memory when it's approved).

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
      ? { label: "Primary text", value: len, max: LIMITS.shortMax, unit: "chars", tone: len === 0 ? "bad" : len > LIMITS.visible ? "warn" : "ok" }
      : (() => {
          const w = words(ad.primaryText);
          return { label: "Primary text", value: w, min: LIMITS.longMinWords, max: LIMITS.longMaxWords, unit: "words", tone: w === 0 ? "bad" : w < LIMITS.longMinWords || w > LIMITS.longMaxWords ? "warn" : "ok" };
        })();
  // The hook must land before "See more"
  const hookLen = Math.min(firstLine.length, len);
  const hook: Meter = { label: "Before “See more”", value: hookLen, max: LIMITS.visible, unit: "chars", tone: hookLen > LIMITS.visible ? "warn" : "ok" };
  const h = ad.headline.length;
  const d = ad.linkDescription.length;
  return {
    primary,
    hook,
    headline: { label: "Headline", value: h, max: LIMITS.headline, unit: "chars", tone: h === 0 ? "bad" : h > 30 ? "warn" : "ok" },
    description: { label: "Link description", value: d, max: LIMITS.linkDescription, unit: "chars", tone: d > LIMITS.linkDescription ? "warn" : "ok" },
  };
}

/** What blocks approval on its own: copy that's missing. Empty = nothing missing. */
export function blockers(ads: Ad[]): string[] {
  const out: string[] = [];
  if (!ads.length) out.push("There's no copy yet.");
  ads.forEach((ad, i) => {
    if (!ad.primaryText.trim()) out.push(`Ad ${i + 1}: the primary text is empty.`);
    if (!ad.headline.trim()) out.push(`Ad ${i + 1}: the headline is empty.`);
  });
  return out;
}

/** Where the set is off Kaizen's standard, in plain words. Worth a look; doesn't block approval. */
export function headsUp(ads: Ad[]): string[] {
  const out: string[] = [];
  if (ads.length && ads.length !== 5) out.push(`The standard set is 5 ads (3 short, 2 long); this has ${ads.length}.`);
  ads.forEach((ad, i) => {
    const n = `Ad ${i + 1}`;
    const len = ad.primaryText.length;
    const w = words(ad.primaryText);
    if (ad.kind === "short" && len > LIMITS.shortMax) out.push(`${n}: primary text is ${len} characters (aim for ${LIMITS.shortMax} or less).`);
    if (ad.kind === "long" && w > 0 && (w < LIMITS.longMinWords || w > LIMITS.longMaxWords)) out.push(`${n}: long-form is ${w} words (aim for ${LIMITS.longMinWords}-${LIMITS.longMaxWords}).`);
    if (ad.headline.length > LIMITS.headline) out.push(`${n}: headline is ${ad.headline.length} characters (aim for ${LIMITS.headline} or less; Meta may cut it).`);
    if (ad.linkDescription.length > LIMITS.linkDescription) out.push(`${n}: link description is ${ad.linkDescription.length} characters (aim for ${LIMITS.linkDescription} or less).`);
    if (!CTA_BUTTONS.includes(ad.cta as (typeof CTA_BUTTONS)[number])) out.push(`${n}: pick a Meta CTA button.`);
    if (/https?:\/\/|www\./i.test(ad.primaryText)) out.push(`${n}: there's a link in the primary text.`);
  });
  return out;
}
