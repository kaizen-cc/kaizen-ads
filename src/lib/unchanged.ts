// Skip-unchanged writes. On the small database every rewritten row is a new tuple, WAL and index writes, so the sync
// jobs compare what they are about to write with what is already stored and send only the rows that really differ.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** JSON with sorted keys, so two objects with the same content read the same whatever order jsonb returned them in */
export function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** One stored value and one about-to-be-written value, read the way Postgres hands them back */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    // timestamptz comes back as "…+00:00", we write "…Z"
    if (ISO.test(a) && ISO.test(b)) return Date.parse(a) === Date.parse(b);
    return false;
  }
  if ((typeof a === "number" && typeof b === "string") || (typeof a === "string" && typeof b === "number")) return Number(a) === Number(b);
  if (typeof a === "number" && typeof b === "number") return a === b;
  return stable(a) === stable(b);
}

/** Does the stored row already hold everything in `next`? Fields in `ignore` (timestamps that always move) don't count. */
export function sameRow(next: Record<string, unknown>, prev: Record<string, unknown> | undefined | null, ignore: readonly string[] = []): boolean {
  if (!prev) return false;
  for (const k of Object.keys(next)) {
    if (next[k] === undefined || ignore.includes(k)) continue;
    if (!sameValue(next[k], prev[k])) return false;
  }
  return true;
}

/** The rows that are new or differ from what is stored */
export function changedRows<T extends Record<string, unknown>>(rows: T[], stored: Map<string, Record<string, unknown>>, keyOf: (r: T) => string, ignore: readonly string[] = []): T[] {
  return rows.filter((r) => !sameRow(r, stored.get(keyOf(r)), ignore));
}

/** Every row of a query, a page at a time (PostgREST stops at 1000). `page` runs the query for one range. */
export async function readAllRows(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>, max = 100_000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data } = await page(from, from + 999);
    out.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
