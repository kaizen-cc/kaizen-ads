/**
 * A task's title without its urgency tokens, and whether it's urgent. Asana task names often carry "URGENT:" (sometimes
 * two or three times, as people re-add it, or "URGENT URGENT:"); shown once as a badge instead of repeated in the title.
 * A "HIGH PRIORITY:" prefix comes off the same way and marks it high.
 */
export function cleanTitle(name: string | null | undefined): { title: string; urgent: boolean; high: boolean } {
  const raw = String(name ?? "");
  const re = /^\s*(?:\[\s*urgent\s*\]|urgent(?:\s+urgent)*\s*[:!-]+|urgent\s+(?=urgent\b))\s*/i;
  const hi = /^\s*(?:\[\s*(?:high|hi)(?:\s+priority)?\s*\]|(?:high|hi)\s+priority\s*[:!-]+)\s*/i;
  let t = raw;
  let urgent = false;
  let high = false;
  for (let guard = 0; guard < 10; guard++) {
    if (re.test(t)) {
      urgent = true;
      t = t.replace(re, "");
    } else if (hi.test(t)) {
      high = true;
      t = t.replace(hi, "");
    } else break;
  }
  // "Crust Pizza Co. - [URGENT] BOGA Poster": an urgency tag inside the title too
  const inner = /\s*\[\s*urgent\s*\]\s*/gi;
  if (inner.test(t)) {
    urgent = true;
    t = t.replace(inner, " ").replace(/\s{2,}/g, " ");
  }
  return { title: t.trim() || raw.trim(), urgent, high: high && !urgent };
}

export type PriorityLevel = "normal" | "high" | "urgent";
export const PRIORITY_LABEL: Record<PriorityLevel, string> = { normal: "Normal", high: "High", urgent: "Urgent" };
const RANK: Record<PriorityLevel, number> = { normal: 0, high: 1, urgent: 2 };

/** The higher of two priorities */
export const maxPriority = (a: PriorityLevel, b: PriorityLevel): PriorityLevel => (RANK[a] >= RANK[b] ? a : b);

/**
 * One priority from whatever Asana (or a person) wrote: the Priority field ("Hi", "HIGH", "High!!", "P1", "URGENT",
 * "Critical", "Low", "Medium"...) and the title's "URGENT:" / "[URGENT]" / "HIGH PRIORITY:" tags. The higher of the two
 * wins, so a task marked High in the field but titled "URGENT: ..." is Urgent. Anything not clearly high or urgent is
 * Normal.
 */
export function normalizePriority(field: string | null | undefined, title?: string | null): PriorityLevel {
  const f = String(field ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim();
  let p: PriorityLevel = "normal";
  if (/\b(urgent|critical|asap|emergency|rush|p0|highest)\b/.test(f)) p = "urgent";
  else if (/\b(hi|high|higher|important|p1)\b/.test(f)) p = "high";
  if (title) {
    const c = cleanTitle(title);
    p = maxPriority(p, c.urgent ? "urgent" : c.high ? "high" : "normal");
  }
  return p;
}
