// The makers' day (graphic designers and video editors): the pure rules, tested in tests/maker-day.test.ts. The owner,
// Nov 19 2026: a maker's Overview is a brief of what's on their plate and what's about to hit it, never metrics about
// clients (failing accounts, KPIs, social posting gaps, reports): that isn't theirs to carry. The server side is
// src/lib/maker-day.ts.

/** Graphic designers and video editors (not their leads, who run the line) */
export const isMaker = (role: string | null | undefined) => role === "graphic_designer" || role === "video_editor";

/** The pool a maker makes for: images and carousels, or video */
export const makerPool = (role: string | null | undefined): "images" | "videos" => (role === "video_editor" ? "videos" : "images");
export const inMakerPool = (role: string | null | undefined, format: string | null | undefined) => (makerPool(role) === "videos" ? format === "video" : format !== "video");

/**
 * The only items that ever reach a maker's recap, story, assistant or Overview, by the item's key: their own tickets
 * and tasks (mine), what's coming to their board (radar), and messages and promises that are theirs personally (owed,
 * said). Everything else (accounts, allotments, briefs, ads, onboarding, email, social, late work across the team) is
 * dropped on the server, whatever gathered it.
 */
const MAKER_KEYS = new Set(["mine", "radar", "owed", "owed2", "said", "said2"]);
export const makerItem = (key: string) => MAKER_KEYS.has(key.split(":")[0]);
export const forMaker = <T extends { key: string }>(items: readonly T[]): T[] => items.filter((i) => makerItem(i.key));

/** Next for me's kinds a maker sees: their own work only, never a KPI, an ad wearing out or an allotment */
const MAKER_NEXT = new Set(["ticket", "review", "task", "direction", "ask", "feedback", "bible"]);
export const makerNextItem = (kind: string) => MAKER_NEXT.has(kind);

/** The stages where a piece waits on its maker (the rest wait on review, copy, the client or a launch) */
export const MAKER_STAGES = new Set(["requested", "in_production", "client_revision"]);

export type PlateTask = { due: string | null; stage: string | null };
export type Urgency = "overdue" | "today" | "revision" | "week" | "later";

/** How urgent one of their pieces is today (YYYY-MM-DD, New York) */
export function urgencyOf(t: PlateTask, today: string): Urgency {
  const due = t.due?.slice(0, 10) ?? null;
  if (due && due < today) return "overdue";
  if (due && due === today) return "today";
  if (t.stage === "client_revision") return "revision";
  if (due && daysBetween(today, due) <= 6) return "week";
  return "later";
}

export const URGENCY_SCORE: Record<Urgency, number> = { overdue: 86, today: 74, revision: 78, week: 58, later: 44 };

/** Their task list: overdue first, then due soonest, nothing dated last */
export function byDue<T extends PlateTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const da = a.due?.slice(0, 10) ?? "9999-12-31";
    const db = b.due?.slice(0, 10) ?? "9999-12-31";
    return da.localeCompare(db) || Number(b.stage === "client_revision") - Number(a.stage === "client_revision");
  });
}

/** Rounds of changes on an Asana task, from its column moves: sent back to Client Revision, or back from review */
export function asanaRevisions(moves: readonly { from?: string | null; to?: string | null }[] | null | undefined) {
  return (moves ?? []).filter((m) => /client revision/i.test(m.to ?? "") || (/review/i.test(m.from ?? "") && /in progress|creative brief/i.test(m.to ?? ""))).length;
}

const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000);

/** "today", "tomorrow", "in 3 days", "Nov 28", "2 days ago" */
export function whenLabel(due: string | null, today: string): string {
  if (!due) return "No due date";
  const d = daysBetween(today, due.slice(0, 10));
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  if (d === -1) return "Was due yesterday";
  if (d < 0) return `Was due ${-d} days ago`;
  if (d <= 6) return `Due in ${d} days`;
  return `Due ${new Date(`${due.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}
