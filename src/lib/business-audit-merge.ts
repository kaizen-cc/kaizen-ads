// Merging a business audit's moves into a sprint someone is already working: never reset it. Only moves that are new
// go on the list; ones it already has (open or done) are left out, and ones that pull against a move in progress are
// set aside for the owner to decide. The words decide the obvious cases; an AI pass only settles the ones in between.

export type ExistingMove = { id: string; title: string; status: "todo" | "doing" | "done" | "skipped" | string; why?: string | null };
export type CandidateMove = { index: number; title: string; why?: string | null };
export type MergeVerdict = { index: number; verdict: "new" | "duplicate" | "contradicts"; of?: string | null; note?: string | null };
export type MergePlan = {
  add: CandidateMove[];
  duplicates: { move: CandidateMove; of: ExistingMove }[];
  conflicts: { move: CandidateMove; of: ExistingMove; note: string }[];
};

const STOP = new Set(
  "a an the and or but to of in on for with by from at as is are be it its this that these those our their your we i you they them into onto over under than then so up out off new more less per vs via all any each every just only also not no do does did make set get use run add".split(" "),
);

/** The words that carry the meaning: lowercased, no punctuation or filler, light stemming */
export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().replace(/[^a-z0-9%$ ]+/g, " ").split(/\s+/)) {
    if (!raw || STOP.has(raw) || raw.length < 2) continue;
    out.add(raw.replace(/(ing|ed|es|s)$/, "") || raw);
  }
  return out;
}

/** How alike two moves read, 0 to 1 (overlap of their meaningful words) */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** Clearly the same move, by its words */
export const SAME = 0.6;
/** Close enough that the AI should look */
export const CLOSE = 0.3;

/**
 * The first pass, from the words alone: duplicates are settled here; candidates that read close to an existing move
 * (or any candidate while a move is in progress, since a contradiction needn't share words) are left for the AI.
 */
export function firstPass(candidates: CandidateMove[], existing: ExistingMove[]) {
  const settled: MergeVerdict[] = [];
  const unsure: CandidateMove[] = [];
  const inProgress = existing.some((e) => e.status === "doing");
  // Two candidates that say the same thing: keep the first
  const seen: CandidateMove[] = [];
  for (const c of candidates) {
    const twin = seen.find((s) => similarity(s.title, c.title) >= SAME);
    if (twin) continue;
    seen.push(c);
    let best: { e: ExistingMove; s: number } | null = null;
    for (const e of existing) {
      const s = similarity(c.title, e.title);
      if (!best || s > best.s) best = { e, s };
    }
    if (best && best.s >= SAME) settled.push({ index: c.index, verdict: "duplicate", of: best.e.id });
    else if ((best && best.s >= CLOSE) || inProgress) unsure.push(c);
    else settled.push({ index: c.index, verdict: "new" });
  }
  return { settled, unsure, kept: seen };
}

/**
 * The final plan from every verdict (the first pass's and the AI's). A candidate with no verdict counts as new; a
 * verdict pointing at a move that doesn't exist counts as new too; a contradiction only holds against a move in
 * progress or still to do (a done move can't be contradicted, it's history), otherwise it's new.
 */
export function mergePlan(candidates: CandidateMove[], existing: ExistingMove[], verdicts: MergeVerdict[]): MergePlan {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byIndex = new Map(verdicts.map((v) => [v.index, v]));
  const plan: MergePlan = { add: [], duplicates: [], conflicts: [] };
  for (const c of candidates) {
    const v = byIndex.get(c.index);
    const of = v?.of ? byId.get(v.of) : undefined;
    if (v?.verdict === "duplicate" && of) plan.duplicates.push({ move: c, of });
    else if (v?.verdict === "contradicts" && of && (of.status === "doing" || of.status === "todo")) plan.conflicts.push({ move: c, of, note: v.note?.trim() || "It pulls against a move already in progress." });
    else plan.add.push(c);
  }
  return plan;
}
