// Something marked done on a board: a check pops over its card for a moment, then the card leaves. The caller's own
// clean-up (taking it out of the list, refreshing) runs once it's gone.

const SHOW_MS = 1500;
const LEAVE_MS = 450;

export function completeCard(el: Element | null | undefined, then?: () => void) {
  const card = el as HTMLElement | null | undefined;
  if (!card) return then?.();
  card.setAttribute("data-completing", "1");
  setTimeout(() => card.setAttribute("data-completing", "leaving"), SHOW_MS);
  setTimeout(() => {
    card.style.display = "none";
    then?.();
  }, SHOW_MS + LEAVE_MS);
}

/**
 * Refresh the page without losing your place: if the page jumps while it re-renders (a list above got shorter, a
 * panel re-drew), it's put back where you were, unless you scrolled yourself in the meantime.
 */
export function refreshInPlace(router: { refresh: () => void }) {
  const y = window.scrollY;
  let moved = false;
  const mine = () => (moved = true);
  window.addEventListener("wheel", mine, { once: true, passive: true });
  window.addEventListener("touchmove", mine, { once: true, passive: true });
  window.addEventListener("keydown", mine, { once: true });
  window.addEventListener("pointerdown", mine, { once: true });
  router.refresh();
  const until = Date.now() + 2500;
  const hold = () => {
    if (moved || Date.now() > until) {
      window.removeEventListener("wheel", mine);
      window.removeEventListener("touchmove", mine);
      window.removeEventListener("keydown", mine);
      window.removeEventListener("pointerdown", mine);
      return;
    }
    if (Math.abs(window.scrollY - y) > 120) window.scrollTo({ top: y });
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
}
