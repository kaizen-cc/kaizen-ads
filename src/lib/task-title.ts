/**
 * A task's title without its urgency tokens, and whether it's urgent. Asana task names often carry "URGENT:" (sometimes
 * two or three times, as people re-add it); shown once as a badge instead of repeated in the title.
 */
export function cleanTitle(name: string | null | undefined): { title: string; urgent: boolean } {
  const raw = String(name ?? "");
  const re = /^\s*(?:\[\s*urgent\s*\]|urgent\s*[:!-]+)\s*/i;
  let t = raw;
  let urgent = false;
  while (re.test(t)) {
    urgent = true;
    t = t.replace(re, "");
  }
  // "Crust Pizza Co. - [URGENT] BOGA Poster": an urgency tag inside the title too
  const inner = /\s*\[\s*urgent\s*\]\s*/gi;
  if (inner.test(t)) {
    urgent = true;
    t = t.replace(inner, " ").replace(/\s{2,}/g, " ");
  }
  return { title: t.trim() || raw.trim(), urgent };
}
