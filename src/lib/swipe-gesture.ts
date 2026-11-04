// Swipe to approve (right) or ask for changes (left) in the client's portal, without fighting the ad inside it: a drag
// that starts inside a carousel swipes the carousel's cards, one that starts on a button, link, field or video is
// theirs, and a press that hasn't moved yet stays a tap (so tapping the creative still pins a comment). Only a clearly
// sideways drag that started on the card itself moves the card. Pure, so it's tested on its own.

/** Where a press started */
export type PressStart = "card" | "carousel" | "control";
/** What a press is so far: undecided, the card's swipe, or someone else's (a scroll, the carousel, a control) */
export type Gesture = "pending" | "swipe" | "none";

/** How far a press moves before it's a drag rather than a tap */
export const SLOP = 8;
/** How far the card goes before letting go decides */
export const DECIDE = 110;

export function gestureOf(start: PressStart, dx: number, dy: number): Gesture {
  if (start !== "card") return "none";
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SLOP && ay < SLOP) return "pending";
  // Mostly up or down: the page scrolling, not a swipe
  return ax > ay ? "swipe" : "none";
}

/** Letting go of a swiped card */
export function verdictOf(dx: number): "approve" | "changes" | "cancel" {
  if (dx > DECIDE) return "approve";
  if (dx < -DECIDE) return "changes";
  return "cancel";
}

/** Where a press started, from the element under it (anything marked data-carousel, or a control) */
export function pressStart(target: { closest: (selector: string) => unknown } | null): PressStart {
  if (!target) return "card";
  if (target.closest("[data-carousel]")) return "carousel";
  if (target.closest("button, a, textarea, input, select, video, [data-no-swipe]")) return "control";
  return "card";
}
