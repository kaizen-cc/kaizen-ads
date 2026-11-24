// Prospect searches as background jobs: the plain parts (no server imports), shared by the runner, the screens and the
// tests. Stages, how far along a search is, and how its notice and Overview item read.

export type SearchStage = "searching" | "checking" | "scoring" | "saving";
export type SearchStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export const STAGE_LABEL: Record<SearchStage, string> = {
  searching: "Searching sources",
  checking: "Checking sites",
  scoring: "Scoring fit",
  saving: "Saving",
};
export const STAGES: readonly SearchStage[] = ["searching", "checking", "scoring", "saving"];

/** Each stage's share of the bar: [start, end] in percent */
export const STAGE_SPAN: Record<SearchStage, [number, number]> = { searching: [3, 55], checking: [55, 75], scoring: [75, 88], saving: [88, 99] };
/** About how long the web search takes (it reads many pages); the bar moves through its span over this time */
export const SEARCH_EXPECTED_MS = 110_000;

/**
 * The bar's percentage: within the stage, by elapsed time for searching (it can't count) and by items done for the
 * others; never backwards past what was saved, never 100 until it's done.
 */
export function progressOf(s: { status: SearchStatus; stage: SearchStage | null; stageAt?: string | null; done?: number; total?: number; saved?: number | null }, now = Date.now()): number {
  if (s.status === "done") return 100;
  if (s.status === "queued" || !s.stage) return 2;
  const [a, b] = STAGE_SPAN[s.stage];
  let f = 0;
  if (s.stage === "searching") {
    const t = s.stageAt ? now - Date.parse(s.stageAt) : 0;
    // Eases toward the end of its span, so a long search never sits at the end looking stuck nor runs past it
    f = 1 - Math.exp(-Math.max(0, t) / (SEARCH_EXPECTED_MS / 2.2));
  } else if (s.total) f = Math.min(1, (s.done ?? 0) / s.total);
  const p = Math.round(a + (b - a) * Math.min(0.97, f));
  return Math.max(Math.min(p, 99), Math.min(s.saved ?? 0, 99));
}

/** "Prospect search done: 24 businesses found for 'med spas in Tampa'" */
export function doneTitle(found: number, profile: string): string {
  const p = profile.length > 60 ? `${profile.slice(0, 57)}…` : profile;
  return found ? `Prospect search done: ${found} ${found === 1 ? "business" : "businesses"} found for '${p}'` : `Prospect search done: nothing found for '${p}'`;
}

/** The Needs me item's title */
export const reviewTitle = (found: number, profile: string) => `Review the ${found} ${found === 1 ? "prospect" : "prospects"} found for '${profile.length > 50 ? `${profile.slice(0, 47)}…` : profile}'`;

/** Where a search's results open: the Sales page for an exec, else the item's own sheet on their Overview */
export const searchHref = (id: string, exec: boolean | null | undefined) => (exec ? `/sales?search=${id}` : `/pipeline?block=needs&item=${encodeURIComponent(`prospectsearch:${id}`)}`);

export type SearchResult = { id: string | null; name: string; website: string | null; location: string; industry: string; signals: string; fit_score: number | null; fit_reason: string; already: boolean };

/**
 * Whether the person has dealt with what a search found: they opened the results, or every prospect it added has moved
 * past "new" (researched, contacted… or archived)
 */
export function reviewed(s: { reviewed_at: string | null; results: readonly SearchResult[] }, stageOf: (id: string) => { status: string; archived: boolean } | null): boolean {
  if (s.reviewed_at) return true;
  const added = s.results.filter((r) => r.id && !r.already);
  if (!added.length) return false;
  return added.every((r) => {
    const p = stageOf(r.id!);
    return !p || p.archived || p.status !== "new";
  });
}
