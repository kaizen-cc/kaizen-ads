// Sorting a board column (the Creative and Email boards share it). Kaizen tickets and Asana-mirrored cards are both read
// into the same fields; a missing value always sorts last (either direction) and ties keep their order.

export const SORT_KEYS = ["start", "due", "created_by", "created", "modified", "completed", "alpha", "priority"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const SORT_LABEL: Record<SortKey, string> = {
  start: "Start date",
  due: "Due date",
  created_by: "Created by",
  created: "Created on",
  modified: "Last modified on",
  completed: "Completed on",
  alpha: "Alphabetical",
  priority: "Priority",
};

/** What a card offers to sort on (null when it doesn't have it) */
export type SortFields = {
  start: string | null;
  due: string | null;
  createdBy: string | null;
  createdOn: string | null;
  modifiedOn: string | null;
  completedOn: string | null;
  title: string;
  priority: string | null;
};

// Newest first reads better for the moments; the rest start from the top
const DESC_FIRST: SortKey[] = ["created", "modified", "completed"];
export const defaultDir = (k: SortKey): SortDir => (DESC_FIRST.includes(k) ? "desc" : "asc");

export const parseSort = (v: string | null | undefined): SortKey | null => ((SORT_KEYS as readonly string[]).includes(v ?? "") ? (v as SortKey) : null);
export const parseDir = (v: string | null | undefined): SortDir | null => (v === "asc" || v === "desc" ? v : null);

// Urgent first when ascending
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2 };

function valueOf(f: SortFields, key: SortKey): string | number | null {
  switch (key) {
    case "start":
      return f.start;
    case "due":
      return f.due;
    case "created_by":
      return f.createdBy?.trim().toLowerCase() || null;
    case "created":
      return f.createdOn;
    case "modified":
      return f.modifiedOn;
    case "completed":
      return f.completedOn;
    case "alpha":
      return f.title.trim().toLowerCase() || null;
    case "priority":
      return f.priority == null ? null : (PRIORITY_RANK[f.priority] ?? 2);
  }
}

/** Compares two cards on a key; a missing value is last whichever way it runs, equal is 0 */
export function compareBy(a: SortFields, b: SortFields, key: SortKey, dir: SortDir): number {
  const x = valueOf(a, key);
  const y = valueOf(b, key);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true });
  return dir === "asc" ? c : -c;
}

/** A sorted copy; with no key the list stays as it is. Stable: equal cards keep their order. */
export function sortCards<T>(list: T[], key: SortKey | null, dir: SortDir, fields: (x: T) => SortFields): T[] {
  if (!key) return list;
  return list
    .map((x, i) => ({ x, i, f: fields(x) }))
    .sort((a, b) => compareBy(a.f, b.f, key, dir) || a.i - b.i)
    .map((r) => r.x);
}

// Reading each kind of card into the same fields
type AsanaCard = { title: string; dueOn: string | null; startOn: string | null; createdBy: string | null; createdAt: string | null; modifiedAt: string | null; priority: string };
/** An Asana-mirrored card (open tasks only, so never completed) */
export const asanaSortFields = (s: AsanaCard): SortFields => ({ start: s.startOn, due: s.dueOn, createdBy: s.createdBy, createdOn: s.createdAt, modifiedOn: s.modifiedAt, completedOn: null, title: s.title, priority: s.priority });

/** A Creative Board ticket: its due date is the stage's turnaround deadline; the last change is when it entered its stage */
export const creativeSortFields = (t: { title: string; stageDueAt: string | null; stageEnteredAt: string; createdAt: string; priority: string }): SortFields => ({ start: null, due: t.stageDueAt, createdBy: null, createdOn: t.createdAt, modifiedOn: t.stageEnteredAt, completedOn: null, title: t.title, priority: t.priority });

/** An Email Board ticket */
export const emailSortFields = (t: { title: string; dueOn: string | null; stageEnteredAt: string; createdAt: string; priority: string }): SortFields => ({ start: null, due: t.dueOn, createdBy: null, createdOn: t.createdAt, modifiedOn: t.stageEnteredAt, completedOn: null, title: t.title, priority: t.priority });
