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
